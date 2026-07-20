'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chunkPdfText,
  hashMediaBuffer,
  terminalMediaSkipReason,
  isPdfTextSparse,
  extractPdfDocument,
  summarizePdfText,
  generateWithVisionFallback,
  claimPendingMedia,
  reuseCompletedAnalysis,
  analyzeRow,
  processPendingMedia,
  resumeMediaAnalysis,
  stopMediaAnalysisWorker,
} = require('../lib/mediaAnalyzer');

test('media semantics use the bulk Luna routing profile', async () => {
  let request;
  const result = await generateWithVisionFallback({
    kind: 'pdf',
    prompt: 'Summarize faithfully',
    llmClient: {
      async create(agentId, options) {
        request = { agentId, options };
        return { text: 'summary', provider: 'test', model: 'test' };
      },
    },
  });
  assert.equal(result.text, 'summary');
  assert.equal(request.agentId, 'whatsapp');
  assert.equal(request.options.profile, 'bulk_structured');
});

test('media worker does not claim queued files while the remote vision profile is unavailable', async () => {
  const llm = require('../../../shared/llm');
  const original = llm.hasEligibleProvider;
  llm.hasEligibleProvider = async () => false;
  let claimed = false;
  const db = {
    async query() {
      claimed = true;
      return { rows: [] };
    },
  };
  try {
    const status = await processPendingMedia(1, { db });
    assert.equal(claimed, false);
    assert.equal(status.paused, true);
    assert.match(status.pausedReason, /was not claimed/);
  } finally {
    llm.hasEligibleProvider = original;
    resumeMediaAnalysis();
  }
});

test('terminal media errors become explicit skipped states instead of permanent failures', () => {
  assert.equal(
    terminalMediaSkipReason(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    'source media file is unavailable; a future connector redownload may retry it'
  );
  assert.equal(
    terminalMediaSkipReason(new Error('No password given'), 'pdf'),
    'encrypted PDF requires a source password'
  );
  assert.equal(terminalMediaSkipReason(new Error('temporary provider failure'), 'pdf'), null);
});

test('media content hashes are stable and reusable across duplicate messages', () => {
  assert.equal(
    hashMediaBuffer(Buffer.from('same attachment')),
    hashMediaBuffer(Buffer.from('same attachment'))
  );
  assert.notEqual(
    hashMediaBuffer(Buffer.from('same attachment')),
    hashMediaBuffer(Buffer.from('different attachment'))
  );
});

test('completed semantic analysis is copied only to identical pending media', async () => {
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      return { rowCount: 3, rows: [] };
    },
  };
  assert.equal(await reuseCompletedAnalysis(db), 3);
  assert.match(calls[0], /completed\.content_sha256 = target\.content_sha256/);
  assert.match(calls[0], /completed\.mime_type IS NOT DISTINCT FROM target\.mime_type/);
  assert.match(calls[0], /analysis_status = 'completed'/);
});

test('PDF text chunking covers the complete document without truncation', () => {
  const document = `${'alpha '.repeat(300)}MIDDLE\n${'omega '.repeat(300)}`;
  const chunks = chunkPdfText(document, 1000);
  assert.ok(chunks.length > 2);
  assert.equal(chunks.join(''), document);
  assert.match(chunks[0], /alpha/);
  assert.match(chunks.at(-1), /omega/);
});

test('PDF summary processes every chunk and performs hierarchical reduction', async () => {
  const calls = [];
  const generate = async input => {
    calls.push(input);
    return { text: `summary-${calls.length}`, provider: 'test', model: 'test-model' };
  };
  const document = `${'first '.repeat(260)}UNIQUE-MIDDLE ${'last '.repeat(260)}`;
  const result = await summarizePdfText(document, { generate, chunkChars: 1000 });
  const chunkCalls = calls.filter(call => call.taskType === 'media_pdf_chunk_summary');
  const reductionCalls = calls.filter(call => call.taskType === 'media_pdf_summary_reduce');

  assert.equal(chunkCalls.length, chunkPdfText(document, 1000).length);
  assert.ok(reductionCalls.length >= 1);
  assert.match(chunkCalls.map(call => call.prompt).join('\n'), /UNIQUE-MIDDLE/);
  assert.equal(result.provider, 'test');
  assert.equal(result.chunkCount, chunkCalls.length);
});

test('sparse scanned PDFs render and analyze every page in bounded vision batches', async () => {
  const screenshotBatches = [];
  let destroyed = false;
  const parser = {
    async getText() { return { text: ' ', total: 5, pages: [] }; },
    async getScreenshot(options) {
      screenshotBatches.push(options.partial);
      return {
        pages: options.partial.map(pageNumber => ({ pageNumber, data: Buffer.from(`page-${pageNumber}`) })),
      };
    },
    async destroy() { destroyed = true; },
  };
  const visionCalls = [];
  const result = await extractPdfDocument(Buffer.from('fake-pdf'), {
    parserFactory: () => parser,
    generate: async input => {
      visionCalls.push(input);
      return { text: `OCR ${input.prompt}`, provider: 'vision', model: 'vision-model' };
    },
  });

  assert.equal(result.usedVision, true);
  assert.deepEqual(screenshotBatches.flat(), [1, 2, 3, 4, 5]);
  assert.equal(visionCalls.length, 2);
  assert.ok(visionCalls.every(call => call.images.length >= 1 && call.taskType === 'media_pdf_ocr'));
  assert.match(result.text, /pages 1-4/);
  assert.match(result.text, /page 5/);
  assert.equal(destroyed, true);
});

test('text PDFs avoid vision when extracted text is substantive', async () => {
  let screenshotCalled = false;
  let destroyed = false;
  const parser = {
    async getText() { return { text: 'A substantive contract with dates, amounts, parties, and obligations. '.repeat(20), total: 2 }; },
    async getScreenshot() { screenshotCalled = true; return { pages: [] }; },
    async destroy() { destroyed = true; },
  };
  const result = await extractPdfDocument(Buffer.from('fake-pdf'), { parserFactory: () => parser });
  assert.equal(result.usedVision, false);
  assert.equal(screenshotCalled, false);
  assert.equal(destroyed, true);
  assert.equal(isPdfTextSparse(result.text, result.totalPages), false);
});

test('media claim is one atomic cross-process lease operation', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 9, wa_msg_id: 'wa-9' }] };
    },
  };
  const rows = await claimPendingMedia(db, 7, 'worker:test');
  assert.equal(rows[0].id, 9);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0].sql, /analysis_lease_expires_at < NOW\(\)/);
  assert.match(calls[0].sql, /UPDATE public\.media_files media/);
  assert.equal(calls[0].params[0], 7);
  assert.equal(calls[0].params[1], 'worker:test');
});

test('analysis completion is conditional on lease ownership and clears the lease', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  const fileSystem = {
    promises: {
      async stat() { return { size: 10 }; },
      async readFile() { return Buffer.from('image'); },
    },
  };
  const result = await analyzeRow(
    { id: 11, file_path: '/fake/image.png', mime_type: 'image/png' },
    {
      db,
      fs: fileSystem,
      owner: 'worker:test',
      generate: async () => ({ text: 'A useful image description', provider: 'test', model: 'vision' }),
    }
  );
  const completion = calls.find(call => /analysis_status = 'completed'/.test(call.sql));
  assert.equal(result.status, 'completed');
  assert.ok(completion);
  assert.match(completion.sql, /analysis_lease_owner = \$7/);
  assert.match(completion.sql, /analysis_lease_owner = NULL, analysis_lease_expires_at = NULL/);
  assert.equal(completion.params[6], 'worker:test');
});

test('worker shutdown drains the active analysis before releasing owned leases', async () => {
  let claimed = false;
  let allowGeneration;
  let generationStarted;
  const generationGate = new Promise(resolve => { allowGeneration = resolve; });
  const started = new Promise(resolve => { generationStarted = resolve; });
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      if (/WITH candidates AS/.test(sql)) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: 12, wa_msg_id: 'wa-12', file_path: '/fake/12.png', mime_type: 'image/png' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const fileSystem = {
    promises: {
      async stat() { return { size: 10 }; },
      async readFile() { return Buffer.from('image'); },
    },
  };
  const active = processPendingMedia(1, {
    db,
    fs: fileSystem,
    owner: 'worker:drain',
    generate: async () => {
      generationStarted();
      await generationGate;
      return { text: 'drained image', provider: 'test', model: 'vision' };
    },
  });
  await started;

  let stopped = false;
  const stopping = stopMediaAnalysisWorker({ db, owner: 'worker:drain' }).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  allowGeneration();
  await Promise.all([active, stopping]);

  const completedAt = calls.findIndex(sql => /analysis_status = 'completed'/.test(sql));
  const releasedAt = calls.findIndex(sql => /SET analysis_status = 'pending', analysis_lease_owner = NULL/.test(sql));
  assert.ok(completedAt >= 0);
  assert.ok(releasedAt > completedAt);
});
