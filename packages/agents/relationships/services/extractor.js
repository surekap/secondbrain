'use strict'

const db = require('@secondbrain/db')

const MY_WA_JID = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID || '__missing_whatsapp_self_jid__'

if (MY_WA_JID === '__missing_whatsapp_self_jid__') {
  console.warn('WHATSAPP_SELF_JID or MY_WA_JID is not configured; self-message exclusion may be incomplete.')
}

/**
 * Get distinct direct chat contacts from WhatsApp messages.
 * Returns contacts with message stats and best display name.
 */
async function extractDirectChatContacts() {
  try {
    const { rows } = await db.query(`
      SELECT
        chat_id,
        COUNT(*) AS msg_count,
        COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = true)  AS my_msgs,
        COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = false) AS their_msgs,
        MAX(ts) AS last_msg_at,
        MIN(ts) AS first_msg_at,
        COALESCE(
          -- Prefer address-book name from chat_metadata (set by whatsapp-web-connector)
          NULLIF((SELECT cm.name FROM public.chat_metadata cm
                  WHERE cm.chat_id = m.chat_id
                    AND cm.name IS NOT NULL
                    AND cm.name NOT LIKE '+%'
                    AND cm.name NOT LIKE '%@%'
                  LIMIT 1), ''),
          -- Fall back to push name from messages
          (SELECT m2.data->'_data'->>'notifyName'
           FROM public.messages m2
           WHERE m2.chat_id = m.chat_id
             AND m2.data->'_data'->>'notifyName' IS NOT NULL
             AND m2.data->'_data'->>'notifyName' != ''
           GROUP BY m2.data->'_data'->>'notifyName'
           ORDER BY COUNT(*) DESC
           LIMIT 1)
        ) AS display_name
      FROM public.messages m
      WHERE chat_id LIKE '%@c.us'
        AND chat_id != $1
        AND chat_id != 'status@broadcast'
        AND event IN ('message', 'message_create', 'message_historical')
      GROUP BY chat_id
      HAVING COUNT(*) >= 2
      ORDER BY MAX(ts) DESC
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
      SELECT
        (data->'id'->>'fromMe')::boolean  AS from_me,
        data->>'body'                      AS body,
        msg_type,
        data->'_data'->>'caption'          AS caption,
        data->'_data'->>'filename'         AS filename,
        ts,
        data->'_data'->>'notifyName'       AS notify_name,
        data->'id'->>'_serialized'         AS wa_msg_id
      FROM public.messages
      WHERE chat_id = $1
        AND event IN ('message', 'message_create', 'message_historical')
        AND data->>'body' IS NOT NULL
        AND data->>'body' != ''
      ORDER BY ts DESC
      LIMIT $2
    `, [chatId, limit])
    return rows
  } catch (err) {
    console.error('[extractor] getDirectMessages error:', err.message)
    return []
  }
}

/**
 * Get distinct group chats with message stats.
 */
async function extractGroupChats() {
  try {
    const { rows } = await db.query(`
      SELECT
        chat_id,
        COUNT(*) AS msg_count,
        COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = true)  AS my_msgs,
        COUNT(*) FILTER (WHERE (data->'id'->>'fromMe')::boolean = false) AS their_msgs,
        MAX(ts) AS last_msg_at,
        MIN(ts) AS first_msg_at
      FROM public.messages
      WHERE chat_id LIKE '%@g.us'
        AND event IN ('message', 'message_create', 'message_historical')
      GROUP BY chat_id
      ORDER BY MAX(ts) DESC
    `)
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
        (data->'id'->>'fromMe')::boolean AS from_me,
        data->>'body'                     AS body,
        ts,
        data->'_data'->>'notifyName'      AS notify_name,
        data->>'author'                   AS author_raw,
        data->'id'->>'participant'        AS participant,
        data->'id'->>'_serialized'        AS wa_msg_id
      FROM public.messages
      WHERE chat_id = $1
        AND event IN ('message', 'message_create', 'message_historical')
        AND data->>'body' IS NOT NULL
        AND data->>'body' != ''
      ORDER BY ts DESC
      LIMIT $2
    `, [groupChatId, limit])
    return rows
  } catch (err) {
    console.error('[extractor] getGroupSampleMessages error:', err.message)
    return []
  }
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

/**
 * Get email contacts grouped by from_address with parsed name/email.
 * Also returns unread count per sender.
 * Handles empty table gracefully.
 */
async function getEmailContacts() {
  try {
    const { rows } = await db.query(`
      SELECT
        from_address,
        COUNT(*)                                       AS email_count,
        COUNT(*) FILTER (WHERE is_read = false)        AS unread_count,
        MAX(date)                                      AS last_email_at,
        MIN(date)                                      AS first_email_at,
        ARRAY_AGG(DISTINCT subject ORDER BY subject)
          FILTER (WHERE subject IS NOT NULL)           AS subjects
      FROM email.emails
      WHERE from_address IS NOT NULL
        AND from_address != ''
      GROUP BY from_address
      ORDER BY MAX(date) DESC
    `)
    return rows.map(r => ({ ...r, ...parseEmailAddress(r.from_address) }))
  } catch (err) {
    return []
  }
}

/**
 * Get individual emails for a specific sender address.
 */
async function getEmailsBySender(fromAddress, limit = 20) {
  try {
    const { rows } = await db.query(`
      SELECT id, subject, date, is_read, body_text, to_addresses, attachments
      FROM email.emails
      WHERE from_address = $1
      ORDER BY date DESC
      LIMIT $2
    `, [fromAddress, limit])
    return rows
  } catch (err) {
    return []
  }
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
    const { rows: waDMs } = await db.query(`
      SELECT
        m.ts,
        COALESCE(cm.name, m.data->'_data'->>'notifyName', m.chat_id) AS contact_name,
        (m.data->'id'->>'fromMe')::boolean AS from_me,
        m.data->>'body' AS body
      FROM public.messages m
      LEFT JOIN public.chat_metadata cm ON cm.chat_id = m.chat_id
      WHERE m.chat_id LIKE '%@c.us'
        AND m.chat_id != $1
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
    const { rows: waGroups } = await db.query(`
      SELECT
        m.ts,
        COALESCE(cm.name, m.chat_id) AS group_name,
        m.data->'_data'->>'notifyName' AS sender_name,
        (m.data->'id'->>'fromMe')::boolean AS from_me,
        m.data->>'body' AS body
      FROM public.messages m
      LEFT JOIN public.chat_metadata cm ON cm.chat_id = m.chat_id
      WHERE m.chat_id LIKE '%@g.us'
        AND m.event IN ('message','message_create','message_historical')
        AND m.ts > $1
        AND m.data->>'body' IS NOT NULL
        AND length(m.data->>'body') > 5
        AND m.data->>'body' NOT LIKE '/9j/%'
      ORDER BY m.ts DESC
      LIMIT 300
    `, [cutoff])

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
  extractDirectChatContacts,
  getDirectMessages,
  extractGroupChats,
  getGroupSampleMessages,
  getGroupName,
  extractLimitlessConversations,
  getEmailContacts,
  getEmailsBySender,
  buildCrossSourceDigest,
}
