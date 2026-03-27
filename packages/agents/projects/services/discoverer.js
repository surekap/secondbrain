'use strict'

const llm = require('../../shared/llm')
const db        = require('@secondbrain/db')

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  // If truncated, find the last complete object and close the array
  try {
    return JSON.parse(clean)
  } catch {
    const lastBrace = clean.lastIndexOf('}')
    if (lastBrace === -1) throw new Error('No JSON objects found')
    const truncated = clean.slice(0, lastBrace + 1) + '\n]'
    return JSON.parse(truncated)
  }
}

/**
 * Gather raw data from all communication sources for project discovery.
 */
async function gatherDiscoveryData() {
  // Email thread subjects (deduplicated, strip Re:/Fwd:)
  const { rows: emailRows } = await db.query(`
    SELECT
      TRIM(REGEXP_REPLACE(subject, '^(Re|Fwd|FW|RE|FWD):\\s*', '', 'gi')) AS base_subject,
      COUNT(*)                        AS thread_count,
      MAX(date)                       AS most_recent
    FROM email.emails
    WHERE subject IS NOT NULL
      AND subject != ''
    GROUP BY base_subject
    HAVING COUNT(*) >= 1
    ORDER BY thread_count DESC, most_recent DESC
    LIMIT 150
  `)

  // Limitless lifelog titles — last 100
  const { rows: lifelogRows } = await db.query(`
    SELECT title, start_time
    FROM limitless.lifelogs
    WHERE title IS NOT NULL AND title != ''
    ORDER BY start_time DESC
    LIMIT 100
  `)

  // WhatsApp contact names + message count (chats with >5 text messages in last 90 days)
  const { rows: waRows } = await db.query(`
    SELECT
      m.chat_id,
      MAX(m.data->'_data'->>'notifyName')   AS notify_name,
      COUNT(*)                              AS msg_count
    FROM public.messages m
    WHERE m.event IN ('message','message_create','message_historical')
      AND m.msg_type = 'chat'
      AND m.data->>'body' IS NOT NULL
      AND length(m.data->>'body') > 3
      AND m.chat_id LIKE '%@c.us'
    GROUP BY m.chat_id
    HAVING COUNT(*) > 5
    ORDER BY COUNT(*) DESC
    LIMIT 60
  `)

  // Also pull group chat names
  const { rows: groupRows } = await db.query(`
    SELECT
      m.chat_id,
      COUNT(*) AS msg_count
    FROM public.messages m
    WHERE m.event IN ('message','message_create','message_historical')
      AND m.msg_type = 'chat'
      AND m.data->>'body' IS NOT NULL
      AND length(m.data->>'body') > 3
      AND m.chat_id LIKE '%@g.us'
    GROUP BY m.chat_id
    HAVING COUNT(*) > 10
    ORDER BY COUNT(*) DESC
    LIMIT 30
  `)

  const emailSubjects = emailRows.map(r => ({
    subject: r.base_subject,
    count:   parseInt(r.thread_count, 10),
    recent:  r.most_recent,
  }))

  const lifelogTitles = lifelogRows.map(r => ({
    title: r.title,
    date:  r.start_time,
  }))

  const whatsappChats = [
    ...waRows.map(r => ({
      chat_id:  r.chat_id,
      name:     r.notify_name || r.chat_id.replace('@c.us', ''),
      msg_count: parseInt(r.msg_count, 10),
    })),
    ...groupRows.map(r => ({
      chat_id:  r.chat_id,
      name:     r.chat_id.replace('@g.us', ' (group)'),
      msg_count: parseInt(r.msg_count, 10),
    })),
  ]

  return { emailSubjects, lifelogTitles, whatsappChats }
}

/**
 * Ask Claude to discover projects from gathered communications data.
 * Returns array of project objects.
 */
async function discoverProjects(data) {
  const { emailSubjects, lifelogTitles, whatsappChats } = data

  // Load existing project names so Claude can reuse them instead of creating variants
  let existingNames = []
  try {
    const { rows } = await db.query(`SELECT name FROM projects.projects WHERE is_archived = FALSE ORDER BY name`)
    existingNames = rows.map(r => r.name)
  } catch { /* non-fatal */ }

  const emailList = emailSubjects.slice(0, 100).map(e =>
    `- "${e.subject}" (${e.count} emails, last: ${e.recent ? new Date(e.recent).toLocaleDateString() : 'unknown'})`
  ).join('\n')

  const lifelogList = lifelogTitles.slice(0, 60).map(l =>
    `- "${l.title}" (${l.date ? new Date(l.date).toLocaleDateString() : ''})`
  ).join('\n')

  const waList = whatsappChats.slice(0, 50).map(c =>
    `- ${c.name} (${c.msg_count} messages)`
  ).join('\n')

  const existingList = existingNames.length > 0
    ? `\nExisting projects (reuse these exact names if the topic matches — do NOT create a new entry for something already tracked):\n${existingNames.map(n => `- ${n}`).join('\n')}\n`
    : ''

  const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
  const prompt = `You are analyzing communications for a business person. Today is ${today}. Based on these email subjects, meeting transcripts, and WhatsApp conversations, identify the distinct projects, matters, or initiatives this person is managing.
${existingList}

Email thread subjects (with frequency):
${emailList || '(none)'}

Meeting transcript titles (recent):
${lifelogList || '(none)'}

Active WhatsApp conversations:
${waList || '(none)'}

Return a JSON array of projects. Each project:
{
  "name": "Short project name",
  "description": "1-2 sentence description of what this project is about",
  "status": "active|stalled|completed|unknown",
  "health": "on_track|at_risk|blocked|unknown",
  "priority": "high|medium|low",
  "tags": ["tag1"],
  "keywords": ["keyword1", "keyword2"]
}

Guidelines:
- Be specific — "Hartex SAP Implementation" not just "SAP"
- Merge very similar topics (e.g. "SAP HANA" and "SAP Implementation" are one project)
- Ignore noise (one-off unrelated messages)
- Max 20 projects
- keywords should be words or phrases that would appear in communications related to this project
- For status: use "active" only if there is evidence of recent activity (within the last few months relative to today's date); use "stalled" if activity has gone quiet; use "completed" if the matter appears to have concluded; use "unknown" if unclear
- For health: assess based on tone and recency of activity
- Projects where the most recent email activity is more than 1 year ago and there are no recent meeting transcripts or WhatsApp messages on the topic should be marked "stalled" or "completed", NOT "active"`

  try {
    const response = await llm.create('projects', {
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text || ''
    const result = parseJSON(text)
    return Array.isArray(result) ? result : []
  } catch (err) {
    console.error('[discoverer] discoverProjects error:', err.message)
    return []
  }
}

module.exports = { gatherDiscoveryData, discoverProjects }
