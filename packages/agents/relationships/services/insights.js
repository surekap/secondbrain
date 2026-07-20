'use strict'

const db = require('@secondbrain/db')
const { MY_WA_JID } = require('./extractor')

/**
 * Find direct WhatsApp chats where the last message was inbound
 * and has not been replied to within 2 hours, up to 30 days ago.
 */
async function findAwaitingReplyContacts() {
  try {
    const { rows } = await db.query(`
      WITH last_msgs AS (
        SELECT DISTINCT ON (chat_id)
          rc.chat_id,
          rc.source_id,
          rc.direction,
          rc.content_snippet AS body,
          rc.occurred_at AS ts,
          c.display_name
        FROM relationships.communications rc
        LEFT JOIN relationships.contacts c ON c.id = rc.contact_id
        WHERE rc.source = 'whatsapp'
          AND rc.is_group = FALSE
          AND rc.chat_id LIKE '%@c.us'
          AND chat_id != $1
          AND chat_id != 'status@broadcast'
          AND NULLIF(rc.content_snippet, '') IS NOT NULL
          AND COALESCE(rc.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
        ORDER BY rc.chat_id, rc.occurred_at DESC
      )
      SELECT
        chat_id,
        source_id,
        body   AS last_msg_body,
        ts     AS last_msg_at,
        display_name
      FROM last_msgs
      WHERE direction = 'inbound'
        AND ts < NOW() - INTERVAL '2 hours'
        AND ts > NOW() - INTERVAL '30 days'
      ORDER BY ts DESC
    `, [MY_WA_JID])
    return rows
  } catch (err) {
    console.error('[insights] findAwaitingReplyContacts error:', err.message)
    return []
  }
}

/**
 * Find group chats with activity in the last 7 days
 * where I haven't sent any messages and there are > 3 messages from others.
 */
async function findActiveGroupsNotParticipating() {
  try {
    const { rows } = await db.query(`
      SELECT
        chat_id,
        COUNT(*) FILTER (WHERE direction = 'inbound') AS their_msgs,
        MAX(occurred_at) AS last_msg_at,
        (ARRAY_AGG(source_id ORDER BY occurred_at DESC)
          FILTER (WHERE direction = 'inbound'))[1:5] AS source_refs,
        JSONB_AGG(JSONB_BUILD_OBJECT(
          'body', content_snippet,
          'ts', occurred_at,
          'notify_name', metadata->>'author_name'
        ) ORDER BY occurred_at DESC) FILTER (WHERE direction = 'inbound') AS sample_msgs
      FROM relationships.communications
      WHERE source = 'whatsapp'
        AND is_group = TRUE
        AND chat_id LIKE '%@g.us'
        AND occurred_at > NOW() - INTERVAL '7 days'
        AND COALESCE(metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
      GROUP BY chat_id
      HAVING
        COUNT(*) FILTER (WHERE direction = 'outbound') = 0
        AND COUNT(*) FILTER (WHERE direction = 'inbound') > 3
      ORDER BY MAX(occurred_at) DESC
    `)
    return rows.map(row => ({ ...row, sample_msgs: (row.sample_msgs || []).slice(0, 5) }))
  } catch (err) {
    console.error('[insights] findActiveGroupsNotParticipating error:', err.message)
    return []
  }
}

/**
 * Find unread inbound emails from likely-human senders (not automated services).
 * Since thread_id is NULL in this dataset, we use is_read=false as the primary signal,
 * and filter out noise senders (noreply, alerts, notifications, etc.)
 */
async function findColdEmailsNotReplied() {
  try {
    const { rows } = await db.query(`
      SELECT
        e.id,
        e.subject,
        e.from_address,
        e.date,
        e.is_read,
        e.body_text
      FROM email.emails e
      WHERE e.is_read = false
        AND e.from_address NOT ILIKE '%noreply%'
        AND e.from_address NOT ILIKE '%no-reply%'
        AND e.from_address NOT ILIKE '%donotreply%'
        AND e.from_address NOT ILIKE '%notifications%'
        AND e.from_address NOT ILIKE '%alert%'
        AND e.from_address NOT ILIKE '%support@%'
        AND e.from_address NOT ILIKE '%info@%'
        AND e.from_address NOT ILIKE '%newsletter%'
        AND e.from_address NOT ILIKE '%marketing%'
        AND e.from_address NOT ILIKE '%mailer%'
        AND e.from_address NOT ILIKE '%bounce%'
        AND e.date > NOW() - INTERVAL '60 days'
      ORDER BY e.date DESC
      LIMIT 30
    `)
    return rows
  } catch (err) {
    return []
  }
}

/**
 * Parse speaker names from recent lifelog markdowns.
 * Returns names that are not 'You' or 'Unknown'.
 */
async function findMentionedPeopleInLifelogs() {
  try {
    const { rows } = await db.query(`
      SELECT markdown
      FROM limitless.lifelogs
      WHERE markdown IS NOT NULL AND markdown != ''
      ORDER BY start_time DESC
      LIMIT 30
    `)

    const nameSet = new Set()
    const nameRegex = /^-\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+\(/gm

    for (const row of rows) {
      const markdown = row.markdown || ''
      let match
      while ((match = nameRegex.exec(markdown)) !== null) {
        const name = match[1].trim()
        if (name !== 'You' && name !== 'Unknown' && name.length > 1) {
          nameSet.add(name)
        }
        // reset lastIndex for re-exec across rows
      }
    }

    return Array.from(nameSet)
  } catch (err) {
    console.error('[insights] findMentionedPeopleInLifelogs error:', err.message)
    return []
  }
}

module.exports = {
  findAwaitingReplyContacts,
  findActiveGroupsNotParticipating,
  findColdEmailsNotReplied,
  findMentionedPeopleInLifelogs,
}
