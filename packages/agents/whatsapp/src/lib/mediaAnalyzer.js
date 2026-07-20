'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const pool = require('./db');
const llm = require('../../../shared/llm');

const DEFAULT_MODEL = process.env.WHATSAPP_MEDIA_MODEL || 'configured vision provider';
const MAX_IMAGE_BYTES = Math.max(1024, Number(process.env.WHATSAPP_IMAGE_ANALYSIS_MAX_BYTES || 15 * 1024 * 1024));
const MAX_PDF_BYTES = Math.max(1024, Number(process.env.WHATSAPP_PDF_ANALYSIS_MAX_BYTES || 200 * 1024 * 1024));
const PDF_CHUNK_CHARS = Math.max(4000, Math.min(Number(process.env.WHATSAPP_PDF_CHUNK_CHARS || process.env.WHATSAPP_PDF_TEXT_CHARS || 24000), 40000));
const PDF_SUMMARY_FAN_IN = Math.max(2, Math.min(Number(process.env.WHATSAPP_PDF_SUMMARY_FAN_IN || 6), 12));
const PDF_MIN_TEXT_CHARS = Math.max(40, Number(process.env.WHATSAPP_PDF_MIN_TEXT_CHARS || 120));
const PDF_MIN_TEXT_PER_PAGE = Math.max(10, Number(process.env.WHATSAPP_PDF_MIN_TEXT_PER_PAGE || 40));
const PDF_VISION_PAGE_BATCH = Math.max(1, Math.min(Number(process.env.WHATSAPP_PDF_VISION_PAGE_BATCH || 4), 8));
const PDF_VISION_MAX_PAGES = Math.max(1, Number(process.env.WHATSAPP_PDF_VISION_MAX_PAGES || 200));
const PDF_VISION_WIDTH = Math.max(800, Math.min(Number(process.env.WHATSAPP_PDF_VISION_WIDTH || 1400), 2400));
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.WHATSAPP_MEDIA_ANALYSIS_BATCH || 20), 50));
const INTERVAL_MS = Math.max(10000, Number(process.env.WHATSAPP_MEDIA_ANALYSIS_INTERVAL_MS || 10000));
const MAX_ANALYSIS_ATTEMPTS = Math.max(1, Number(process.env.WHATSAPP_MEDIA_ANALYSIS_ATTEMPTS || 3));
const LEASE_SECONDS = Math.max(60, Number(process.env.WHATSAPP_MEDIA_ANALYSIS_LEASE_SECONDS || 1800));
const LEASE_HEARTBEAT_MS = Math.max(10000, Math.min(60000, Math.floor(LEASE_SECONDS * 1000 / 3)));
const LEASE_OWNER = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

const state = {
  running: false,
  stopping: false,
  startedAt: null,
  finishedAt: null,
  processed: 0,
  succeeded: 0,
  skipped: 0,
  failed: 0,
  lastError: null,
  paused: false,
  pausedReason: null,
  timer: null,
  startTimer: null,
  activeRun: null,
};

class LeaseLostError extends Error {
  constructor(id) {
    super(`media analysis lease lost for row ${id}`);
    this.name = 'LeaseLostError';
  }
}

function isQuotaError(err) {
  const message = String(err.message || err).toLowerCase();
  return message.includes('429') || message.includes('spending cap') || message.includes('quota') || message.includes('credit');
}

function mediaKind(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0];
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

function terminalMediaSkipReason(err, kind = null) {
  const message = String(err?.message || err || '');
  if (err?.code === 'ENOENT' || /enoent: no such file or directory/i.test(message)) {
    return 'source media file is unavailable; a future connector redownload may retry it';
  }
  if (kind === 'pdf' && /(no password given|password.*required|encrypted.*pdf)/i.test(message)) {
    return 'encrypted PDF requires a source password';
  }
  return null;
}

function hashMediaBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function backfillContentHashes(db = pool, options = {}) {
  const fileSystem = options.fs || fs;
  const batchSize = Math.max(1, Math.min(Number(options.batchSize || 500), 2000));
  let hashed = 0;
  let missing = 0;
  while (!state.stopping) {
    const { rows } = await db.query(
      `SELECT id, file_path
       FROM public.media_files
       WHERE content_sha256 IS NULL
         AND (mime_type = 'application/pdf' OR mime_type LIKE 'image/%')
         AND NOT (analysis_status = 'failed' AND analysis_error LIKE 'unable to hash media:%')
       ORDER BY id
       LIMIT $1`,
      [batchSize]
    );
    if (!rows.length) break;
    for (const row of rows) {
      try {
        const buffer = await fileSystem.promises.readFile(row.file_path);
        await db.query(
          `UPDATE public.media_files SET content_sha256 = $2
           WHERE id = $1 AND content_sha256 IS NULL`,
          [row.id, hashMediaBuffer(buffer)]
        );
        hashed++;
      } catch (err) {
        const skipReason = terminalMediaSkipReason(err);
        await db.query(
          `UPDATE public.media_files
           SET analysis_status = $4, analysis_attempts = $3,
               analysis_error = $2, analyzed_at = NOW()
           WHERE id = $1 AND semantic_text IS NULL`,
          [
            row.id,
            skipReason || `unable to hash media: ${String(err.message || err).slice(0, 900)}`,
            MAX_ANALYSIS_ATTEMPTS,
            skipReason ? 'skipped' : 'failed',
          ]
        ).catch(() => {});
        missing++;
      }
    }
  }
  return { hashed, missing };
}

async function reuseCompletedAnalysis(db = pool) {
  const result = await db.query(
    `WITH reusable AS (
       SELECT target.id, source.extracted_text, source.semantic_text,
              source.analysis_kind, source.analysis_provider, source.analysis_model
       FROM public.media_files target
       JOIN LATERAL (
         SELECT completed.extracted_text, completed.semantic_text,
                completed.analysis_kind, completed.analysis_provider, completed.analysis_model
         FROM public.media_files completed
         WHERE completed.content_sha256 = target.content_sha256
           AND completed.mime_type IS NOT DISTINCT FROM target.mime_type
           AND completed.analysis_status = 'completed'
           AND completed.semantic_text IS NOT NULL
         ORDER BY completed.analyzed_at DESC NULLS LAST, completed.id
         LIMIT 1
       ) source ON TRUE
       WHERE target.semantic_text IS NULL
         AND target.content_sha256 IS NOT NULL
         AND COALESCE(target.analysis_status, 'pending') IN ('pending', 'failed')
     )
     UPDATE public.media_files target
     SET extracted_text = reusable.extracted_text,
         semantic_text = reusable.semantic_text,
         analysis_kind = reusable.analysis_kind,
         analysis_status = 'completed',
         analysis_provider = reusable.analysis_provider,
         analysis_model = reusable.analysis_model,
         analysis_error = NULL, analyzed_at = NOW(),
         analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
     FROM reusable
     WHERE target.id = reusable.id`,
  );
  return result.rowCount || 0;
}

function chunkPdfText(value, maxChars = PDF_CHUNK_CHARS) {
  const text = String(value || '').replace(/\0/g, '');
  const size = Math.max(1000, Number(maxChars) || PDF_CHUNK_CHARS);
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + size, text.length);
    if (end < text.length) {
      const searchFrom = cursor + Math.floor(size * 0.7);
      const newline = text.lastIndexOf('\n', end);
      const space = text.lastIndexOf(' ', end);
      const boundary = Math.max(newline, space);
      if (boundary >= searchFrom) end = boundary + 1;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks.filter(chunk => chunk.trim());
}

function isPdfTextSparse(text, totalPages = 1) {
  const useful = String(text || '').replace(/\s+/g, '').length;
  return useful < Math.max(PDF_MIN_TEXT_CHARS, Math.max(1, Number(totalPages) || 1) * PDF_MIN_TEXT_PER_PAGE);
}

async function generateWithVisionFallback({
  kind,
  mimeType,
  buffer,
  images = [],
  prompt,
  taskType,
  maxTokens = 1200,
  llmClient = llm,
}) {
  const content = [{ type: 'text', text: prompt }];
  const imageInputs = images.length
    ? images
    : (kind === 'image' && buffer ? [{ mimeType, buffer }] : []);
  for (const image of imageInputs) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType || 'image/png',
        data: Buffer.from(image.buffer).toString('base64'),
      },
    });
  }
  const response = await llmClient.create('whatsapp', {
    profile: 'bulk_structured',
    max_tokens: maxTokens,
    required_capability: imageInputs.length ? 'vision' : null,
    task_type: taskType || (kind === 'image' ? 'media_image_description' : 'media_pdf_summary'),
    workflow_name: 'whatsapp_media_analysis',
    messages: [{ role: 'user', content }],
  });
  const text = String(response.text || '').trim();
  if (!text) throw new Error('configured media model returned empty text');
  return {
    text,
    provider: response.provider || 'configured',
    model: response.model || response.provider || 'configured',
  };
}

async function extractPdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return String(result.text || '').replace(/\0/g, '').trim();
  } finally {
    await parser.destroy();
  }
}

async function extractPdfDocument(buffer, options = {}) {
  const parser = options.parserFactory
    ? options.parserFactory(buffer)
    : new (require('pdf-parse').PDFParse)({ data: buffer });
  const generate = options.generate || generateWithVisionFallback;
  try {
    const result = await parser.getText({ pageJoiner: '\n-- page_number of total_number --\n' });
    const embeddedText = String(result.text || '').replace(/\0/g, '').trim();
    const totalPages = Math.max(1, Number(result.total || result.pages?.length || 1));
    if (!isPdfTextSparse(embeddedText, totalPages)) {
      return { text: embeddedText, totalPages, usedVision: false };
    }
    if (totalPages > PDF_VISION_MAX_PAGES) {
      throw new Error(`scanned PDF has ${totalPages} pages, above ${PDF_VISION_MAX_PAGES} page vision safety limit`);
    }

    const ocrChunks = [];
    let provider = null;
    let model = null;
    for (let firstPage = 1; firstPage <= totalPages; firstPage += PDF_VISION_PAGE_BATCH) {
      const pageNumbers = Array.from(
        { length: Math.min(PDF_VISION_PAGE_BATCH, totalPages - firstPage + 1) },
        (_, index) => firstPage + index
      );
      const screenshots = await parser.getScreenshot({
        partial: pageNumbers,
        desiredWidth: PDF_VISION_WIDTH,
        imageDataUrl: false,
        imageBuffer: true,
      });
      const screenshotsByPage = new Map(screenshots.pages.map(page => [Number(page.pageNumber), page]));
      const missingPages = pageNumbers.filter(pageNumber => !screenshotsByPage.has(pageNumber));
      if (missingPages.length) throw new Error(`PDF renderer omitted page(s): ${missingPages.join(', ')}`);
      const pageLabel = pageNumbers.length === 1 ? `page ${pageNumbers[0]}` : `pages ${pageNumbers[0]}-${pageNumbers.at(-1)}`;
      const ocr = await generate({
        kind: 'pdf_vision',
        images: pageNumbers.map(pageNumber => ({ mimeType: 'image/png', buffer: screenshotsByPage.get(pageNumber).data })),
        prompt: `Transcribe and describe WhatsApp PDF ${pageLabel} in page order. Preserve every readable name, organization, date, amount, table value, decision, action item, and claim. Describe charts or diagrams faithfully. Do not infer missing text or identities. Return concise plain text with page markers.`,
        taskType: 'media_pdf_ocr',
        maxTokens: 1800,
      });
      provider = ocr.provider;
      model = ocr.model;
      ocrChunks.push(`[${pageLabel}]\n${ocr.text}`);
    }
    const ocrText = ocrChunks.join('\n\n').trim();
    if (!ocrText) throw new Error('scanned PDF vision extraction returned empty text');
    return {
      text: [embeddedText, ocrText].filter(Boolean).join('\n\n'),
      totalPages,
      usedVision: true,
      ocrProvider: provider,
      ocrModel: model,
    };
  } finally {
    await parser.destroy();
  }
}

async function summarizePdfText(extractedText, options = {}) {
  const generate = options.generate || generateWithVisionFallback;
  const chunks = chunkPdfText(extractedText, options.chunkChars || PDF_CHUNK_CHARS);
  if (!chunks.length) throw new Error('PDF contains no extractable text');

  const summaries = [];
  let lastProvider = null;
  let lastModel = null;
  for (let index = 0; index < chunks.length; index++) {
    const result = await generate({
      kind: 'pdf',
      prompt: `Extract a faithful semantic summary of WhatsApp PDF chunk ${index + 1} of ${chunks.length}. Preserve all names, organizations, dates, amounts, decisions, action items, key claims, and contradictions. Do not add facts.\n\n${chunks[index]}`,
      taskType: 'media_pdf_chunk_summary',
      maxTokens: 1200,
    });
    summaries.push(result.text);
    lastProvider = result.provider;
    lastModel = result.model;
  }

  let level = summaries;
  let round = 1;
  while (level.length > 1) {
    const next = [];
    for (let offset = 0; offset < level.length; offset += PDF_SUMMARY_FAN_IN) {
      const group = level.slice(offset, offset + PDF_SUMMARY_FAN_IN);
      const result = await generate({
        kind: 'pdf',
        prompt: `Synthesize these ordered partial summaries from the same WhatsApp PDF (reduction round ${round}). Retain distinct facts, names, organizations, dates, amounts, decisions, unresolved questions, risks, and action items. Remove repetition only; do not add facts.\n\n${group.map((summary, index) => `[Part ${offset + index + 1}]\n${summary}`).join('\n\n')}`,
        taskType: 'media_pdf_summary_reduce',
        maxTokens: 1400,
      });
      next.push(result.text);
      lastProvider = result.provider;
      lastModel = result.model;
    }
    level = next;
    round++;
  }
  return { text: level[0], provider: lastProvider, model: lastModel, chunkCount: chunks.length };
}

async function generateSemanticText({ kind, mimeType, buffer, extractedText, generate = generateWithVisionFallback }) {
  if (kind === 'pdf') return summarizePdfText(extractedText, { generate });
  return generate({
    kind,
    mimeType,
    buffer,
    prompt: 'Describe this WhatsApp image for semantic retrieval. Include visible objects, setting, charts or documents, and accurately transcribe useful visible text. Do not guess identities or hidden context. Use concise plain text.',
  });
}

async function claimPendingMedia(db = pool, limit = BATCH_SIZE, owner = LEASE_OWNER) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || BATCH_SIZE, 50));
  const { rows } = await db.query(
    `WITH candidates AS (
       SELECT id
       FROM public.media_files
       WHERE (mime_type = 'application/pdf' OR mime_type LIKE 'image/%')
         AND (
           (COALESCE(analysis_status, 'pending') IN ('pending', 'failed') AND analysis_attempts < $4)
           OR (analysis_status = 'processing' AND (analysis_lease_expires_at IS NULL OR analysis_lease_expires_at < NOW()))
         )
         AND (analysis_lease_owner IS NULL OR analysis_lease_expires_at IS NULL OR analysis_lease_expires_at < NOW())
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE public.media_files media
     SET analysis_status = 'processing',
         analysis_attempts = CASE WHEN media.analysis_status = 'processing'
                                  THEN media.analysis_attempts ELSE media.analysis_attempts + 1 END,
         analysis_error = NULL, analysis_lease_owner = $2,
         analysis_lease_expires_at = NOW() + $3::interval
     FROM candidates
     WHERE media.id = candidates.id
     RETURNING media.id, media.wa_msg_id, media.file_path, media.mime_type, media.file_size`,
    [safeLimit, owner, `${LEASE_SECONDS} seconds`, MAX_ANALYSIS_ATTEMPTS]
  );
  return rows;
}

async function renewLease(db, id, owner = LEASE_OWNER) {
  const result = await db.query(
    `UPDATE public.media_files
     SET analysis_lease_expires_at = NOW() + $3::interval
     WHERE id = $1 AND analysis_status = 'processing' AND analysis_lease_owner = $2`,
    [id, owner, `${LEASE_SECONDS} seconds`]
  );
  return result.rowCount === 1;
}

function startLeaseHeartbeat(db, id, owner) {
  const timer = setInterval(() => {
    renewLease(db, id, owner).catch(err => console.warn(`[media-analysis] lease heartbeat failed for ${id}: ${err.message}`));
  }, LEASE_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function analyzeRow(row, options = {}) {
  const db = options.db || pool;
  const owner = options.owner || LEASE_OWNER;
  const fileSystem = options.fs || fs;
  const generate = options.generate || generateWithVisionFallback;
  const kind = mediaKind(row.mime_type);
  if (!kind) return { status: 'skipped', reason: 'unsupported media type' };
  const stopHeartbeat = startLeaseHeartbeat(db, row.id, owner);

  try {
    const stat = await fileSystem.promises.stat(row.file_path);
    const maxBytes = kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (stat.size > maxBytes) throw new Error(`media exceeds ${maxBytes} byte analysis limit`);
    const buffer = await fileSystem.promises.readFile(row.file_path);
    const contentSha256 = hashMediaBuffer(buffer);
    await db.query(
      `UPDATE public.media_files SET content_sha256 = $3
       WHERE id = $1 AND analysis_status = 'processing' AND analysis_lease_owner = $2`,
      [row.id, owner, contentSha256]
    );
    const document = kind === 'pdf'
      ? await extractPdfDocument(buffer, { generate, parserFactory: options.parserFactory })
      : null;
    const extractedText = document?.text || null;
    const analysis = await generateSemanticText({ kind, mimeType: row.mime_type, buffer, extractedText, generate });

    const result = await db.query(
      `UPDATE public.media_files
       SET extracted_text = $2, semantic_text = $3, analysis_kind = $4,
           analysis_status = 'completed', analysis_provider = $5, analysis_model = $6,
           analysis_error = NULL, analyzed_at = NOW(),
           analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
       WHERE id = $1 AND analysis_status = 'processing' AND analysis_lease_owner = $7`,
      [row.id, extractedText, analysis.text, document?.usedVision ? 'pdf_ocr' : kind, analysis.provider, analysis.model, owner]
    );
    if (result.rowCount !== 1) throw new LeaseLostError(row.id);
    await reuseCompletedAnalysis(db);
    return { status: 'completed', analysisKind: document?.usedVision ? 'pdf_ocr' : kind };
  } catch (err) {
    const skipReason = terminalMediaSkipReason(err, kind);
    await db.query(
      `UPDATE public.media_files
       SET analysis_status = $4, analysis_error = $2, analyzed_at = NOW(),
           analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
       WHERE id = $1 AND analysis_status = 'processing' AND analysis_lease_owner = $3`,
      [row.id, skipReason || String(err.message || err).slice(0, 1000), owner, skipReason ? 'skipped' : 'failed']
    ).catch(() => {});
    if (skipReason) return { status: 'skipped', reason: skipReason };
    throw err;
  } finally {
    stopHeartbeat();
  }
}

async function runPendingMedia(limit, options = {}) {
  const db = options.db || pool;
  const owner = options.owner || LEASE_OWNER;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.processed = 0;
  state.succeeded = 0;
  state.skipped = 0;
  state.failed = 0;
  state.lastError = null;

  try {
    if (!options.generate && !(await llm.hasEligibleProvider('bulk_structured', 'vision'))) {
      state.paused = true;
      state.pausedReason = 'no eligible bulk_structured vision provider; queued media was not claimed';
      state.lastError = state.pausedReason;
      return getMediaAnalysisStatus();
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || BATCH_SIZE, 50));
    for (let index = 0; index < safeLimit && !state.stopping; index++) {
      const [row] = await claimPendingMedia(db, 1, owner);
      if (!row) break;
      try {
        const result = await analyzeRow(row, { ...options, db, owner });
        if (result.status === 'skipped') state.skipped++;
        else state.succeeded++;
      } catch (err) {
        state.failed++;
        state.lastError = err.message;
        console.warn(`[media-analysis] ${row.wa_msg_id}: ${err.message}`);
        if (isQuotaError(err)) {
          state.paused = true;
          state.pausedReason = err.message;
          console.warn('[media-analysis] paused because all configured providers are quota-limited');
          break;
        }
      } finally {
        state.processed++;
      }
    }
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
  return getMediaAnalysisStatus();
}

function processPendingMedia(limit = BATCH_SIZE, options = {}) {
  if (state.activeRun) return state.activeRun;
  if (state.paused || state.stopping) return Promise.resolve(getMediaAnalysisStatus());
  const active = runPendingMedia(limit, options);
  const wrapped = active.finally(() => {
    if (state.activeRun === wrapped) state.activeRun = null;
  });
  state.activeRun = wrapped;
  return wrapped;
}

function getMediaAnalysisStatus() {
  return {
    running: state.running,
    draining: state.stopping && Boolean(state.activeRun),
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    processed: state.processed,
    succeeded: state.succeeded,
    skipped: state.skipped,
    failed: state.failed,
    lastError: state.lastError,
    paused: state.paused,
    pausedReason: state.pausedReason,
    model: DEFAULT_MODEL,
  };
}

function resumeMediaAnalysis() {
  if (state.stopping) return;
  state.paused = false;
  state.pausedReason = null;
  state.lastError = null;
}

async function getMediaAnalysisCounts() {
  const { rows } = await pool.query(
    `SELECT COALESCE(analysis_status, 'pending') AS status, COUNT(*)::int AS count
     FROM public.media_files GROUP BY COALESCE(analysis_status, 'pending') ORDER BY status`
  );
  return rows;
}

function startMediaAnalysisWorker() {
  if (process.env.WHATSAPP_MEDIA_ANALYSIS_ENABLED === '0' || state.timer || state.startTimer) return;
  state.stopping = false;
  pool.query(
    `UPDATE public.media_files
     SET analysis_status = 'pending', analysis_attempts = 0, analysis_error = NULL,
         analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
     WHERE semantic_text IS NULL
       AND analysis_error ~* '(spending cap|quota|credit|no vision-capable fallback|no providers configured)'`
  ).catch(() => {});
  pool.query(
    `UPDATE public.media_files
     SET analysis_status = 'skipped', analysis_error = 'unsupported media type', analyzed_at = NOW(),
         analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
     WHERE COALESCE(analysis_status, 'pending') IN ('pending', 'failed')
       AND mime_type IS DISTINCT FROM 'application/pdf'
       AND mime_type NOT LIKE 'image/%'`
  ).catch(() => {});
  pool.query(
    `UPDATE public.media_files
     SET analysis_status = 'pending', analysis_attempts = 0, analysis_error = NULL,
         analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
     WHERE semantic_text IS NULL
       AND mime_type = 'application/pdf'
       AND analysis_error LIKE 'media exceeds % byte analysis limit'`
  ).catch(() => {});
  const run = () => processPendingMedia().catch(err => {
    state.lastError = err.message;
    console.warn('[media-analysis] worker error:', err.message);
  });
  state.startTimer = setTimeout(async () => {
    state.startTimer = null;
    try {
      const hashResult = await backfillContentHashes();
      const reused = await reuseCompletedAnalysis();
      if (hashResult.hashed || hashResult.missing || reused) {
        console.log(`[media-analysis] content recovery hashed=${hashResult.hashed} missing=${hashResult.missing} reused=${reused}`);
      }
    } catch (err) {
      state.lastError = err.message;
      console.warn('[media-analysis] content recovery failed:', err.message);
    }
    run();
  }, 5000);
  state.startTimer.unref();
  state.timer = setInterval(run, INTERVAL_MS);
  state.timer.unref();
  console.log(`[media-analysis] worker started (batch=${BATCH_SIZE}, interval=${INTERVAL_MS}ms, model=${DEFAULT_MODEL})`);
}

async function releaseOwnedLeases(db = pool, owner = LEASE_OWNER) {
  await db.query(
    `UPDATE public.media_files
     SET analysis_status = 'pending', analysis_lease_owner = NULL, analysis_lease_expires_at = NULL
     WHERE analysis_status = 'processing' AND analysis_lease_owner = $1`,
    [owner]
  );
}

async function stopMediaAnalysisWorker(options = {}) {
  state.stopping = true;
  if (state.startTimer) clearTimeout(state.startTimer);
  if (state.timer) clearInterval(state.timer);
  state.startTimer = null;
  state.timer = null;
  const active = state.activeRun;
  if (active) await active;
  await releaseOwnedLeases(options.db || pool, options.owner || LEASE_OWNER);
}

module.exports = {
  LeaseLostError,
  mediaKind,
  hashMediaBuffer,
  terminalMediaSkipReason,
  backfillContentHashes,
  reuseCompletedAnalysis,
  chunkPdfText,
  isPdfTextSparse,
  extractPdfText,
  extractPdfDocument,
  summarizePdfText,
  generateSemanticText,
  generateWithVisionFallback,
  claimPendingMedia,
  renewLease,
  analyzeRow,
  processPendingMedia,
  getMediaAnalysisStatus,
  getMediaAnalysisCounts,
  resumeMediaAnalysis,
  startMediaAnalysisWorker,
  stopMediaAnalysisWorker,
  releaseOwnedLeases,
};
