'use strict'

/**
 * Google Gemini conversation importer.
 *
 * Data source: Google Takeout → Gemini Apps Activity
 *   1. Go to takeout.google.com
 *   2. Deselect all → select only "Gemini Apps"
 *   3. Download and unzip the archive
 *   4. Locate the JSON file — typically at:
 *        Takeout/Gemini Apps/Gemini Apps Activity.json
 *   5. Set GEMINI_EXPORT_PATH in .env.local to its absolute path
 *      (default: ~/Downloads/gemini-export/Gemini Apps Activity.json)
 *
 * Alternatively, Google AI Studio conversations exported as JSON are also
 * supported. The importer accepts both the Takeout format and the AI Studio
 * export format, auto-detecting which is present.
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const db   = require('@secondbrain/db')

const PROVIDER = 'gemini'

function resolveExportPath() {
  const env = process.env.GEMINI_EXPORT_PATH
  if (env) return path.resolve(env.replace(/^~/, os.homedir()))
  return path.join(os.homedir(), 'Downloads', 'gemini-export', 'Gemini Apps Activity.json')
}

// ── Format detectors ──────────────────────────────────────────────────────────

/**
 * Google Takeout format (Gemini Apps Activity.json):
 * An array of activity records. Conversation records have:
 *   { header: "Gemini Apps", title: "...", time: "ISO8601",
 *     products: ["Gemini Apps"],
 *     details: [{ name: "Conversation", text: [...] }] }
 *
 * OR a newer format:
 *   { conversations: [{ id, title, createTime, updateTime, turns: [...] }] }
 *
 * OR AI Studio export:
 *   [{ conversation_id, title, create_time, turns: [{role, parts:[{text}]}] }]
 */
function detectFormat(data) {
  if (Array.isArray(data)) {
    const first = data[0] || {}
    // Takeout activity format
    if (first.header || first.products) return 'takeout_activity'
    // AI Studio / direct export
    if (first.turns || first.content || first.messages) return 'turns'
    // Raw conversation list with mapping (unlikely for Gemini, but handle it)
    if (first.mapping) return 'mapping'
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.conversations)) return 'conversations_wrapper'
  }
  return 'unknown'
}

// ── Format parsers ────────────────────────────────────────────────────────────

/**
 * Parse Google Takeout "Gemini Apps Activity" format.
 * Each record may contain a "details" array with conversation text.
 */
function parseTakeoutActivity(records) {
  const convs = []
  let index   = 0

  for (const record of records) {
    // Skip non-conversation activity records (e.g. voice queries)
    const details = record.details || []
    const convDetail = details.find(d =>
      d.name?.toLowerCase().includes('conversation') ||
      d.name?.toLowerCase().includes('prompt')
    )
    if (!convDetail) continue

    // text is an array of turn objects: [{name: 'User', value: '...'}, ...]
    const textItems = convDetail.text || []
    if (!textItems.length) continue

    index++
    const externalId = record.id || `takeout-${index}`
    const title      = record.title || `Conversation ${index}`
    const createdAt  = record.time ? new Date(record.time) : null

    const messages = []
    for (const item of textItems) {
      const name = (item.name || '').toLowerCase()
      const text = (item.value || item.text || '').trim()
      if (!text) continue

      // "User" / "You" → user; everything else → assistant
      const role = (name === 'user' || name === 'you') ? 'user' : 'assistant'
      messages.push({
        external_id: `${externalId}-${messages.length}`,
        role,
        content:     text,
        model:       null,
        created_at:  null,
        metadata:    {},
      })
    }

    if (messages.length) {
      convs.push({ externalId, title, model: null, createdAt, updatedAt: null, messages })
    }
  }
  return convs
}

/**
 * Parse "turns" format (AI Studio export or newer Gemini API format).
 * Each conversation: { id, title, create_time, turns: [{role, parts:[{text}]}] }
 */
function parseTurns(records) {
  return records.map((conv, i) => {
    const externalId = conv.id || conv.conversation_id || `turns-${i}`
    const title      = conv.title || conv.name || null
    const createdAt  = conv.create_time  ? new Date(conv.create_time)  : null
    const updatedAt  = conv.update_time  ? new Date(conv.update_time)  : null

    const turns  = conv.turns || conv.content || conv.messages || []
    const messages = []

    for (const turn of turns) {
      const role  = (turn.role === 'model' || turn.role === 'assistant') ? 'assistant' : 'user'
      const parts = turn.parts || []
      const text  = parts
        .map(p => (typeof p === 'string' ? p : (p.text || '')))
        .join('')
        .trim()
      if (!text) continue

      const model = turn.model || conv.model || null
      messages.push({
        external_id: turn.id || `${externalId}-${messages.length}`,
        role,
        content:     text,
        model,
        created_at:  turn.create_time ? new Date(turn.create_time) : null,
        metadata:    {},
      })
    }

    const lastModel = messages.filter(m => m.model).map(m => m.model).pop() || null

    return { externalId, title, model: lastModel, createdAt, updatedAt, messages }
  }).filter(c => c.messages.length > 0)
}

/**
 * Parse { conversations: [...] } wrapper format.
 */
function parseConversationsWrapper(data) {
  return parseTurns(data.conversations)
}

function parseExport(data) {
  const fmt = detectFormat(data)
  switch (fmt) {
    case 'takeout_activity':     return parseTakeoutActivity(data)
    case 'turns':                return parseTurns(data)
    case 'conversations_wrapper': return parseConversationsWrapper(data)
    default:
      console.warn(`   [gemini] Unrecognised export format "${fmt}", attempting turns parse`)
      return parseTurns(Array.isArray(data) ? data : [data])
  }
}

// ── Main import ───────────────────────────────────────────────────────────────

async function ensureSchema() {
  const sql = fs.readFileSync(path.resolve(__dirname, '../sql/schema.sql'), 'utf8')
  await db.query(sql)
}

async function importConversations() {
  await ensureSchema()

  const filePath = resolveExportPath()
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Gemini export file not found at: ${filePath}\n` +
      `Export your data from takeout.google.com → select "Gemini Apps" → download and unzip.\n` +
      `Then set GEMINI_EXPORT_PATH to the path of the JSON file (usually "Gemini Apps Activity.json")`
    )
  }

  console.log(`📂 Reading Gemini export: ${filePath}`)
  const raw  = fs.readFileSync(filePath, 'utf8')
  const data = JSON.parse(raw)

  return importConversationsFromData(data, filePath)
}

async function importConversationsFromData(data, sourceLabel = 'upload') {
  await ensureSchema()

  const conversations = parseExport(data)
  console.log(`   Found ${conversations.length} conversations in export`)

  // Start sync log
  const { rows: [log] } = await db.query(`
    INSERT INTO ai.sync_log (provider, source_file, status)
    VALUES ($1, $2, 'running')
    RETURNING id
  `, [PROVIDER, sourceLabel])
  const logId = log.id

  let convsImported = 0
  let msgsImported  = 0

  for (const conv of conversations) {
    try {
      const { rows: [row] } = await db.query(`
        INSERT INTO ai.conversations
          (provider, external_id, title, model, message_count, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, external_id) DO UPDATE SET
          title         = COALESCE(EXCLUDED.title, ai.conversations.title),
          model         = COALESCE(EXCLUDED.model, ai.conversations.model),
          message_count = EXCLUDED.message_count,
          updated_at    = COALESCE(EXCLUDED.updated_at, ai.conversations.updated_at),
          imported_at   = NOW()
        RETURNING id
      `, [PROVIDER, conv.externalId, conv.title, conv.model,
          conv.messages.length, conv.createdAt, conv.updatedAt])

      const convId = row.id

      for (const msg of conv.messages) {
        const { rowCount } = await db.query(`
          INSERT INTO ai.messages
            (conversation_id, external_id, role, content, model, created_at, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (conversation_id, external_id) DO NOTHING
        `, [convId, msg.external_id, msg.role, msg.content, msg.model,
            msg.created_at, JSON.stringify(msg.metadata)])
        if (rowCount > 0) msgsImported++
      }

      convsImported++
    } catch (err) {
      console.error(`   [gemini] error importing conversation ${conv.externalId}:`, err.message)
    }
  }

  await db.query(`
    UPDATE ai.sync_log
    SET status                 = 'completed',
        completed_at           = NOW(),
        conversations_imported = $1,
        messages_imported      = $2
    WHERE id = $3
  `, [convsImported, msgsImported, logId])

  return { convsImported, msgsImported }
}

module.exports = { importConversations, importConversationsFromData, PROVIDER }
