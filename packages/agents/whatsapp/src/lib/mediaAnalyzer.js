'use strict';

const fs = require('fs');
const pool = require('./db');

const DEFAULT_MODEL = process.env.WHATSAPP_MEDIA_MODEL || 'gemini-3.1-flash-lite';
const MAX_IMAGE_BYTES = Math.max(1024, Number(process.env.WHATSAPP_IMAGE_ANALYSIS_MAX_BYTES || 15 * 1024 * 1024));
const MAX_PDF_BYTES = Math.max(1024, Number(process.env.WHATSAPP_PDF_ANALYSIS_MAX_BYTES || 200 * 1024 * 1024));
const MAX_PDF_TEXT_CHARS = Math.max(1000, Number(process.env.WHATSAPP_PDF_TEXT_CHARS || 120000));
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.WHATSAPP_MEDIA_ANALYSIS_BATCH || 5), 50));
const INTERVAL_MS = Math.max(10000, Number(process.env.WHATSAPP_MEDIA_ANALYSIS_INTERVAL_MS || 60000));

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  processed: 0,
  succeeded: 0,
  failed: 0,
  lastError: null,
  paused: false,
  pausedReason: null,
  timer: null,
};

function isQuotaError(err) {
  const message = String(err.message || err).toLowerCase();
  return message.includes('429') || message.includes('spending cap') || message.includes('quota') || message.includes('credit');
}

async function generateWithVisionFallback({ kind, mimeType, buffer, prompt }) {
  const errors = [];
  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = require('openai');
      const client = new OpenAI.default({ apiKey: process.env.OPENAI_API_KEY });
      const content = [{ type: 'text', text: prompt }];
      if (kind === 'image') {
        content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } });
      }
      const response = await client.chat.completions.create({
        model: process.env.WHATSAPP_MEDIA_OPENAI_MODEL || 'gpt-4o-mini',
        max_tokens: 1200,
        messages: [{ role: 'user', content }],
      });
      const text = response.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('OpenAI returned empty media text');
      return { text, provider: 'openai', model: response.model || process.env.WHATSAPP_MEDIA_OPENAI_MODEL || 'gpt-4o-mini' };
    } catch (err) {
      errors.push(`OpenAI: ${err.message}`);
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
      const content = [{ type: 'text', text: prompt }];
      if (kind === 'image') {
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } });
      }
      const response = await client.messages.create({
        model: process.env.WHATSAPP_MEDIA_ANTHROPIC_MODEL || process.env.AI_ANTHROPIC_MODEL || 'claude-sonnet-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content }],
      });
      const text = response.content?.find(block => block.type === 'text')?.text?.trim();
      if (!text) throw new Error('Anthropic returned empty media text');
      return { text, provider: 'anthropic', model: response.model };
    } catch (err) {
      errors.push(`Anthropic: ${err.message}`);
    }
  }

  throw new Error(`no vision-capable fallback succeeded: ${errors.join('; ') || 'no API credentials'}`);
}

function mediaKind(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0];
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return null;
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

async function generateSemanticText({ kind, mimeType, buffer, extractedText }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL });

  let parts;
  if (kind === 'pdf') {
    const text = extractedText.slice(0, MAX_PDF_TEXT_CHARS);
    if (!text) throw new Error('PDF contains no extractable text');
    parts = [`Summarize this WhatsApp PDF for semantic retrieval. Preserve names, organizations, dates, amounts, decisions, action items, and key claims. Use concise plain text and do not add facts.\n\n${text}`];
  } else {
    parts = [
      'Describe this WhatsApp image for semantic retrieval. Include visible objects, setting, charts or documents, and accurately transcribe useful visible text. Do not guess identities or hidden context. Use concise plain text.',
      { inlineData: { data: buffer.toString('base64'), mimeType } },
    ];
  }

  try {
    const result = await model.generateContent(parts);
    const text = result.response.text().trim();
    if (!text) throw new Error('media analysis returned empty text');
    return { text, provider: 'gemini', model: DEFAULT_MODEL };
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    console.warn('[media-analysis] Gemini quota unavailable; trying configured AI fallback');
    return generateWithVisionFallback({ kind, mimeType, buffer, prompt: parts[0] });
  }
}

async function analyzeRow(row) {
  const kind = mediaKind(row.mime_type);
  if (!kind) return { status: 'skipped', reason: 'unsupported media type' };

  await pool.query(
    `UPDATE public.media_files
     SET analysis_status = 'processing', analysis_attempts = analysis_attempts + 1, analysis_error = NULL
     WHERE id = $1`,
    [row.id]
  );

  try {
    const stat = await fs.promises.stat(row.file_path);
    const maxBytes = kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (stat.size > maxBytes) throw new Error(`media exceeds ${maxBytes} byte analysis limit`);
    const buffer = await fs.promises.readFile(row.file_path);
    const extractedText = kind === 'pdf' ? await extractPdfText(buffer) : null;
    const analysis = await generateSemanticText({ kind, mimeType: row.mime_type, buffer, extractedText });

    await pool.query(
      `UPDATE public.media_files
       SET extracted_text = $2, semantic_text = $3, analysis_kind = $4,
           analysis_status = 'completed', analysis_provider = $5, analysis_model = $6,
           analysis_error = NULL, analyzed_at = NOW()
       WHERE id = $1`,
      [row.id, extractedText, analysis.text, kind, analysis.provider, analysis.model]
    );
    return { status: 'completed' };
  } catch (err) {
    await pool.query(
      `UPDATE public.media_files
       SET analysis_status = 'failed', analysis_error = $2, analyzed_at = NOW()
       WHERE id = $1`,
      [row.id, String(err.message || err).slice(0, 1000)]
    );
    throw err;
  }
}

async function processPendingMedia(limit = BATCH_SIZE) {
  if (state.running || state.paused) return getMediaAnalysisStatus();
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.processed = 0;
  state.succeeded = 0;
  state.failed = 0;
  state.lastError = null;

  try {
    const { rows } = await pool.query(
      `SELECT id, wa_msg_id, file_path, mime_type, file_size
       FROM public.media_files
       WHERE (analysis_status IN ('pending', 'failed') OR analysis_status IS NULL)
         AND analysis_attempts < 3
         AND (mime_type = 'application/pdf' OR mime_type LIKE 'image/%')
       ORDER BY created_at ASC
       LIMIT $1`,
      [Math.max(1, Math.min(Number(limit) || BATCH_SIZE, 50))]
    );

    for (const row of rows) {
      try {
        await analyzeRow(row);
        state.succeeded++;
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

function getMediaAnalysisStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    processed: state.processed,
    succeeded: state.succeeded,
    failed: state.failed,
    lastError: state.lastError,
    paused: state.paused,
    pausedReason: state.pausedReason,
    model: DEFAULT_MODEL,
  };
}

function resumeMediaAnalysis() {
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
  if (process.env.WHATSAPP_MEDIA_ANALYSIS_ENABLED === '0' || state.timer) return;
  pool.query("UPDATE public.media_files SET analysis_status = 'pending' WHERE analysis_status = 'processing'").catch(() => {});
  pool.query(
    `UPDATE public.media_files
     SET analysis_status = 'pending', analysis_attempts = 0
     WHERE semantic_text IS NULL
       AND analysis_error ILIKE '%spending cap%'`
  ).catch(() => {});
  pool.query(
    `UPDATE public.media_files
     SET analysis_status = 'pending', analysis_attempts = 0, analysis_error = NULL
     WHERE semantic_text IS NULL
       AND mime_type = 'application/pdf'
       AND analysis_error LIKE 'media exceeds % byte analysis limit'`
  ).catch(() => {});
  const run = () => processPendingMedia().catch(err => {
    state.lastError = err.message;
    console.warn('[media-analysis] worker error:', err.message);
  });
  setTimeout(run, 5000);
  state.timer = setInterval(run, INTERVAL_MS);
  state.timer.unref();
  console.log(`[media-analysis] worker started (batch=${BATCH_SIZE}, interval=${INTERVAL_MS}ms, model=${DEFAULT_MODEL})`);
}

function stopMediaAnalysisWorker() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

module.exports = {
  mediaKind,
  extractPdfText,
  generateSemanticText,
  generateWithVisionFallback,
  processPendingMedia,
  getMediaAnalysisStatus,
  getMediaAnalysisCounts,
  resumeMediaAnalysis,
  startMediaAnalysisWorker,
  stopMediaAnalysisWorker,
};
