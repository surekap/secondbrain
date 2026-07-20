'use strict'

const crypto = require('crypto')
const identity = require('./identity')

const JPEG_B64_PREFIX = '/9j/'

function cleanText(value, limit = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function mediaSemanticText(message = {}) {
  return cleanText(message.semantic_text || message.media_semantic_text || message.extracted_text, 4000)
}

function messageTextForAnalysis(message = {}) {
  const body = cleanText(message.body, 1000)
  const bodyIsThumbnail = body.startsWith(JPEG_B64_PREFIX) && body.length > 100
  const caption = cleanText(message.caption, 500)
  const semantic = mediaSemanticText(message)
  const mediaMarker = ['image', 'video', 'document', 'ptt', 'audio', 'sticker', 'location', 'vcard']
    .includes(message.msg_type) ? `[Media: ${message.msg_type}]` : ''
  return [caption, bodyIsThumbnail ? '' : body, semantic ? `[Media analysis] ${semantic}` : '', mediaMarker]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 4000)
}

/**
 * Prefer WhatsApp's immutable serialized message ID. Historical rows that lack
 * it receive a deterministic content fingerprint; never use random IDs because
 * retries and backfills must converge on the same communication row. The raw
 * row ID is deliberately excluded: duplicated raw rows for the same native-ID-
 * missing event must converge. The trade-off is that two truly identical
 * messages in the same chat, direction, type, and timestamp share one event.
 */
function whatsappSourceId(message = {}, chatId = '') {
  const nativeId = cleanText(message.wa_msg_id, 500)
  if (nativeId) return `wa:${nativeId}`

  let occurredAt = String(message.ts || '')
  if (message.ts) {
    const parsed = new Date(message.ts)
    if (!Number.isNaN(parsed.getTime())) occurredAt = parsed.toISOString()
  }
  const fingerprintInput = JSON.stringify({
    chat_id: chatId,
    occurred_at: occurredAt,
    from_me: Boolean(message.from_me),
    msg_type: message.msg_type || 'chat',
    body: cleanText(message.body, 8000),
    caption: cleanText(message.caption, 2000),
    filename: cleanText(message.filename, 1000),
  })
  const digest = crypto.createHash('sha256').update(fingerprintInput).digest('hex').slice(0, 24)
  return `wa:fallback:${digest}`
}

function groupAuthorJid(message = {}) {
  if (message.from_me) return null
  const raw = String(message.participant || message.author_raw || '').trim().toLowerCase()
  const phoneJid = raw.match(/(\d{7,15})@(c\.us|s\.whatsapp\.net)/)
  if (phoneJid) return `${phoneJid[1]}@c.us`
  const lid = raw.match(/(\d{7,21})@lid/)
  return lid ? `${lid[1]}@lid` : null
}

async function resolveGroupAuthorContact(pool, message = {}) {
  const waJid = groupAuthorJid(message)
  if (!waJid) return { contact_id: null, author_jid: null }
  const contactId = await resolveDirectContact(pool, waJid, message.notify_name || null)
  return { contact_id: contactId || null, author_jid: waJid }
}

async function upsertCanonicalCommunication(pool, event) {
  const params = [
    event.contact_id || null,
    event.source,
    event.source_id,
    event.direction || 'inbound',
    event.content_snippet || '',
    event.subject || null,
    event.chat_id || null,
    Boolean(event.is_group),
    event.group_name || null,
    event.is_read !== false,
    event.occurred_at,
    JSON.stringify(event.metadata || {}),
  ]

  // One atomic statement relies on the database-enforced canonical event key.
  // This is safe for concurrent writers and for events whose contact is not yet
  // resolved (NULL contact_id).
  const { rows } = await pool.query(`
    WITH previous AS (
      SELECT id, contact_id
      FROM relationships.communications
      WHERE source = $2 AND source_id = $3
    ), upserted AS (
      INSERT INTO relationships.communications (
      contact_id, source, source_id, direction, content_snippet, subject,
      chat_id, is_group, group_name, is_read, occurred_at, metadata
      )
      VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      ON CONFLICT (source, source_id) DO UPDATE SET
        -- Exact source identity may correct a stale non-null association. Keep
        -- an audit row below whenever that happens.
        contact_id = COALESCE(EXCLUDED.contact_id, relationships.communications.contact_id),
        direction = EXCLUDED.direction,
        content_snippet = CASE
          WHEN NULLIF(EXCLUDED.metadata->>'media_semantic_text', '') IS NOT NULL
            OR LENGTH(COALESCE(EXCLUDED.content_snippet, '')) >= LENGTH(COALESCE(relationships.communications.content_snippet, ''))
          THEN EXCLUDED.content_snippet ELSE relationships.communications.content_snippet END,
        subject = COALESCE(EXCLUDED.subject, relationships.communications.subject),
        chat_id = COALESCE(EXCLUDED.chat_id, relationships.communications.chat_id),
        is_group = EXCLUDED.is_group,
        group_name = COALESCE(EXCLUDED.group_name, relationships.communications.group_name),
        is_read = EXCLUDED.is_read,
        occurred_at = COALESCE(EXCLUDED.occurred_at, relationships.communications.occurred_at),
        metadata = COALESCE(relationships.communications.metadata, '{}'::jsonb) ||
                   jsonb_strip_nulls(EXCLUDED.metadata)
      RETURNING id, contact_id, (xmax = 0) AS inserted
    ), identity_correction AS (
      INSERT INTO relationships.communication_identity_conflicts (
        source, source_id, previous_contact_id, resolved_contact_id, metadata
      )
      SELECT $2, $3, previous.contact_id, upserted.contact_id,
             jsonb_build_object('resolution', 'later exact source identity')
      FROM previous CROSS JOIN upserted
      WHERE previous.contact_id IS NOT NULL
        AND upserted.contact_id IS NOT NULL
        AND previous.contact_id <> upserted.contact_id
      ON CONFLICT (source, source_id, previous_contact_id, resolved_contact_id)
      DO UPDATE SET occurrences = relationships.communication_identity_conflicts.occurrences + 1,
                    last_seen_at = NOW()
      RETURNING id
    ), source_lineage AS (
      INSERT INTO relationships.communication_source_rows (communication_id, source, source_row_id)
      SELECT upserted.id, $2, ($12::jsonb->>'source_row_id')::bigint
      FROM upserted
      WHERE COALESCE($12::jsonb->>'source_row_id', '') ~ '^[0-9]+$'
      ON CONFLICT (source, source_row_id) DO UPDATE
      SET communication_id = EXCLUDED.communication_id
      RETURNING source_row_id
    )
    SELECT upserted.*,
           EXISTS (SELECT 1 FROM identity_correction) AS identity_corrected
    FROM upserted
  `, params)
  return {
    id: rows[0]?.id || null,
    inserted: Boolean(rows[0]?.inserted),
    identity_corrected: Boolean(rows[0]?.identity_corrected),
  }
}

async function upsertGroupCommunications(pool, messages = [], context = {}) {
  let inserted = 0
  let updated = 0
  let linked = 0
  let fallback_ids = 0
  let skipped = 0
  const authorCache = new Map()
  for (const message of messages) {
    const chatId = message.chat_id || context.chat_id
    if (!chatId) {
      skipped++
      continue
    }
    if (!message.wa_msg_id) fallback_ids++
    const authorJid = groupAuthorJid(message)
    let author = authorCache.get(authorJid || '__self_or_unknown__')
    if (!author) {
      author = await resolveGroupAuthorContact(pool, message)
      authorCache.set(authorJid || '__self_or_unknown__', author)
    }
    const rendered = buildMediaSnippetAndMeta(message)
    const result = await upsertCanonicalCommunication(pool, {
      contact_id: author.contact_id,
      source: 'whatsapp',
      source_id: whatsappSourceId(message, chatId),
      direction: 'group',
      content_snippet: rendered.snippet,
      chat_id: chatId,
      is_group: true,
      group_name: message.group_name || context.group_name || null,
      occurred_at: message.ts,
      metadata: {
        ...rendered.metadata,
        author_jid: author.author_jid,
        author_name: message.notify_name || null,
        author_from_me: Boolean(message.from_me),
      },
    })
    if (result.inserted) inserted++
    else if (result.id) updated++
    if (author.contact_id) linked++
  }
  return { inserted, updated, linked, fallback_ids, skipped }
}

function usableDirectDisplayName(value, chatId) {
  const name = cleanText(value, 160)
  if (!name || name === chatId || /^\d{6,20}(?:@lid)?$/.test(name)) return null
  return name
}

async function resolveDirectContact(pool, chatId, displayName = null) {
  const waJid = String(chatId || '').trim().toLowerCase()
  const isPhoneJid = /^\d{7,15}@c\.us$/.test(waJid)
  const isLid = /^\d{7,21}@lid$/.test(waJid)
  if (!isPhoneJid && !isLid) return null
  let contactId = await identity.findContactByIdentity(pool, {
    source: 'whatsapp', identity_type: 'wa_jid', identity_value: waJid,
  })
  if (!contactId && isPhoneJid) {
    contactId = await identity.findContactByIdentity(pool, {
      source: 'phone', identity_type: 'phone', identity_value: waJid.split('@')[0],
    })
  }
  if (!contactId && isPhoneJid) {
    const phone = waJid.split('@')[0]
    const { rows } = await pool.query(`
      SELECT id
      FROM relationships.contacts
      WHERE is_noise IS DISTINCT FROM TRUE
        AND (
          wa_jids @> ARRAY[$1]::text[]
          OR EXISTS (
            SELECT 1 FROM unnest(COALESCE(phone_numbers, '{}')) value
            WHERE REGEXP_REPLACE(value, '[^0-9]', '', 'g') = $2
          )
        )
      ORDER BY id ASC
      LIMIT 2
    `, [waJid, phone])
    if (rows.length === 1) {
      contactId = rows[0].id
      await identity.recordContactIdentities(pool, contactId, [
        { source: 'whatsapp', identity_type: 'wa_jid', identity_value: waJid, confidence: 1 },
        { source: 'phone', identity_type: 'phone', identity_value: phone, confidence: 0.98 },
      ])
    }
  }

  if (!contactId && isLid) {
    const providerDisplayName = usableDirectDisplayName(displayName, waJid)
    const name = providerDisplayName || `WhatsApp participant ${crypto.createHash('sha256').update(waJid).digest('hex').slice(0, 8)}`
    const normalizedName = name.toLowerCase().replace(/\s+/g, ' ').trim()
    // A display name is presentation evidence, never person identity. Every
    // stable LID still receives one provider-scoped provisional profile so
    // name-less group authors remain linkable and retry-convergent. Independent
    // person-level evidence is required before a later audited merge.
    const created = await pool.query(`
      INSERT INTO relationships.contacts (
        display_name, normalized_name, wa_jids, relationship_type,
        relationship_strength, raw_data
      ) VALUES ($1, $2, ARRAY[$3]::text[], 'unknown', 'weak', $4::jsonb)
      RETURNING id
    `, [name, normalizedName, waJid, JSON.stringify({
      source: 'whatsapp_lid',
      provisional_identity: true,
      reason: 'provider_identity_without_person_level_corroboration',
      display_name_is_synthetic: !providerDisplayName,
    })])
    contactId = created.rows[0]?.id || null
    if (contactId) {
      await identity.recordContactIdentities(pool, contactId, [{
        source: 'whatsapp',
        identity_type: 'wa_jid',
        identity_value: waJid,
        confidence: 1,
        metadata: {
          source: providerDisplayName ? 'chat_metadata' : 'stable_provider_identity',
          display_name: providerDisplayName,
          privacy_preserving_lid: true,
        },
      }])
      await pool.query(`
        UPDATE relationships.contacts
        SET wa_jids = CASE WHEN $2 = ANY(COALESCE(wa_jids, '{}')) THEN wa_jids ELSE ARRAY_APPEND(COALESCE(wa_jids, '{}'), $2) END,
            updated_at = NOW()
        WHERE id = $1
      `, [contactId, waJid])
    }
  }
  return contactId || null
}

async function upsertDirectCommunications(pool, messages = []) {
  let inserted = 0
  let updated = 0
  let unresolved = 0
  let fallback_ids = 0
  let skipped = 0
  const contactCache = new Map()
  for (const message of messages) {
    if (!message.chat_id) {
      skipped++
      continue
    }
    if (!message.wa_msg_id) fallback_ids++
    if (!contactCache.has(message.chat_id)) {
      contactCache.set(message.chat_id, await resolveDirectContact(
        pool,
        message.chat_id,
        message.contact_name || message.group_name || message.notify_name || null
      ))
    }
    const contactId = contactCache.get(message.chat_id)
    if (!contactId) unresolved++
    const rendered = buildMediaSnippetAndMeta(message)
    const result = await upsertCanonicalCommunication(pool, {
      contact_id: contactId,
      source: 'whatsapp',
      source_id: whatsappSourceId(message, message.chat_id),
      direction: message.from_me ? 'outbound' : 'inbound',
      content_snippet: rendered.snippet,
      chat_id: message.chat_id,
      is_group: false,
      occurred_at: message.ts,
      metadata: rendered.metadata,
    })
    if (result.inserted) inserted++
    else if (result.id) updated++
  }
  return { inserted, updated, unresolved, fallback_ids, skipped }
}

function emailAttachmentText(attachments) {
  let values = attachments
  if (!Array.isArray(values)) {
    try { values = values ? JSON.parse(values) : [] } catch { values = [] }
  }
  return values
    .filter(item => item && item.extracted_text)
    .map(item => `[Attachment: ${cleanText(item.filename || 'file', 200)}] ${cleanText(item.extracted_text, 1000)}`)
    .join(' ')
}

function parsedSenderEmail(email = {}) {
  const explicit = cleanText(email.sender_email, 500).toLowerCase()
  if (explicit) return explicit
  const raw = String(email.from_address || '').trim()
  const angle = raw.match(/<([^>]+)>/)
  return cleanText(angle ? angle[1] : raw, 500).toLowerCase() || null
}

async function upsertEmailCommunications(pool, emails = []) {
  let inserted = 0
  let updated = 0
  let unresolved = 0
  const contactCache = new Map()
  for (const email of emails) {
    if (!email.id) {
      unresolved++
      continue
    }
    const senderEmail = parsedSenderEmail(email)
    if (senderEmail && !contactCache.has(senderEmail)) {
      contactCache.set(senderEmail, await identity.findContactByIdentity(pool, {
        source: 'email', identity_type: 'email', identity_value: senderEmail,
      }))
    }
    const contactId = contactCache.get(senderEmail) || email.contact_id || null
    if (!contactId) unresolved++
    const attachmentText = emailAttachmentText(email.attachments)
    // Attachment semantics are often the highest-signal part of an otherwise
    // long email, so reserve the front of the canonical snippet for them.
    const content = [cleanText(attachmentText, 1600), cleanText(email.body_text || email.subject, 2400)]
      .filter(Boolean).join(' ').slice(0, 4000)
    const result = await upsertCanonicalCommunication(pool, {
      contact_id: contactId,
      source: 'email',
      source_id: `email:${email.id}`,
      direction: 'inbound',
      content_snippet: content,
      subject: email.subject || null,
      is_read: email.is_read !== false,
      occurred_at: email.date || email.received_at || email.created_at,
      metadata: {
        account_id: email.account_id || null,
        account_email: email.account_email || null,
        message_id: email.message_id || null,
        gmail_uid: email.gmail_uid || null,
        thread_id: email.thread_id || null,
        from_address: email.from_address || null,
        sender_name: email.sender_name || null,
        sender_email: senderEmail,
        sender_is_noise: Boolean(email.sender_is_noise),
        to_addresses: email.to_addresses || [],
        cc_addresses: email.cc_addresses || [],
        bcc_addresses: email.bcc_addresses || [],
        reply_to: email.reply_to || null,
        labels: email.labels || [],
      },
    })
    if (result.inserted) inserted++
    else if (result.id) updated++
  }
  return { inserted, updated, unresolved }
}

async function upsertLimitlessCommunications(pool, lifelogs = []) {
  let inserted = 0
  let updated = 0
  let skipped = 0
  for (const lifelog of lifelogs) {
    if (!lifelog.id) {
      skipped++
      continue
    }
    const result = await upsertCanonicalCommunication(pool, {
      contact_id: null,
      source: 'limitless',
      source_id: `limitless:${lifelog.id}`,
      direction: 'inbound',
      content_snippet: cleanText(lifelog.markdown_preview || lifelog.title, 4000),
      subject: lifelog.title || null,
      occurred_at: lifelog.start_time || lifelog.created_at,
      metadata: { end_time: lifelog.end_time || null },
    })
    if (result.inserted) inserted++
    else if (result.id) updated++
  }
  return { inserted, updated, skipped }
}

function buildMediaSnippetAndMeta(message = {}) {
  const type = message.msg_type || 'chat'
  const body = message.body || ''
  const semantic = mediaSemanticText(message)
  const caption = cleanText(message.caption, 500)
  const commonMetadata = {
    msg_type: type || 'chat',
    wa_msg_id: message.wa_msg_id || null,
    media_analysis_kind: message.analysis_kind || null,
    media_semantic_text: semantic || null,
    source_row_id: message.source_row_id || null,
  }
  const isMediaBody = body.startsWith(JPEG_B64_PREFIX) && body.length > 100
  const analyzed = semantic ? `${caption ? `${caption} — ` : ''}${semantic}` : ''

  if (type === 'image' || (isMediaBody && type !== 'chat')) {
    return {
      snippet: analyzed || caption || '📷 Photo',
      metadata: { ...commonMetadata, msg_type: 'image', thumbnail_b64: body.slice(0, 4000) },
    }
  }
  if (type === 'video') {
    return {
      snippet: analyzed || caption || '🎥 Video',
      metadata: { ...commonMetadata, msg_type: 'video', thumbnail_b64: body.slice(0, 4000) },
    }
  }
  if (type === 'document') {
    const name = cleanText(message.filename || message.caption, 500)
    const label = name ? `📎 ${name}` : '📎 Document'
    return {
      snippet: analyzed || (semantic ? `${label} — ${semantic}` : label),
      metadata: { ...commonMetadata, msg_type: 'document', filename: message.filename || null, thumbnail_b64: body.slice(0, 4000) },
    }
  }
  if (type === 'ptt' || type === 'audio') {
    return { snippet: semantic || '🎤 Voice message', metadata: commonMetadata }
  }
  if (type === 'sticker') return { snippet: semantic || '🎴 Sticker', metadata: commonMetadata }
  if (type === 'location') return { snippet: semantic || '📍 Location', metadata: commonMetadata }
  if (type === 'vcard') return { snippet: semantic || '👤 Contact card', metadata: commonMetadata }

  return { snippet: messageTextForAnalysis(message).slice(0, 1000), metadata: commonMetadata }
}

module.exports = {
  whatsappSourceId,
  mediaSemanticText,
  messageTextForAnalysis,
  buildMediaSnippetAndMeta,
  groupAuthorJid,
  resolveGroupAuthorContact,
  upsertCanonicalCommunication,
  upsertGroupCommunications,
  resolveDirectContact,
  upsertDirectCommunications,
  emailAttachmentText,
  parsedSenderEmail,
  upsertEmailCommunications,
  upsertLimitlessCommunications,
}
