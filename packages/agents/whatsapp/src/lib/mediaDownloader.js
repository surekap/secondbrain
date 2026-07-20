'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('./db');
const { canonicalWhatsAppChatId } = require('../../../shared/whatsapp-chat');

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(require('os').homedir(), '.secondbrain-media', 'wa');

const recoveryState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  completed: 0,
  recovered: 0,
  unavailable: 0,
  errors: [],
};

function ensureDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/**
 * Download media for a whatsapp-web.js Message object and store to disk.
 * Non-fatal: logs errors but does not throw.
 * Returns { filepath, mimetype } or null.
 */
async function downloadAndStore(msg) {
  if (!msg.hasMedia) return null;
  try {
    ensureDir();
    const msgId = msg.id?._serialized ?? msg.id?.$1;
    if (!msgId || typeof msg.downloadMedia !== 'function') return null;

    // Check if already downloaded
    const { rows } = await pool.query('SELECT file_path, mime_type FROM public.media_files WHERE wa_msg_id = $1', [msgId]);
    if (rows.length > 0 && fs.existsSync(rows[0].file_path)) {
      return { filepath: rows[0].file_path, mimetype: rows[0].mime_type };
    }

    const media = await msg.downloadMedia();
    if (!media || !media.data) return null;

    const ext = (media.mimetype || 'application/octet-stream').split('/')[1]?.split(';')[0]?.replace('+', '_') || 'bin';
    const safeName = msgId.replace(/[^a-zA-Z0-9_\-@.]/g, '_');
    const filename = `${safeName}.${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);

    const buf = Buffer.from(media.data, 'base64');
    const contentSha256 = crypto.createHash('sha256').update(buf).digest('hex');
    fs.writeFileSync(filepath, buf);

    await pool.query(
      `INSERT INTO public.media_files AS mf
         (wa_msg_id, chat_id, file_path, mime_type, file_size, content_sha256, analysis_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT (wa_msg_id) DO UPDATE
       SET file_path = EXCLUDED.file_path,
           mime_type = EXCLUDED.mime_type,
           file_size = EXCLUDED.file_size,
           content_sha256 = EXCLUDED.content_sha256,
           analysis_status = CASE
             WHEN mf.semantic_text IS NULL THEN 'pending'
             ELSE mf.analysis_status
           END`,
      [
        msgId,
        canonicalWhatsAppChatId(msg, {
          selfJid: process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID,
        }),
        filepath,
        media.mimetype,
        buf.length,
        contentSha256,
      ]
    );

    return { filepath, mimetype: media.mimetype };
  } catch (err) {
    console.error(`[media] download failed for ${msg.id?._serialized}: ${err.message}`);
    return null;
  }
}

async function recoverMissingMedia(client, { days = 90, limit = 500 } = {}) {
  if (recoveryState.running) return getMediaRecoveryStatus();
  recoveryState.running = true;
  recoveryState.startedAt = new Date().toISOString();
  recoveryState.finishedAt = null;
  recoveryState.total = 0;
  recoveryState.completed = 0;
  recoveryState.recovered = 0;
  recoveryState.unavailable = 0;
  recoveryState.errors = [];

  try {
    const since = new Date(Date.now() - Math.max(1, Math.min(Number(days) || 90, 365)) * 86400000);
    const { rows } = await pool.query(
      `SELECT m.wa_msg_id
       FROM public.messages m
       LEFT JOIN public.media_files f ON f.wa_msg_id = m.wa_msg_id
       WHERE m.wa_msg_id IS NOT NULL
         AND m.ts >= $1
         AND COALESCE((m.data->>'hasMedia')::boolean, false) = true
         AND f.wa_msg_id IS NULL
       GROUP BY m.wa_msg_id
       ORDER BY MAX(m.ts) DESC
       LIMIT $2`,
      [since, Math.max(1, Math.min(Number(limit) || 500, 2000))]
    );
    recoveryState.total = rows.length;

    for (const row of rows) {
      try {
        const message = await client.getMessageById(row.wa_msg_id);
        if (!message || !message.hasMedia || typeof message.downloadMedia !== 'function') {
          recoveryState.unavailable++;
        } else if (await downloadAndStore(message)) {
          recoveryState.recovered++;
        } else {
          recoveryState.unavailable++;
        }
      } catch (err) {
        recoveryState.unavailable++;
        recoveryState.errors.push({ waMsgId: row.wa_msg_id, error: err.message });
      } finally {
        recoveryState.completed++;
      }
    }
  } finally {
    recoveryState.running = false;
    recoveryState.finishedAt = new Date().toISOString();
  }
  return getMediaRecoveryStatus();
}

function getMediaRecoveryStatus() {
  return { ...recoveryState, errors: recoveryState.errors.slice(-20) };
}

module.exports = { downloadAndStore, recoverMissingMedia, getMediaRecoveryStatus, MEDIA_DIR };
