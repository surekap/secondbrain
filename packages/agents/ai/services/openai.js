'use strict'

/**
 * OpenAI ChatGPT conversation importer.
 *
 * Data source: ChatGPT data export
 *   1. Go to chatgpt.com → Settings → Data controls → Export data
 *   2. Download the ZIP you receive by email
 *   3. Unzip it — the file you need is: conversations.json
 *   4. Set OPENAI_EXPORT_PATH in .env.local to its absolute path
 *      (default: ~/Downloads/openai-export/conversations.json)
 *
 * The export format is a JSON array where each conversation has a `mapping`
 * tree of nodes. We traverse it from root → current_node to reconstruct the
 * message thread in chronological order.
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const db   = require('@secondbrain/db')

const PROVIDER = 'openai'

function resolveExportPath() {
  const env = process.env.OPENAI_EXPORT_PATH
  if (env) return path.resolve(env.replace(/^~/, os.homedir()))
  return path.join(os.homedir(), 'Downloads', 'openai-export', 'conversations.json')
}

/**
 * Traverse the mapping tree from the current_node back to root,
 * returning messages in chronological order (oldest first).
 */
function extractMessages(mapping, currentNodeId) {
  if (!mapping || !currentNodeId) return []

  // Walk backwards: current_node → parent → … → root
  const chain = []
  let nodeId = currentNodeId

  const seen = new Set()
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId)
    const node = mapping[nodeId]
    if (!node) break
    if (node.message) chain.push(node.message)
    nodeId = node.parent || null
  }

  chain.reverse() // oldest first

  const messages = []
  for (const msg of chain) {
    if (!msg?.author?.role) continue
    const role = msg.author.role
    if (role === 'system' || role === 'tool') continue  // skip non-chat roles

    // content.parts is an array; join text parts
    const parts = msg.content?.parts || []
    const text  = parts
      .filter(p => typeof p === 'string')
      .join('')
      .trim()

    if (!text) continue

    const model = msg.metadata?.model_slug || null
    const ts    = msg.create_time ? new Date(msg.create_time * 1000) : null

    messages.push({
      external_id: msg.id,
      role:        role === 'assistant' ? 'assistant' : 'user',
      content:     text,
      model,
      created_at:  ts,
      metadata:    {
        finish_details: msg.metadata?.finish_details || null,
        status:         msg.status || null,
      },
    })
  }
  return messages
}

async function ensureSchema() {
  const sql = fs.readFileSync(path.resolve(__dirname, '../sql/schema.sql'), 'utf8')
  await db.query(sql)
}

async function importConversations() {
  await ensureSchema()

  const filePath = resolveExportPath()
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `OpenAI export file not found at: ${filePath}\n` +
      `Export your data from chatgpt.com → Settings → Data controls → Export data, ` +
      `unzip the archive, and set OPENAI_EXPORT_PATH to the path of conversations.json`
    )
  }

  console.log(`📂 Reading OpenAI export: ${filePath}`)
  const raw  = fs.readFileSync(filePath, 'utf8')
  const data = JSON.parse(raw)

  return importConversationsFromData(data, filePath)
}

async function importConversationsFromData(data, sourceLabel = 'upload') {
  await ensureSchema()

  if (!Array.isArray(data)) throw new Error('conversations.json is not an array')
  console.log(`   Found ${data.length} conversations in export`)

  // Start sync log
  const { rows: [log] } = await db.query(`
    INSERT INTO ai.sync_log (provider, source_file, status)
    VALUES ($1, $2, 'running')
    RETURNING id
  `, [PROVIDER, sourceLabel])
  const logId = log.id

  let convsImported = 0
  let msgsImported  = 0

  for (const conv of data) {
    try {
      const externalId = conv.id || conv.conversation_id
      if (!externalId) continue

      const title     = conv.title || null
      const createdAt = conv.create_time ? new Date(conv.create_time * 1000) : null
      const updatedAt = conv.update_time ? new Date(conv.update_time * 1000) : null

      // Extract messages before upsert so we know the model
      const messages  = extractMessages(conv.mapping, conv.current_node)
      const lastModel = messages.filter(m => m.model).map(m => m.model).pop() || null

      // Upsert conversation
      const { rows: [row] } = await db.query(`
        INSERT INTO ai.conversations
          (provider, external_id, title, model, message_count, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, external_id) DO UPDATE SET
          title         = COALESCE(EXCLUDED.title, ai.conversations.title),
          model         = COALESCE(EXCLUDED.model, ai.conversations.model),
          message_count = EXCLUDED.message_count,
          updated_at    = EXCLUDED.updated_at,
          imported_at   = NOW()
        RETURNING id
      `, [PROVIDER, externalId, title, lastModel, messages.length, createdAt, updatedAt])

      const convId = row.id

      // Upsert messages
      for (const msg of messages) {
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
      console.error(`   [openai] error importing conversation ${conv.id}:`, err.message)
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
