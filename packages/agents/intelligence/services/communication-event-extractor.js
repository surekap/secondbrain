'use strict'

const crypto = require('crypto')

const MONTHS = new Map([
  ['jan', 0], ['january', 0],
  ['feb', 1], ['february', 1],
  ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3],
  ['may', 4],
  ['jun', 5], ['june', 5],
  ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7],
  ['sep', 8], ['sept', 8], ['september', 8],
  ['oct', 9], ['october', 9],
  ['nov', 10], ['november', 10],
  ['dec', 11], ['december', 11],
])

const KIND_PATTERNS = [
  ['webinar', /\bwebinar\b/i],
  ['conference', /\b(conference|summit|symposium|expo|congress)\b/i],
  ['zoom_call', /\bzoom\b(?:\s+(?:call|meeting|link|room))?/i],
  ['workshop', /\b(workshop|bootcamp|masterclass|clinic)\b/i],
  ['panel', /\b(panel|fireside chat|fireside\s+chat)\b/i],
  ['roundtable', /\broundtable\b/i],
  ['meeting', /\b(meeting|calendar invite|calendar\s+invite|town hall|briefing|sync|demo)\b/i],
  ['call', /\b(call|dial\s+in|phone\s+call)\b/i],
  ['event', /\b(event|invite|invitation|join us|rsvp|register|save the date|come along|attend)\b/i],
]

const EVENT_HINT = /\b(webinar|conference|zoom|meeting|call|event|invite|invitation|register|rsvp|calendar|session|workshop|summit|panel|roundtable|demo|town hall|fireside chat|save the date)\b/i

function compact(value, max = 800) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24)
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function stripPrefix(value) {
  return compact(String(value || '').replace(/^(re|fw|fwd)\s*:\s*/i, '').replace(/^invite\s*:\s*/i, ''))
}

function textFor(record = {}, sourceTable = '') {
  switch (sourceTable) {
    case 'email.emails':
      return [record.subject, record.body_text, record.body, record.body_html].filter(Boolean).join('\n')
    case 'public.messages':
      return [record.body, record.caption, record.message, record.text, record.subject].filter(Boolean).join('\n')
    case 'relationships.communications':
    case 'projects.project_communications':
      return [record.subject, record.content_snippet, record.content, record.description].filter(Boolean).join('\n')
    default:
      return [record.subject, record.title, record.content_snippet, record.body, record.text, record.description, record.summary].filter(Boolean).join('\n')
  }
}

function sourceRefFor(sourceTable, record = {}) {
  if (record.source_ref) return String(record.source_ref)
  const id = record.source_id ?? record.id ?? record.wa_msg_id ?? record.message_id
  switch (sourceTable) {
    case 'email.emails':
      return `email:${id}`
    case 'public.messages':
      return `whatsapp:${record.wa_msg_id || id}`
    case 'relationships.communications':
      return `relationships.communication:${id}`
    case 'projects.project_communications':
      return `projects.project_communication:${id}`
    default:
      return `${sourceTable}:${id}`
  }
}

function communicatedAt(record = {}, sourceTable = '') {
  if (record.communicated_at) return record.communicated_at
  switch (sourceTable) {
    case 'email.emails':
      return record.date || record.received_at || record.created_at || null
    case 'public.messages':
      return record.ts || record.created_at || null
    case 'relationships.communications':
    case 'projects.project_communications':
      return record.occurred_at || record.created_at || null
    default:
      return record.occurred_at || record.date || record.ts || record.created_at || null
  }
}

function inferKind(text) {
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(text)) return kind
  }
  return null
}

function extractTitle(record = {}, text = '', kind = 'event') {
  const subject = stripPrefix(record.subject || record.title || record.name || '')
  if (subject && subject.length >= 6) return subject.slice(0, 180)

  const lead = compact(text).split(/[\n.!?]/).map(s => s.trim()).filter(Boolean)[0] || ''
  if (lead) {
    return stripPrefix(lead).slice(0, 180)
  }

  return `${kind} invitation`
}

function parseMonthDay(matchMonth, day, year, timePart, communicatedAtValue) {
  const monthKey = String(matchMonth || '').toLowerCase().replace(/\./g, '')
  const month = MONTHS.get(monthKey)
  if (month == null) return null

  const base = communicatedAtValue ? new Date(communicatedAtValue) : new Date()
  const resolvedYear = year ? Number(year) : base.getUTCFullYear()
  let hours = 0
  let minutes = 0

  if (timePart) {
    const time = String(timePart).toLowerCase().trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/)
    if (time) {
      hours = Number(time[1])
      minutes = Number(time[2] || 0)
      const meridiem = time[3]
      if (meridiem === 'pm' && hours < 12) hours += 12
      if (meridiem === 'am' && hours === 12) hours = 0
    }
  }

  return new Date(Date.UTC(resolvedYear, month, Number(day), hours, minutes, 0, 0))
}

function extractStartsAt(text, communicatedAtValue) {
  const cleaned = String(text || '')
  if (!cleaned) return null

  const iso = cleaned.match(/\b(20\d{2}-\d{2}-\d{2})(?:[T\s](\d{1,2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})?)?/)
  if (iso) {
    const parsed = new Date(iso[0])
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }

  const monthDay = cleaned.match(/\b(?:on\s+|for\s+|at\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(20\d{2}))?(?:\s+(?:at\s+)?([\w:\s.]+?))?(?=\b|[.,;]|$)/i)
  if (monthDay) {
    const parsed = parseMonthDay(monthDay[1], monthDay[2], monthDay[3], monthDay[4], communicatedAtValue)
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }

  const dayMonth = cleaned.match(/\b(?:on\s+|for\s+|at\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,\s*(20\d{2}))?(?:\s+(?:at\s+)?([\w:\s.]+?))?(?=\b|[.,;]|$)/i)
  if (dayMonth) {
    const parsed = parseMonthDay(dayMonth[2], dayMonth[1], dayMonth[3], dayMonth[4], communicatedAtValue)
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }

  const tomorrow = /\btomorrow\b/i.test(cleaned)
  if (tomorrow) {
    const base = communicatedAtValue ? new Date(communicatedAtValue) : new Date()
    base.setUTCDate(base.getUTCDate() + 1)
    return base.toISOString()
  }

  return null
}

function eventKeyFor(event) {
  return stableHash([
    event.event_kind,
    normalize(event.title),
    event.starts_at || '',
    event.communicated_at || '',
    normalize(event.source_ref || ''),
  ].join('|'))
}

function extractCommunicationEvents(records = [], sourceTable = '') {
  const events = []
  const seen = new Set()

  for (const record of records || []) {
    const text = compact(textFor(record, sourceTable), 5000)
    if (!text || !EVENT_HINT.test(text)) continue

    const kind = inferKind(text) || 'event'
    const communicatedAtValue = communicatedAt(record, sourceTable)
    const title = extractTitle(record, text, kind)
    const startsAt = extractStartsAt(text, communicatedAtValue)
    const description = compact([
      record.subject || record.title || null,
      record.body_text || record.body || record.content_snippet || record.description || record.summary || text,
    ].filter(Boolean).join(' — '), 1000)

    const event = {
      event_kind: kind,
      title,
      description,
      communicated_at: communicatedAtValue,
      starts_at: startsAt,
      ends_at: null,
      source_table: sourceTable,
      source_id: String(record.source_id ?? record.id ?? record.wa_msg_id ?? record.message_id ?? ''),
      source_ref: sourceRefFor(sourceTable, record),
      source_contact_id: record.source_contact_id ?? record.contact_id ?? null,
      source_project_id: record.source_project_id ?? record.project_id ?? null,
      source_subject: record.subject || record.title || null,
      source_excerpt: compact(text, 900),
      confidence: kind === 'webinar' || kind === 'conference' ? 0.92 : 0.84,
      metadata: {
        detector: 'communication_event_extractor',
        matched_keywords: text.match(/\b(webinar|conference|zoom|meeting|call|event|invite|invitation|register|rsvp|calendar|session|workshop|summit|panel|roundtable|demo|town hall|fireside chat|save the date)\b/gi) || [],
        raw_source_table: sourceTable,
      },
    }

    event.event_key = eventKeyFor(event)
    if (seen.has(event.event_key)) continue
    seen.add(event.event_key)
    events.push(event)
  }

  return events
}

async function loadCommunicationRows(pool, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const [emails, messages, comms, projectComms] = await Promise.all([
    pool.query(`
      SELECT
        e.id::text AS source_id,
        e.subject,
        e.body_text,
        e.body_html,
        e.date,
        e.received_at,
        e.created_at,
        e.from_address,
        s.contact_id AS source_contact_id,
        NULL::bigint AS source_project_id,
        'email:' || e.id::text AS source_ref
      FROM email.emails e
      LEFT JOIN relationships.email_senders s
        ON LOWER(s.parsed_email) = LOWER(REGEXP_REPLACE(COALESCE(e.from_address, ''), '^.*<([^>]+)>.*$', '\\1'))
        OR LOWER(s.raw_address) = LOWER(COALESCE(e.from_address, ''))
      WHERE COALESCE(e.date, e.received_at, e.created_at) >= $1::timestamptz
      ORDER BY COALESCE(e.date, e.received_at, e.created_at) DESC
      LIMIT 5000
    `, [cutoff]),
    pool.query(`
      SELECT
        m.id::text AS source_id,
        m.chat_id,
        m.ts,
        m.created_at,
        COALESCE(m.data->>'body', m.data->>'caption', m.data->>'text', m.data->>'message') AS body,
        COALESCE(m.data->'_data'->>'notifyName', m.data->>'notifyName') AS subject,
        NULL::bigint AS source_contact_id,
        NULL::bigint AS source_project_id,
        COALESCE(m.data->'id'->>'_serialized', 'whatsapp:' || m.id::text) AS source_ref
      FROM public.messages m
      WHERE m.event IN ('message', 'message_create', 'message_historical')
        AND COALESCE(m.ts, m.created_at) >= $1::timestamptz
        AND COALESCE(m.data->>'body', m.data->>'caption', m.data->>'text', m.data->>'message') IS NOT NULL
      ORDER BY COALESCE(m.ts, m.created_at) DESC
      LIMIT 10000
    `, [cutoff]),
    pool.query(`
      SELECT
        rc.id::text AS source_id,
        rc.subject,
        rc.content_snippet,
        rc.occurred_at,
        rc.created_at,
        rc.contact_id AS source_contact_id,
        NULL::bigint AS source_project_id,
        'relationships.communication:' || rc.id::text AS source_ref
      FROM relationships.communications rc
      WHERE COALESCE(rc.occurred_at, rc.created_at) >= $1::timestamptz
        AND COALESCE(rc.content_snippet, rc.subject, '') <> ''
      ORDER BY COALESCE(rc.occurred_at, rc.created_at) DESC
      LIMIT 10000
    `, [cutoff]),
    pool.query(`
      SELECT
        pc.id::text AS source_id,
        pc.subject,
        pc.content_snippet,
        pc.occurred_at,
        pc.created_at,
        pc.contact_id AS source_contact_id,
        pc.project_id AS source_project_id,
        'projects.project_communication:' || pc.id::text AS source_ref
      FROM projects.project_communications pc
      WHERE COALESCE(pc.occurred_at, pc.created_at) >= $1::timestamptz
        AND COALESCE(pc.content_snippet, pc.subject, '') <> ''
      ORDER BY COALESCE(pc.occurred_at, pc.created_at) DESC
      LIMIT 10000
    `, [cutoff]),
  ])

  return {
    cutoff,
    rows: [
      ...emails.rows.map(row => ({ ...row, source_table: 'email.emails' })),
      ...messages.rows.map(row => ({ ...row, source_table: 'public.messages' })),
      ...comms.rows.map(row => ({ ...row, source_table: 'relationships.communications' })),
      ...projectComms.rows.map(row => ({ ...row, source_table: 'projects.project_communications' })),
    ],
  }
}

async function backfillCommunicationEvents(pool, options = {}) {
  const days = Number.isFinite(Number(options.days)) ? Math.max(1, Math.floor(Number(options.days))) : 30
  const log = typeof options.log === 'function'
    ? options.log
    : (...args) => console.log('[communication-events]', ...args)

  const { rows, cutoff } = await loadCommunicationRows(pool, days)
  log(`Loaded ${rows.length} communication rows since ${cutoff}`)

  const grouped = new Map()
  const sourcePriority = new Map([
    ['email.emails', 0],
    ['public.messages', 1],
    ['relationships.communications', 2],
    ['projects.project_communications', 3],
  ])

  for (const row of rows.sort((a, b) => {
    const left = sourcePriority.get(a.source_table) ?? 99
    const right = sourcePriority.get(b.source_table) ?? 99
    return left - right
  })) {
    const events = extractCommunicationEvents([row], row.source_table)
    for (const event of events) {
      if (!grouped.has(event.event_key)) grouped.set(event.event_key, event)
    }
  }

  let inserted = 0
  let updated = 0
  for (const event of grouped.values()) {
    const { rows: result } = await pool.query(`
      INSERT INTO intelligence.communication_events (
        event_key, event_kind, title, description, communicated_at, starts_at, ends_at,
        source_table, source_id, source_ref, source_contact_id, source_project_id,
        source_subject, source_excerpt, confidence, metadata
      ) VALUES (
        $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz,
        $8, $9, $10, $11, $12,
        $13, $14, $15, $16::jsonb
      )
      ON CONFLICT (event_key) DO UPDATE SET
        event_kind = EXCLUDED.event_kind,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        communicated_at = EXCLUDED.communicated_at,
        starts_at = COALESCE(EXCLUDED.starts_at, intelligence.communication_events.starts_at),
        ends_at = COALESCE(EXCLUDED.ends_at, intelligence.communication_events.ends_at),
        source_table = COALESCE(intelligence.communication_events.source_table, EXCLUDED.source_table),
        source_id = COALESCE(intelligence.communication_events.source_id, EXCLUDED.source_id),
        source_ref = COALESCE(intelligence.communication_events.source_ref, EXCLUDED.source_ref),
        source_contact_id = COALESCE(intelligence.communication_events.source_contact_id, EXCLUDED.source_contact_id),
        source_project_id = COALESCE(intelligence.communication_events.source_project_id, EXCLUDED.source_project_id),
        source_subject = COALESCE(EXCLUDED.source_subject, intelligence.communication_events.source_subject),
        source_excerpt = COALESCE(EXCLUDED.source_excerpt, intelligence.communication_events.source_excerpt),
        confidence = GREATEST(COALESCE(intelligence.communication_events.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
        metadata = intelligence.communication_events.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `, [
      event.event_key,
      event.event_kind,
      event.title,
      event.description,
      event.communicated_at,
      event.starts_at,
      event.ends_at,
      event.source_table,
      event.source_id,
      event.source_ref,
      event.source_contact_id,
      event.source_project_id,
      event.source_subject,
      event.source_excerpt,
      event.confidence,
      JSON.stringify(event.metadata || {}),
    ])
    if (result[0]?.inserted) inserted++
    else updated++
  }

  return { days, cutoff, rows_examined: rows.length, events_seen: grouped.size, inserted, updated }
}

module.exports = {
  backfillCommunicationEvents,
  extractCommunicationEvents,
  extractStartsAt,
  extractTitle,
  inferKind,
  loadCommunicationRows,
  sourceRefFor,
}
