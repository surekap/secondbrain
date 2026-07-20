'use strict'

// WhatsApp Web now exposes both phone-number JIDs (@c.us) and privacy-preserving
// local IDs (@lid).  A message's `from` value is not the conversation for an
// outbound message, and modern group events may put the account owner's JID
// there.  Keep this derivation in one place so live ingestion, recovery, and
// quality denominators agree without rewriting raw payloads.

const DIRECT_JID_RE = /^[1-9][0-9]{6,14}@c\.us$/
const LID_JID_RE = /^[1-9][0-9]{6,20}@lid$/
const GROUP_JID_RE = /^[1-9][0-9-]{5,40}@g\.us$/

function normalizeJid(value) {
  if (value == null) return null
  let jid = String(value).trim().toLowerCase()
  if (!jid) return null
  jid = jid.replace(/@s\.whatsapp\.net$/, '@c.us')
  jid = jid.replace(/^([1-9][0-9]{6,20}):[0-9]+@(c\.us|lid)$/, '$1@$2')
  return jid
}

function jidFromValue(value) {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { return jidFromValue(JSON.parse(trimmed)) } catch (_) {}
    }
    return normalizeJid(trimmed)
  }
  if (typeof value !== 'object') return normalizeJid(value)

  for (const key of ['_serialized', 'serialized']) {
    const candidate = jidFromValue(value[key])
    if (candidate) return candidate
  }
  if (value.user != null && value.server) {
    return normalizeJid(`${value.user}@${value.server}`)
  }
  // whatsapp-web.js raw fallbacks sometimes expose the serialized Wid as $1.
  if (typeof value.$1 === 'string' && value.$1.includes('@')) return normalizeJid(value.$1)
  return null
}

function isEligibleWhatsAppChatId(value) {
  const jid = normalizeJid(value)
  return Boolean(jid && (DIRECT_JID_RE.test(jid) || LID_JID_RE.test(jid) || GROUP_JID_RE.test(jid)))
}

function isGroupWhatsAppChatId(value) {
  const jid = normalizeJid(value)
  return Boolean(jid && GROUP_JID_RE.test(jid))
}

function canonicalWhatsAppChatId(payload = {}, options = {}) {
  const nested = payload && typeof payload._data === 'object' ? payload._data : {}
  const remote = jidFromValue(payload?.id?.remote) || jidFromValue(nested?.id?.remote)
  const from = jidFromValue(payload?.from) || jidFromValue(nested?.from)
  const to = jidFromValue(payload?.to) || jidFromValue(nested?.to)
  const stored = jidFromValue(options.storedChatId)
  const fromMe = Boolean(payload?.id?.fromMe ?? payload?.fromMe ?? nested?.id?.fromMe ?? nested?.fromMe)
  const configuredSelf = [options.selfJid, ...(options.selfJids || [])]
    .map(jidFromValue)
    .filter(Boolean)
  const selfJids = new Set(configuredSelf)
  const usable = value => isEligibleWhatsAppChatId(value) && !selfJids.has(value)

  // id.remote is WhatsApp's explicit conversation identity and is authoritative.
  if (usable(remote)) return remote

  // Preserve group identity even when a malformed/live payload has the account
  // owner in `from` or in the legacy stored chat_id.
  for (const candidate of [from, to, stored]) {
    if (usable(candidate) && isGroupWhatsAppChatId(candidate)) return candidate
  }

  const directional = fromMe ? [to, from] : [from, to]
  for (const candidate of [...directional.slice(0, 1), stored, ...directional.slice(1)]) {
    if (usable(candidate)) return candidate
  }
  return null
}

function jsonPathText(dataExpression, path) {
  return `${dataExpression}#>>'{${path.join(',')}}'`
}

function sqlJidValue(dataExpression, basePath) {
  const scalar = jsonPathText(dataExpression, basePath)
  const serialized = jsonPathText(dataExpression, [...basePath, '_serialized'])
  const alternateSerialized = jsonPathText(dataExpression, [...basePath, 'serialized'])
  const user = jsonPathText(dataExpression, [...basePath, 'user'])
  const server = jsonPathText(dataExpression, [...basePath, 'server'])
  const objectJid = `CASE WHEN NULLIF(${user}, '') IS NOT NULL AND NULLIF(${server}, '') IS NOT NULL THEN (${user}) || '@' || (${server}) END`
  const raw = `COALESCE(NULLIF(${serialized}, ''), NULLIF(${alternateSerialized}, ''), ${objectJid}, NULLIF(${scalar}, ''))`
  return `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(BTRIM(${raw}), '@s\\.whatsapp\\.net$', '@c.us'), '^([1-9][0-9]{6,20}):[0-9]+@(c\\.us|lid)$', '\\1@\\2'))`
}

function eligibleWhatsAppChatSql(jidExpression) {
  return `((${jidExpression}) ~ '^[1-9][0-9]{6,14}@c\\.us$' OR (${jidExpression}) ~ '^[1-9][0-9]{6,20}@lid$' OR (${jidExpression}) ~ '^[1-9][0-9-]{5,40}@g\\.us$')`
}

/**
 * PostgreSQL equivalent of canonicalWhatsAppChatId. Expressions are supplied
 * by trusted source code, never request input. `selfExpression` may be a bind
 * parameter such as "$2"; an empty value simply excludes nothing.
 */
function canonicalWhatsAppChatIdSql({ dataExpression = 'm.data', storedChatExpression = 'm.chat_id', selfExpression = "''" } = {}) {
  const remote = `COALESCE(${sqlJidValue(dataExpression, ['id', 'remote'])}, ${sqlJidValue(dataExpression, ['_data', 'id', 'remote'])})`
  const from = `COALESCE(${sqlJidValue(dataExpression, ['from'])}, ${sqlJidValue(dataExpression, ['_data', 'from'])})`
  const to = `COALESCE(${sqlJidValue(dataExpression, ['to'])}, ${sqlJidValue(dataExpression, ['_data', 'to'])})`
  const stored = `LOWER(REGEXP_REPLACE(REGEXP_REPLACE(BTRIM(${storedChatExpression}), '@s\\.whatsapp\\.net$', '@c.us'), '^([1-9][0-9]{6,20}):[0-9]+@(c\\.us|lid)$', '\\1@\\2'))`
  const fromMe = `LOWER(COALESCE(${jsonPathText(dataExpression, ['id', 'fromMe'])}, ${jsonPathText(dataExpression, ['fromMe'])}, ${jsonPathText(dataExpression, ['_data', 'id', 'fromMe'])}, ${jsonPathText(dataExpression, ['_data', 'fromMe'])}, 'false')) = 'true'`
  const normalizedSelf = `LOWER(REGEXP_REPLACE(BTRIM(COALESCE(${selfExpression}, '')), '@s\\.whatsapp\\.net$', '@c.us'))`
  const candidates = [
    [1, 'identity.remote_jid'],
    [2, `CASE WHEN identity.source_jid LIKE '%@g.us' THEN identity.source_jid END`],
    [3, `CASE WHEN identity.target_jid LIKE '%@g.us' THEN identity.target_jid END`],
    [4, `CASE WHEN identity.stored_jid LIKE '%@g.us' THEN identity.stored_jid END`],
    [5, `CASE WHEN identity.from_me THEN identity.target_jid ELSE identity.source_jid END`],
    [6, 'identity.stored_jid'],
    [7, `CASE WHEN identity.from_me THEN identity.source_jid ELSE identity.target_jid END`],
  ]
  const values = candidates.map(([priority, jid]) => `(${priority}, ${jid})`).join(',\n        ')
  return `(SELECT candidate.jid
      FROM (SELECT ${remote} AS remote_jid,
                   ${from} AS source_jid,
                   ${to} AS target_jid,
                   ${stored} AS stored_jid,
                   ${fromMe} AS from_me) identity
      CROSS JOIN LATERAL (VALUES ${values}) AS candidate(priority, jid)
      WHERE ${eligibleWhatsAppChatSql('candidate.jid')}
        AND (${normalizedSelf} = '' OR candidate.jid <> ${normalizedSelf})
      ORDER BY candidate.priority
      LIMIT 1)`
}

module.exports = {
  normalizeJid,
  jidFromValue,
  isEligibleWhatsAppChatId,
  isGroupWhatsAppChatId,
  canonicalWhatsAppChatId,
  eligibleWhatsAppChatSql,
  canonicalWhatsAppChatIdSql,
}
