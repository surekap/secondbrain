'use strict'

const DEFAULT_STALE_DAYS = 14

const PENDING_PATTERNS = [
  /\bplease\b/i,
  /\bkindly\b/i,
  /\bconfirm\b/i,
  /\bconfirmation\b/i,
  /\bshare\b/i,
  /\bsend\b/i,
  /\bprovide\b/i,
  /\brequest(?:ed)?\b/i,
  /\bawait(?:ing)?\b/i,
  /\bpending\b/i,
  /\bfollow(?:ing)?\s*up\b/i,
  /\bat the earliest\b/i,
  /\bproceed\b/i,
]

const CLOSING_PATTERNS = [
  /\backnowledg(?:e|ed|ing) receipt\b/i,
  /\breceived\b/i,
  /\bpayment complete\b/i,
  /\bprocessed\b/i,
  /\bclosed\b/i,
  /\bcompleted\b/i,
  /\bno further action\b/i,
  /\bthank(?:s| you)\b/i,
  /\bwill revert\b/i,
]

const BULK_SENDER_PATTERNS = [
  /\b(no-?reply|donotreply|newsletter|marketing|promo|promotions|reservations|customer|notifications?|mailbot|conference|microforum)@/i,
  /@comm\.delltechnologies\.com$/i,
  /@customer\.goindigo\.in$/i,
  /@digital\.axisbankmail\.bank\.in$/i,
  /@axis\.bank\.in$/i,
  /@distrokid\.com$/i,
  /@conference\.cii\.in$/i,
  /@ypo\.org$/i,
]

const BULK_SUBJECT_PATTERNS = [
  /\bnewsletter\b/i,
  /\bitinerary\b/i,
  /\bbooking\b/i,
  /\bpnr\b/i,
  /\bwebinar\b/i,
  /\bunlock ai\b/i,
  /\bproduct updates?\b/i,
  /\bdispatch\b/i,
  /\bpayment advice\b/i,
  /\bpre-sale is live\b/i,
  /\bon itunes\b/i,
  /\binvitation:/i,
  /\bcalendar invitation\b/i,
  /\bawards?\b/i,
  /\bdialogue\b/i,
  /\bmicroforum\b/i,
]

const BULK_BODY_PATTERNS = [
  /\bview online\b/i,
  /\bview the web version\b/i,
  /\bunsubscribe\b/i,
  /\bdo not reply\b/i,
  /\bsystem generated email\b/i,
  /click\.comm\./i,
  /deliverirs\/servlet/i,
  /\bpayment status\s+confirmed\b/i,
  /\bjoin with google meet\b/i,
  /\bjoin zoom meeting\b/i,
]

function compact(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function stripReplyPrefix(subject) {
  return String(subject || '')
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function threadKey(email) {
  return email.thread_id || stripReplyPrefix(email.subject || '').toLowerCase() || `email:${email.id}`
}

function emailAt(email) {
  const d = new Date(email.date || email.received_at || email.created_at || 0)
  return Number.isNaN(d.getTime()) ? null : d
}

function senderAddress(raw = '') {
  const match = String(raw).match(/<([^>]+)>/)
  return (match ? match[1] : raw).trim().toLowerCase()
}

function isInternalAddress(raw = '') {
  const addr = senderAddress(raw)
  return /@(sureka\.capital|hartex\.in|surekaproperties\.com)$/i.test(addr)
}

function hasPendingLanguage(email) {
  const text = `${email.subject || ''} ${email.body_text || email.body || ''}`
  return PENDING_PATTERNS.some(p => p.test(text))
}

function hasClosingLanguage(email) {
  const text = `${email.subject || ''} ${email.body_text || email.body || ''}`
  return CLOSING_PATTERNS.some(p => p.test(text))
}

function isBulkOrTransactional(email) {
  const sender = senderAddress(email.from_address || email.from_addr || '')
  const subject = String(email.subject || '')
  const body = String(email.body_text || email.body || '')
  if (BULK_SENDER_PATTERNS.some(p => p.test(sender))) return true
  if (BULK_SUBJECT_PATTERNS.some(p => p.test(subject))) return true
  if (/\b(automated notification|please do not reply|do not reply|system generated email)\b/i.test(body)) return true
  let bulkHits = 0
  for (const p of BULK_BODY_PATTERNS) if (p.test(body)) bulkHits++
  if (bulkHits >= 1 && body.length > 500) return true
  return false
}

function latestByDate(emails) {
  return [...emails].sort((a, b) => (emailAt(b)?.getTime() || 0) - (emailAt(a)?.getTime() || 0))[0]
}

function detectStaleEmailThreads(emails, options = {}) {
  const now = options.now ? new Date(options.now) : new Date()
  const staleDays = options.staleDays || DEFAULT_STALE_DAYS
  const groups = new Map()

  for (const email of emails || []) {
    const key = threadKey(email)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(email)
  }

  const out = []
  for (const [key, thread] of groups.entries()) {
    const dated = thread.filter(e => emailAt(e) && !isBulkOrTransactional(e))
    if (!dated.length) continue
    const latest = latestByDate(dated)
    const latestAt = emailAt(latest)
    const ageDays = Math.floor((now.getTime() - latestAt.getTime()) / 86400000)
    if (ageDays < staleDays) continue

    const actionEmails = dated.filter(hasPendingLanguage)
    if (!actionEmails.length) continue

    const latestAction = latestByDate(actionEmails)
    const latestActionAt = emailAt(latestAction)
    const laterClosing = dated.some(e => {
      const at = emailAt(e)
      return at && latestActionAt && at > latestActionAt && hasClosingLanguage(e)
    })
    if (laterClosing) continue

    const latestIsInternal = isInternalAddress(latest.from_address)
    const latestActionIsInternal = isInternalAddress(latestAction.from_address)
    const pendingDirection = latestActionIsInternal ? 'awaiting_external_response' : 'external_request_unresolved'

    out.push({
      thread_key: key,
      latest_email_id: String(latest.id),
      latest_action_email_id: String(latestAction.id),
      subject: stripReplyPrefix(latest.subject || latestAction.subject || 'Email thread'),
      from_address: latest.from_address || null,
      latest_at: latestAt.toISOString(),
      latest_action_at: latestActionAt ? latestActionAt.toISOString() : null,
      age_days: ageDays,
      pending_direction: pendingDirection,
      title: `Unclosed email thread: ${stripReplyPrefix(latest.subject || latestAction.subject || 'Email thread')}`,
      description: compact(latestAction.body_text || latestAction.body || latestAction.subject, 700),
      why_now: `Email thread has pending/action language and no later closing message for ${ageDays} days. Latest sender: ${latest.from_address || 'unknown'}.`,
      recommended_next_action: latestActionIsInternal
        ? `Follow up with the external party on "${stripReplyPrefix(latest.subject || latestAction.subject || 'this thread')}" and ask for a concrete close/next step.`
        : `Reply or delegate the request in "${stripReplyPrefix(latest.subject || latestAction.subject || 'this thread')}"; if already handled elsewhere, mark it closed.`,
      quote: compact(latestAction.body_text || latestAction.body || latestAction.subject, 500),
      metadata: {
        source: 'stale_email_thread_detector',
        pending_direction: pendingDirection,
        latest_is_internal: latestIsInternal,
      },
    })
  }

  return out.sort((a, b) => b.age_days - a.age_days)
}

module.exports = {
  detectStaleEmailThreads,
  stripReplyPrefix,
  isInternalAddress,
  hasPendingLanguage,
  hasClosingLanguage,
  isBulkOrTransactional,
}
