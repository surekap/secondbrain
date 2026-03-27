'use strict'

const llm = require('../../shared/llm')
const db       = require('@secondbrain/db')

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    // Attempt recovery from truncated JSON: find last complete object
    const lastBrace = clean.lastIndexOf('}')
    if (lastBrace === -1) throw new Error('No JSON objects found')
    const truncated = clean.slice(0, lastBrace + 1) + '\n]'
    return JSON.parse(truncated)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Classify a batch of communications (up to 40) into projects.
 */
async function classifyBatch(items, projects) {
  if (!items.length || !projects.length) return []

  const projectList = projects.map(p =>
    `  id=${p.id}, name="${p.name}", keywords: [${(p.keywords || []).join(', ')}]`
  ).join('\n')

  const commList = items.map(item =>
    `  id="${item.source_id}", source=${item.source}, date=${item.date || ''}, ${item.subject ? `subject="${item.subject}", ` : ''}snippet="${(item.snippet || '').slice(0, 180)}"`
  ).join('\n')

  const prompt = `Classify each communication into one of these projects (or null if none match):

Projects:
${projectList}

Communications:
${commList}

Return JSON array: [{"id": "source_id", "project_id": N_or_null, "relevance": 0.0_to_1.0}]

Be conservative — only assign if clearly related. relevance > 0.7 = strong match.
Return ONLY the JSON array, no explanation.`

  try {
    const response = await llm.create('projects', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
    })

    const text = response.text || ''
    const result = parseJSON(text)
    if (!Array.isArray(result)) return []

    return result.map(r => ({
      source_id:       String(r.id),
      project_id:      r.project_id || null,
      relevance_score: typeof r.relevance === 'number' ? r.relevance : 1.0,
    })).filter(r => r.project_id !== null)
  } catch (err) {
    console.error('[classifier] classifyBatch error:', err.message)
    return []
  }
}

/**
 * Insert a classified communication into project_communications.
 */
async function insertClassified(c, source, content_snippet, subject, occurred_at) {
  try {
    await db.query(`
      INSERT INTO projects.project_communications
        (project_id, source, source_id, content_snippet, subject, occurred_at, relevance_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (project_id, source, source_id) DO UPDATE SET
        relevance_score = EXCLUDED.relevance_score
    `, [c.project_id, source, c.source_id, content_snippet, subject, occurred_at, c.relevance_score])
    return true
  } catch {
    return false
  }
}

/**
 * Classify NEW emails into projects (skips already-classified ones).
 * Uses NOT EXISTS to skip items regardless of date, so historical emails
 * that were missed in prior runs are still picked up.
 * @param {Array}  projects   - Array of {id, name, keywords}
 * @param {Date|null} _since  - Unused; kept for API compatibility
 */
async function classifyEmails(projects, _since = null) {
  let total = 0
  try {
    const { rows: emails } = await db.query(`
      SELECT
        e.id,
        e.subject,
        SUBSTRING(e.body_text, 1, 300) AS snippet,
        e.date
      FROM email.emails e
      WHERE (e.subject IS NOT NULL OR e.body_text IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM projects.project_communications pc
          WHERE pc.source = 'email'
            AND pc.source_id = 'email:' || e.id::text
        )
      ORDER BY e.date DESC NULLS LAST
      LIMIT 500
    `)

    if (!emails.length) return 0

    const BATCH = 40
    for (let i = 0; i < emails.length; i += BATCH) {
      const batch = emails.slice(i, i + BATCH).map(e => ({
        source_id: `email:${e.id}`,
        source:    'email',
        subject:   e.subject || '',
        snippet:   (e.snippet || '').replace(/\s+/g, ' '),
        date:      e.date ? new Date(e.date).toLocaleDateString() : '',
      }))

      const classifications = await classifyBatch(batch, projects)

      for (const c of classifications) {
        const emailId = parseInt(c.source_id.replace('email:', ''), 10)
        const em = emails.find(e => e.id === emailId)
        if (!em) continue

        const ok = await insertClassified(
          c, 'email',
          (em.snippet || em.subject || '').replace(/\s+/g, ' ').slice(0, 400),
          em.subject || null,
          em.date || null,
        )
        if (ok) total++
      }

      if (i + BATCH < emails.length) await sleep(1000)
    }
  } catch (err) {
    console.error('[classifier] classifyEmails error:', err.message)
  }
  return total
}

/**
 * Classify NEW Limitless lifelogs into projects.
 * Uses NOT EXISTS so previously unclassified lifelogs are always processed.
 * @param {Array}  projects
 * @param {Date|null} _since  - Unused; kept for API compatibility
 */
async function classifyLifelogs(projects, _since = null) {
  let total = 0
  try {
    const { rows: logs } = await db.query(`
      SELECT l.id, l.title, SUBSTRING(l.markdown, 1, 300) AS snippet, l.start_time
      FROM limitless.lifelogs l
      WHERE l.title IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM projects.project_communications pc
          WHERE pc.source = 'limitless'
            AND pc.source_id = 'limitless:' || l.id::text
        )
      ORDER BY l.start_time DESC NULLS LAST
      LIMIT 300
    `)

    if (!logs.length) return 0

    const BATCH = 40
    for (let i = 0; i < logs.length; i += BATCH) {
      const batch = logs.slice(i, i + BATCH).map(l => ({
        source_id: `limitless:${l.id}`,
        source:    'limitless',
        subject:   l.title || '',
        snippet:   (l.snippet || '').replace(/\s+/g, ' '),
        date:      l.start_time ? new Date(l.start_time).toLocaleDateString() : '',
      }))

      const classifications = await classifyBatch(batch, projects)

      for (const c of classifications) {
        const logId = c.source_id.replace('limitless:', '')
        const log = logs.find(l => String(l.id) === logId)
        if (!log) continue

        const ok = await insertClassified(
          c, 'limitless',
          (log.snippet || log.title || '').replace(/\s+/g, ' ').slice(0, 400),
          log.title || null,
          log.start_time || null,
        )
        if (ok) total++
      }

      if (i + BATCH < logs.length) await sleep(1000)
    }
  } catch (err) {
    console.error('[classifier] classifyLifelogs error:', err.message)
  }
  return total
}

/**
 * Classify WhatsApp chats with activity since `since` into projects.
 * Each chat is treated as a unit (not individual messages).
 * @param {Array}  projects
 * @param {Date|null} since
 */
async function classifyWhatsAppChats(projects, since = null) {
  let total = 0
  try {
    const { rows: chats } = await db.query(`
      SELECT
        chat_id,
        COUNT(*) AS msg_count,
        MAX(ts)  AS last_msg_at
      FROM public.messages
      WHERE event IN ('message','message_create','message_historical')
        AND msg_type = 'chat'
        AND ($1::timestamptz IS NULL OR ts > $1)
        AND data->>'body' IS NOT NULL
        AND length(data->>'body') > 3
      GROUP BY chat_id
      HAVING COUNT(*) > 3
      ORDER BY MAX(ts) DESC
      LIMIT 80
    `, [since || null])

    if (!chats.length) return 0

    const chatItems = []
    for (const chat of chats) {
      const { rows: msgs } = await db.query(`
        SELECT
          data->>'body'                  AS body,
          data->'_data'->>'notifyName'   AS notify_name,
          (data->'id'->>'fromMe')::boolean AS from_me,
          ts
        FROM public.messages
        WHERE chat_id = $1
          AND event IN ('message','message_create','message_historical')
          AND msg_type = 'chat'
          AND data->>'body' IS NOT NULL
        ORDER BY ts DESC
        LIMIT 10
      `, [chat.chat_id])

      if (!msgs.length) continue

      const sample = msgs.map(m =>
        `[${m.from_me ? 'Me' : (m.notify_name || 'them')}]: ${(m.body || '').slice(0, 100)}`
      ).join(' | ')

      const name = msgs.find(m => m.notify_name)?.notify_name
        || chat.chat_id.replace('@c.us', '').replace('@g.us', ' (group)')

      chatItems.push({
        source_id: `whatsapp:${chat.chat_id}`,
        source:    'whatsapp',
        subject:   name,
        snippet:   sample,
        date:      chat.last_msg_at ? new Date(chat.last_msg_at).toLocaleDateString() : '',
        chat_id:   chat.chat_id,
        last_at:   chat.last_msg_at,
      })
    }

    const BATCH = 40
    for (let i = 0; i < chatItems.length; i += BATCH) {
      const batch = chatItems.slice(i, i + BATCH)
      const classifications = await classifyBatch(batch, projects)

      for (const c of classifications) {
        const item = chatItems.find(it => it.source_id === c.source_id)
        if (!item) continue

        const ok = await insertClassified(
          c, 'whatsapp',
          item.snippet.slice(0, 400),
          item.subject || null,
          item.last_at || null,
        )
        if (ok) total++
      }

      if (i + BATCH < chatItems.length) await sleep(1000)
    }
  } catch (err) {
    console.error('[classifier] classifyWhatsAppChats error:', err.message)
  }
  return total
}

module.exports = { classifyBatch, classifyEmails, classifyLifelogs, classifyWhatsAppChats }
