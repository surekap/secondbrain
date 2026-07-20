'use strict'

const db = require('@secondbrain/db')
const {
  canonicalWhatsAppChatIdSql,
} = require('../../shared/whatsapp-chat')

const MY_WA_JID = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID || '__missing_whatsapp_self_jid__'

if (MY_WA_JID === '__missing_whatsapp_self_jid__') {
  console.warn('WHATSAPP_SELF_JID or MY_WA_JID is not configured; self-message exclusion may be incomplete.')
}

function canonicalChatSql(alias, selfExpression) {
  return canonicalWhatsAppChatIdSql({
    dataExpression: `${alias}.data`,
    storedChatExpression: `${alias}.chat_id`,
    selfExpression,
  })
}

function nativeWaIdSql(alias) {
  return `COALESCE(NULLIF(${alias}.wa_msg_id, ''), NULLIF(${alias}.data->'id'->>'_serialized', ''))`
}

/**
 * Get distinct direct chat contacts from WhatsApp messages.
 * Returns contacts with message stats and best display name.
 */
async function extractDirectChatContacts() {
  try {
    const chatSql = canonicalChatSql('raw', '$1')
    const { rows } = await db.query(`
      WITH messages AS MATERIALIZED (
        SELECT raw.*, ${chatSql} AS canonical_chat_id
        FROM public.messages raw
        WHERE raw.event IN ('message', 'message_create', 'message_historical')
      ), direct_messages AS MATERIALIZED (
        SELECT * FROM messages WHERE canonical_chat_id LIKE '%@c.us'
      ), stats AS (
        SELECT canonical_chat_id,
               COUNT(*) AS msg_count,
               COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = true) AS my_msgs,
               COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = false) AS their_msgs,
               MAX(ts) AS last_msg_at,
               MIN(ts) AS first_msg_at
        FROM direct_messages
        GROUP BY canonical_chat_id
        HAVING COUNT(*) >= 2
      ), notify_counts AS (
        SELECT canonical_chat_id,
               data->'_data'->>'notifyName' AS notify_name,
               COUNT(*) AS uses
        FROM direct_messages
        WHERE NULLIF(data->'_data'->>'notifyName', '') IS NOT NULL
        GROUP BY canonical_chat_id, data->'_data'->>'notifyName'
      ), best_notify_name AS (
        SELECT DISTINCT ON (canonical_chat_id) canonical_chat_id, notify_name
        FROM notify_counts
        ORDER BY canonical_chat_id, uses DESC, notify_name ASC
      )
      SELECT
        stats.canonical_chat_id AS chat_id,
        stats.msg_count,
        stats.my_msgs,
        stats.their_msgs,
        stats.last_msg_at,
        stats.first_msg_at,
        COALESCE(
          CASE WHEN metadata.name NOT LIKE '+%' AND metadata.name NOT LIKE '%@%' THEN NULLIF(metadata.name, '') END,
          best.notify_name
        ) AS display_name
      FROM stats
      LEFT JOIN public.chat_metadata metadata ON metadata.chat_id = stats.canonical_chat_id
      LEFT JOIN best_notify_name best ON best.canonical_chat_id = stats.canonical_chat_id
      ORDER BY stats.last_msg_at DESC
    `, [MY_WA_JID])
    return rows
  } catch (err) {
    console.error('[extractor] extractDirectChatContacts error:', err.message)
    return []
  }
}

/**
 * Get recent messages for a specific direct chat.
 * Returns msg_type, caption, filename alongside body so callers can
 * distinguish text from media (image/video/document/location/ptt).
 */
async function getDirectMessages(chatId, limit = 30) {
  try {
    const { rows } = await db.query(`
      WITH messages AS (
        SELECT raw.*, ${canonicalChatSql('raw', '$3')} AS canonical_chat_id
        FROM public.messages raw
        WHERE raw.event IN ('message', 'message_create', 'message_historical')
      )
      SELECT
        (data->'id'->>'fromMe')::boolean  AS from_me,
        data->>'body'                      AS body,
        msg_type,
        data->'_data'->>'caption'          AS caption,
        data->'_data'->>'filename'         AS filename,
        ts,
        data->'_data'->>'notifyName'       AS notify_name,
        data->'id'->>'_serialized'         AS wa_msg_id,
        media.semantic_text,
        media.extracted_text,
        media.analysis_kind
      FROM messages
      LEFT JOIN LATERAL (
        SELECT mf.semantic_text, mf.extracted_text, mf.analysis_kind
        FROM public.media_files mf
        WHERE mf.wa_msg_id = ${nativeWaIdSql('messages')}
        ORDER BY mf.analyzed_at DESC NULLS LAST, mf.id DESC
        LIMIT 1
      ) media ON TRUE
      WHERE canonical_chat_id = $1
        AND (
          NULLIF(data->>'body', '') IS NOT NULL
          OR NULLIF(media.semantic_text, '') IS NOT NULL
          OR NULLIF(media.extracted_text, '') IS NOT NULL
        )
      ORDER BY ts DESC
      LIMIT $2
    `, [chatId, limit, MY_WA_JID])
    return rows
  } catch (err) {
    console.error('[extractor] getDirectMessages error:', err.message)
    return []
  }
}

async function getUnstoredDirectMessages(limit = 1000) {
  try {
    const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000)
    const chatSql = canonicalChatSql('m', '$1')
    const { rows } = await db.query(`
      SELECT
        chat.chat_id,
        (m.data->'id'->>'fromMe')::boolean AS from_me,
        m.data->>'body' AS body,
        m.msg_type,
        m.data->'_data'->>'caption' AS caption,
        m.data->'_data'->>'filename' AS filename,
        m.ts,
        m.data->'_data'->>'notifyName' AS notify_name,
        ${nativeWaIdSql('m')} AS wa_msg_id,
        media.semantic_text,
        media.extracted_text,
        media.analysis_kind
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
      LEFT JOIN LATERAL (
        SELECT mf.semantic_text, mf.extracted_text, mf.analysis_kind
        FROM public.media_files mf
        WHERE mf.wa_msg_id = ${nativeWaIdSql('m')}
        ORDER BY mf.analyzed_at DESC NULLS LAST, mf.id DESC
        LIMIT 1
      ) media ON TRUE
      WHERE (chat.chat_id LIKE '%@c.us' OR chat.chat_id LIKE '%@lid')
        AND m.event IN ('message', 'message_create', 'message_historical')
        AND ${nativeWaIdSql('m')} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM relationships.communications c
          WHERE c.source = 'whatsapp'
            AND c.source_id = 'wa:' || (${nativeWaIdSql('m')})
        )
      ORDER BY m.ts ASC, ${nativeWaIdSql('m')} ASC
      LIMIT $2
    `, [MY_WA_JID, safeLimit])
    return rows
  } catch (err) {
    console.error('[extractor] getUnstoredDirectMessages error:', err.message)
    return []
  }
}

async function getWhatsAppRecoveryPage(afterId = 0, limit = 1000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000)
  const cursor = Math.max(Number(afterId) || 0, 0)
  const chatSql = canonicalChatSql('m', '$2')
  const { rows } = await db.query(`
    SELECT
      m.id AS source_row_id,
      chat.chat_id,
      (chat.chat_id LIKE '%@g.us') AS is_group,
      COALESCE(cm.name, chat.chat_id) AS group_name,
      (m.data->'id'->>'fromMe')::boolean AS from_me,
      m.data->>'body' AS body,
      m.msg_type,
      m.data->'_data'->>'caption' AS caption,
      m.data->'_data'->>'filename' AS filename,
      m.ts,
      m.data->'_data'->>'notifyName' AS notify_name,
      m.data->>'author' AS author_raw,
      m.data->'id'->>'participant' AS participant,
      ${nativeWaIdSql('m')} AS wa_msg_id,
      media.semantic_text,
      media.extracted_text,
      media.analysis_kind
    FROM public.messages m
    CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
    LEFT JOIN public.chat_metadata cm ON cm.chat_id = chat.chat_id
    LEFT JOIN LATERAL (
      SELECT mf.semantic_text, mf.extracted_text, mf.analysis_kind
      FROM public.media_files mf
      WHERE mf.wa_msg_id = ${nativeWaIdSql('m')}
      ORDER BY mf.analyzed_at DESC NULLS LAST, mf.id DESC
      LIMIT 1
    ) media ON TRUE
    WHERE m.id > $1
      AND chat.chat_id IS NOT NULL
      AND m.event IN ('message', 'message_create', 'message_historical')
    ORDER BY m.id ASC
    LIMIT $3
  `, [cursor, MY_WA_JID, safeLimit])
  return rows
}

/**
 * Media analysis completes asynchronously after the canonical message may have
 * been inserted. Return a bounded set whose latest semantic text is absent or
 * stale in the canonical ledger so normal scheduled runs continuously converge.
 */
async function getStaleMediaCommunications(limit = 500) {
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000)
  const chatSql = canonicalChatSql('m', '$1')
  const { rows } = await db.query(`
    SELECT
      m.id AS source_row_id,
      chat.chat_id,
      (chat.chat_id LIKE '%@g.us') AS is_group,
      COALESCE(cm.name, chat.chat_id) AS group_name,
      (m.data->'id'->>'fromMe')::boolean AS from_me,
      m.data->>'body' AS body,
      m.msg_type,
      m.data->'_data'->>'caption' AS caption,
      m.data->'_data'->>'filename' AS filename,
      m.ts,
      m.data->'_data'->>'notifyName' AS notify_name,
      m.data->>'author' AS author_raw,
      m.data->'id'->>'participant' AS participant,
      ${nativeWaIdSql('m')} AS wa_msg_id,
      media.semantic_text,
      media.extracted_text,
      media.analysis_kind
    FROM public.messages m
    CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
    JOIN relationships.communications c
      ON c.source = 'whatsapp'
     AND c.source_id = 'wa:' || (${nativeWaIdSql('m')})
    LEFT JOIN public.chat_metadata cm ON cm.chat_id = chat.chat_id
    JOIN LATERAL (
      SELECT mf.semantic_text, mf.extracted_text, mf.analysis_kind, mf.analyzed_at, mf.id
      FROM public.media_files mf
      WHERE mf.wa_msg_id = ${nativeWaIdSql('m')}
        AND COALESCE(NULLIF(mf.semantic_text, ''), NULLIF(mf.extracted_text, '')) IS NOT NULL
      ORDER BY mf.analyzed_at DESC NULLS LAST, mf.id DESC
      LIMIT 1
    ) media ON TRUE
    WHERE chat.chat_id IS NOT NULL
      AND m.event IN ('message', 'message_create', 'message_historical')
      AND COALESCE(c.metadata->>'media_semantic_text', '') IS DISTINCT FROM
          LEFT(BTRIM(REGEXP_REPLACE(
            COALESCE(NULLIF(media.semantic_text, ''), media.extracted_text),
            '[[:space:]]+', ' ', 'g'
          )), 4000)
    ORDER BY media.analyzed_at ASC NULLS FIRST, m.id ASC
    LIMIT $2
  `, [MY_WA_JID, safeLimit])
  return rows
}

/**
 * Get distinct group chats with message stats.
 */
async function extractGroupChats() {
  try {
    const chatSql = canonicalChatSql('m', '$1')
    const { rows } = await db.query(`
      SELECT
        chat.chat_id,
        COUNT(*) AS msg_count,
        COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = true)  AS my_msgs,
        COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = false) AS their_msgs,
        MAX(ts) AS last_msg_at,
        MIN(ts) AS first_msg_at
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
      WHERE chat.chat_id LIKE '%@g.us'
        AND m.event IN ('message', 'message_create', 'message_historical')
      GROUP BY chat.chat_id
      ORDER BY MAX(ts) DESC
    `, [MY_WA_JID])
    return rows
  } catch (err) {
    console.error('[extractor] extractGroupChats error:', err.message)
    return []
  }
}

/**
 * Get sample recent messages for a group chat.
 */
async function getGroupSampleMessages(groupChatId, limit = 15) {
  try {
    const { rows } = await db.query(`
      SELECT
        direction = 'outbound' AS from_me,
        content_snippet AS body,
        occurred_at AS ts,
        metadata->>'author_name' AS notify_name,
        metadata->>'author_jid' AS participant,
        source_id,
        id AS communication_id
      FROM relationships.communications
      WHERE source = 'whatsapp'
        AND is_group = TRUE
        AND chat_id = $1
        AND NULLIF(content_snippet, '') IS NOT NULL
        AND COALESCE(metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
      ORDER BY occurred_at DESC
      LIMIT $2
    `, [groupChatId, limit])
    return rows
  } catch (err) {
    console.error('[extractor] getGroupSampleMessages error:', err.message)
    return []
  }
}

/**
 * Return a bounded batch of durable group events not yet copied into the
 * canonical relationship communication ledger. Repeated runs converge without
 * rescanning already-stored history.
 */
async function queryUnstoredGroupMessages(groupChatId, limit) {
  try {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 10000)
    const chatSql = canonicalChatSql('m', '$3')
    const { rows } = await db.query(`
      SELECT
        chat.chat_id,
        (m.data->'id'->>'fromMe')::boolean AS from_me,
        m.data->>'body' AS body,
        m.msg_type,
        m.data->'_data'->>'caption' AS caption,
        m.data->'_data'->>'filename' AS filename,
        m.ts,
        m.data->'_data'->>'notifyName' AS notify_name,
        m.data->>'author' AS author_raw,
        m.data->'id'->>'participant' AS participant,
        ${nativeWaIdSql('m')} AS wa_msg_id,
        media.semantic_text,
        media.extracted_text,
        media.analysis_kind
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
      LEFT JOIN LATERAL (
        SELECT mf.semantic_text, mf.extracted_text, mf.analysis_kind
        FROM public.media_files mf
        WHERE mf.wa_msg_id = ${nativeWaIdSql('m')}
        ORDER BY mf.analyzed_at DESC NULLS LAST, mf.id DESC
        LIMIT 1
      ) media ON TRUE
      WHERE ($1::text IS NULL OR chat.chat_id = $1)
        AND chat.chat_id LIKE '%@g.us'
        AND m.event IN ('message', 'message_create', 'message_historical')
        AND ${nativeWaIdSql('m')} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM relationships.communications c
          WHERE c.source = 'whatsapp'
            AND c.source_id = 'wa:' || (${nativeWaIdSql('m')})
        )
      ORDER BY m.ts ASC
      LIMIT $2
    `, [groupChatId, safeLimit, MY_WA_JID])
    return rows
  } catch (err) {
    console.error('[extractor] queryUnstoredGroupMessages error:', err.message)
    return []
  }
}

async function getUnstoredGroupMessages(groupChatId, limit = 500) {
  return queryUnstoredGroupMessages(groupChatId, Math.min(Number(limit) || 500, 2000))
}

async function getUnstoredGroupMessagesBatch(limit = 5000) {
  return queryUnstoredGroupMessages(null, limit)
}

/**
 * Try to get the group name, checking chat_metadata first then group_update events.
 */
async function getGroupName(groupChatId) {
  try {
    // First try chat_metadata table (populated by whatsapp-web-connector)
    const { rows: meta } = await db.query(
      'SELECT name FROM public.chat_metadata WHERE chat_id = $1 AND name IS NOT NULL LIMIT 1',
      [groupChatId]
    )
    if (meta.length > 0 && meta[0].name) return meta[0].name

    // Fallback: group_update events with subject
    const { rows } = await db.query(`
      SELECT COALESCE(data->>'subject', data->'body'->>'subject') AS group_name
      FROM public.messages
      WHERE chat_id = $1
        AND event = 'group_update'
        AND (data->>'subject' IS NOT NULL OR data->'body'->>'subject' IS NOT NULL)
      ORDER BY ts DESC LIMIT 1
    `, [groupChatId])
    if (rows.length > 0 && rows[0].group_name) return rows[0].group_name

    return null
  } catch (err) {
    console.error('[extractor] getGroupName error:', err.message)
    return null
  }
}

/**
 * Get recent lifelogs from Limitless data.
 */
async function extractLimitlessConversations(limit = 100) {
  try {
    const { rows } = await db.query(`
      SELECT
        id,
        title,
        start_time,
        end_time,
        LEFT(markdown, 800) AS markdown_preview
      FROM limitless.lifelogs
      WHERE markdown IS NOT NULL AND markdown != ''
      ORDER BY start_time DESC
      LIMIT $1
    `, [limit])
    return rows
  } catch (err) {
    console.error('[extractor] extractLimitlessConversations error:', err.message)
    return []
  }
}

async function getUnstoredLimitlessConversations(limit = 500) {
  try {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000)
    const { rows } = await db.query(`
      SELECT id, title, start_time, end_time, LEFT(markdown, 4000) AS markdown_preview
      FROM limitless.lifelogs l
      WHERE l.markdown IS NOT NULL AND l.markdown != ''
        AND NOT EXISTS (
          SELECT 1 FROM relationships.communications c
          WHERE c.source = 'limitless' AND c.source_id = 'limitless:' || l.id::text
        )
      ORDER BY l.start_time ASC
      LIMIT $1
    `, [safeLimit])
    return rows
  } catch (err) {
    console.error('[extractor] getUnstoredLimitlessConversations error:', err.message)
    return []
  }
}

async function getLimitlessRecoveryPage(afterId = '', limit = 1000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000)
  const { rows } = await db.query(`
    SELECT id AS source_row_id, id, title, start_time, end_time, created_at,
           LEFT(COALESCE(NULLIF(markdown, ''), NULLIF(contents, ''), title), 4000) AS markdown_preview
    FROM limitless.lifelogs
    WHERE id > $1
      AND COALESCE(NULLIF(markdown, ''), NULLIF(contents, ''), NULLIF(title, '')) IS NOT NULL
    ORDER BY id ASC
    LIMIT $2
  `, [String(afterId || ''), safeLimit])
  return rows
}

/**
 * Parse a raw email address like '"Name" <email>' into {name, email}.
 */
function parseEmailAddress(raw) {
  if (!raw) return { name: null, email: null }
  const match = raw.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/)
  if (match) {
    return { name: match[1].trim(), email: match[2].trim().toLowerCase() }
  }
  const emailOnly = raw.match(/^[\w.+\-]+@[\w.\-]+$/)
  if (emailOnly) return { name: null, email: raw.trim().toLowerCase() }
  return { name: null, email: raw.trim().toLowerCase() }
}

function normalizeEmailSenderRow(row = {}) {
  const rawAddress = row.from_address || row.raw_address || null
  return {
    ...row,
    from_address: rawAddress,
    raw_address: rawAddress,
    ...parseEmailAddress(rawAddress),
  }
}

/**
 * Get email contacts grouped by from_address with parsed name/email.
 * Also returns unread count per sender.
 * Handles empty table gracefully.
 */
async function getEmailContacts() {
  try {
    const { rows } = await db.query(`
      SELECT
        e.from_address,
        COUNT(*)                                       AS email_count,
        COUNT(*) FILTER (WHERE is_read = false)        AS unread_count,
        MAX(date)                                      AS last_email_at,
        MIN(date)                                      AS first_email_at,
        EXISTS (
          SELECT 1 FROM relationships.email_senders es
          WHERE es.raw_address = e.from_address
        ) AS is_registered,
        EXISTS (
          SELECT 1 FROM relationships.email_senders es
          WHERE es.raw_address = e.from_address AND es.contact_id IS NOT NULL
        ) AS is_linked,
        COALESCE((
          SELECT es.is_noise FROM relationships.email_senders es
          WHERE es.raw_address = e.from_address
          LIMIT 1
        ), false) AS registry_is_noise,
        ARRAY_AGG(DISTINCT subject ORDER BY subject)
          FILTER (WHERE subject IS NOT NULL)           AS subjects
      FROM email.emails e
      WHERE e.from_address IS NOT NULL
        AND e.from_address != ''
      GROUP BY e.from_address
      ORDER BY MAX(date) DESC
    `)
    return rows.map(normalizeEmailSenderRow)
  } catch (err) {
    console.error('[extractor] getEmailContacts error:', err.message)
    return []
  }
}

/**
 * Get individual emails for a specific sender address.
 */
async function getEmailsBySender(fromAddress, limit = 20) {
  try {
    const { rows } = await db.query(`
      SELECT id, subject, COALESCE(date, received_at, created_at) AS date,
             is_read, body_text, to_addresses, attachments
      FROM email.emails
      WHERE from_address = $1
      ORDER BY date DESC
      LIMIT $2
    `, [fromAddress, limit])
    return rows
  } catch (err) {
    console.error('[extractor] getEmailsBySender error:', err.message)
    return []
  }
}

async function getUnstoredEmailCommunications(limit = 1000) {
  try {
    const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000)
    const { rows } = await db.query(`
      SELECT e.id, e.account_id, account.email AS account_email, e.message_id,
             e.gmail_uid, e.thread_id, e.subject, e.date, e.received_at,
             e.created_at, e.is_read, e.body_text, e.to_addresses,
             e.cc_addresses, e.bcc_addresses, e.reply_to, e.labels,
             e.attachments, e.from_address, es.contact_id,
             es.parsed_name AS sender_name, es.parsed_email AS sender_email,
             es.is_noise AS sender_is_noise
      FROM email.emails e
      JOIN email.accounts account ON account.id = e.account_id
      LEFT JOIN relationships.email_senders es ON es.raw_address = e.from_address
      WHERE NOT EXISTS (
        SELECT 1 FROM relationships.communications c
        WHERE c.source = 'email' AND c.source_id = 'email:' || e.id::text
      )
      ORDER BY e.date ASC, e.id ASC
      LIMIT $1
    `, [safeLimit])
    return rows.map(row => ({
      ...row,
      date: row.date || row.received_at || row.created_at,
    }))
  } catch (err) {
    console.error('[extractor] getUnstoredEmailCommunications error:', err.message)
    return []
  }
}

async function getEmailRecoveryPage(afterId = 0, limit = 1000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000)
  const cursor = Math.max(Number(afterId) || 0, 0)
  const { rows } = await db.query(`
    SELECT e.id AS source_row_id, e.id, e.account_id,
           account.email AS account_email, e.message_id, e.gmail_uid,
           e.thread_id, e.subject, e.date, e.received_at,
           e.created_at, e.is_read, e.body_text, e.to_addresses,
           e.cc_addresses, e.bcc_addresses, e.reply_to, e.labels,
           e.attachments, e.from_address, es.contact_id,
           es.parsed_name AS sender_name, es.parsed_email AS sender_email,
           es.is_noise AS sender_is_noise
    FROM email.emails e
    JOIN email.accounts account ON account.id = e.account_id
    LEFT JOIN relationships.email_senders es ON es.raw_address = e.from_address
    WHERE e.id > $1
    ORDER BY e.id ASC
    LIMIT $2
  `, [cursor, safeLimit])
  return rows.map(row => ({
    ...row,
    date: row.date || row.received_at || row.created_at,
  }))
}

/**
 * Build a timestamped cross-source digest of recent communications.
 * Used by the cross-source opportunity swarm agents.
 *
 * @param {Date|null} since - only include messages after this date (default: 30 days ago)
 * @returns {string} formatted digest, truncated to ~8000 tokens (~32000 chars)
 */
async function buildCrossSourceDigest(since) {
  const cutoff = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const lines = []

  try {
    // WhatsApp DMs
    const directChatSql = canonicalChatSql('m', '$1')
    const { rows: waDMs } = await db.query(`
      SELECT
        m.ts,
        COALESCE(cm.name, m.data->'_data'->>'notifyName', chat.chat_id) AS contact_name,
        (m.data->'id'->>'fromMe')::boolean AS from_me,
        m.data->>'body' AS body
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${directChatSql} AS chat_id) chat
      LEFT JOIN public.chat_metadata cm ON cm.chat_id = chat.chat_id
      WHERE (chat.chat_id LIKE '%@c.us' OR chat.chat_id LIKE '%@lid')
        AND m.event IN ('message','message_create','message_historical')
        AND m.ts > $2
        AND m.data->>'body' IS NOT NULL
        AND length(m.data->>'body') > 5
        AND m.data->>'body' NOT LIKE '/9j/%'
      ORDER BY m.ts DESC
      LIMIT 200
    `, [MY_WA_JID, cutoff])

    for (const r of waDMs) {
      const who = r.from_me ? 'Me → ' + r.contact_name : r.contact_name + ' → Me'
      const date = r.ts ? new Date(r.ts).toLocaleDateString('en-GB') : ''
      lines.push({ ts: r.ts, text: `[WhatsApp DM/${r.contact_name}, ${date}] ${who}: ${(r.body || '').slice(0, 200)}` })
    }

    // WhatsApp groups
    const groupChatSql = canonicalChatSql('m', '$2')
    const { rows: waGroups } = await db.query(`
      SELECT
        m.ts,
        COALESCE(cm.name, chat.chat_id) AS group_name,
        m.data->'_data'->>'notifyName' AS sender_name,
        (m.data->'id'->>'fromMe')::boolean AS from_me,
        m.data->>'body' AS body
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${groupChatSql} AS chat_id) chat
      LEFT JOIN public.chat_metadata cm ON cm.chat_id = chat.chat_id
      WHERE chat.chat_id LIKE '%@g.us'
        AND m.event IN ('message','message_create','message_historical')
        AND m.ts > $1
        AND m.data->>'body' IS NOT NULL
        AND length(m.data->>'body') > 5
        AND m.data->>'body' NOT LIKE '/9j/%'
      ORDER BY m.ts DESC
      LIMIT 300
    `, [cutoff, MY_WA_JID])

    for (const r of waGroups) {
      const sender = r.from_me ? 'Me' : (r.sender_name || 'Unknown')
      const date = r.ts ? new Date(r.ts).toLocaleDateString('en-GB') : ''
      lines.push({ ts: r.ts, text: `[Group/${r.group_name}, ${date}] ${sender}: ${(r.body || '').slice(0, 200)}` })
    }

    // Emails
    const { rows: emails } = await db.query(`
      SELECT e.date AS ts, e.from_address, e.subject, e.body_text
      FROM email.emails e
      WHERE e.date > $1
        AND e.body_text IS NOT NULL
      ORDER BY e.date DESC
      LIMIT 100
    `, [cutoff])

    for (const r of emails) {
      const date = r.ts ? new Date(r.ts).toLocaleDateString('en-GB') : ''
      const snippet = (r.body_text || '').replace(/\s+/g, ' ').slice(0, 150)
      lines.push({ ts: r.ts, text: `[Email/${r.from_address}, ${date}] Subject: ${r.subject || '(none)'} — ${snippet}` })
    }

    // Limitless lifelogs
    const { rows: lifelogs } = await db.query(`
      SELECT id, title, start_time AS ts, markdown
      FROM limitless.lifelogs
      WHERE start_time > $1
        AND markdown IS NOT NULL
        AND length(markdown) > 100
      ORDER BY start_time DESC
      LIMIT 20
    `, [cutoff])

    for (const r of lifelogs) {
      const date = r.ts ? new Date(r.ts).toLocaleDateString('en-GB') : ''
      const snippet = (r.markdown || '').slice(0, 400).replace(/\n+/g, ' ')
      lines.push({ ts: r.ts, text: `[Limitless/${r.title || r.id}, ${date}] ${snippet}` })
    }

  } catch (err) {
    console.error('[extractor] buildCrossSourceDigest error:', err.message)
  }

  // Sort by timestamp descending, build string, truncate to ~32000 chars (~8000 tokens)
  lines.sort((a, b) => new Date(b.ts) - new Date(a.ts))
  const digest = lines.map(l => l.text).join('\n')
  return digest.slice(0, 32000)
}

module.exports = {
  MY_WA_JID,
  parseEmailAddress,
  normalizeEmailSenderRow,
  extractDirectChatContacts,
  getDirectMessages,
  getUnstoredDirectMessages,
  getWhatsAppRecoveryPage,
  getStaleMediaCommunications,
  extractGroupChats,
  getGroupSampleMessages,
  getUnstoredGroupMessages,
  getUnstoredGroupMessagesBatch,
  getGroupName,
  extractLimitlessConversations,
  getUnstoredLimitlessConversations,
  getLimitlessRecoveryPage,
  getEmailContacts,
  getEmailsBySender,
  getUnstoredEmailCommunications,
  getEmailRecoveryPage,
  buildCrossSourceDigest,
}
