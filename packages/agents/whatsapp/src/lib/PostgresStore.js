'use strict';

const fs   = require('fs');
const pool = require('./db');
const {
  canonicalWhatsAppChatId,
  isGroupWhatsAppChatId,
} = require('../../../shared/whatsapp-chat');

class PostgresStore {
  constructor(clientId) {
    this.clientId = clientId;
  }

  /**
   * RemoteAuth calls this after creating {session}.zip in the CWD.
   * We read that zip and store it as base64 in Postgres.
   */
  async save({ session }) {
    const zipPath = `${session}.zip`;
    let base64Data = null;
    try {
      const buf = await fs.promises.readFile(zipPath);
      base64Data = buf.toString('base64');
    } catch (err) {
      console.error('[store] save: could not read session zip:', err.message);
      return;
    }
    await pool.query(
      `INSERT INTO sessions (client_id, session_name, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE SET session_name = $2, data = $3`,
      [this.clientId, session, base64Data]
    );
    console.log('[store] session saved to DB');
  }

  /**
   * Returns true only if we have actual (non-null) zip data stored.
   */
  async sessionExists({ session }) {
    const res = await pool.query(
      'SELECT 1 FROM sessions WHERE client_id = $1 AND session_name = $2 AND data IS NOT NULL',
      [this.clientId, session]
    );
    return res.rowCount > 0;
  }

  /**
   * RemoteAuth calls this with { session, path } — we write the zip to that path.
   */
  async extract({ session, path: targetPath }) {
    const res = await pool.query(
      'SELECT data FROM sessions WHERE client_id = $1 AND session_name = $2',
      [this.clientId, session]
    );
    if (!res.rows[0]?.data) {
      console.error('[store] extract: no session data found in DB');
      return;
    }
    const buf = Buffer.from(res.rows[0].data, 'base64');
    await fs.promises.writeFile(targetPath, buf);
    console.log('[store] session extracted from DB to', targetPath);
  }

  async delete({ session }) {
    await pool.query(
      'DELETE FROM sessions WHERE client_id = $1 AND session_name = $2',
      [this.clientId, session]
    );
  }

  /**
   * Persist a WhatsApp event. Returns the pg QueryResult so callers can read rows[0].id.
   */
  async event(eventName, data) {
    let chatId = null;
    let groupId = null;
    let msgType = null;

    try {
      chatId = canonicalWhatsAppChatId(data, {
        selfJid: process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID,
      });
      groupId = isGroupWhatsAppChatId(chatId) ? chatId : null;
      msgType = data?.type ?? null;
    } catch (_) { /* keep nulls if payload shape is unexpected */ }

    let waId = null;
    try {
      waId = data?.id?._serialized ?? null;
    } catch (_) {}

    let jsonData;
    try {
      jsonData = JSON.stringify(data ?? null);
    } catch (_) {
      jsonData = JSON.stringify({ _raw: String(data) });
    }

    return pool.query(
      `INSERT INTO messages (client_id, event, data, chat_id, group_id, msg_type, wa_msg_id, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (wa_msg_id) WHERE wa_msg_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [this.clientId, eventName, jsonData, chatId, groupId, msgType, waId]
    );
  }
}

module.exports = PostgresStore;
