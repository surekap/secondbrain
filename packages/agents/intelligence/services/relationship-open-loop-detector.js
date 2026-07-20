'use strict'

const ACTION_PATTERNS = [
  /\b(please|kindly|appreciate|ensure|confirm|share|send|provide|follow up|follow-up|connect|apply|process|lead|intro|introduction|plan|next|now the plan|missed your call|looking at it|pending|awaiting|received|remittance|cancelled|canceled)\b/i,
]

const CLOSING_PATTERNS = [
  /\b(done|closed|completed|resolved|paid|sent|shared|sorted|handled|remitted|transferred|received by us|payment received)\b/i,
]

const LOW_VALUE_PATTERNS = [
  /^\s*(ok|okay|yes|yea|thanks|thank you|👍|🙏)\s*$/i,
  /https?:\/\//i,
]

function compact(value, max = 600) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function messageAt(message) {
  const d = new Date(message.ts || message.occurred_at || message.created_at || 0)
  return Number.isNaN(d.getTime()) ? null : d
}

function contactName(contact = {}) {
  return contact.display_name || contact.name || `contact ${contact.id}`
}

function isStrategicContact(contact = {}) {
  if (!contact) return false
  const name = String(contactName(contact)).toLowerCase()
  if (/\bprateek\s+sureka\b/.test(name)) return false
  if (['tier_1', 'tier_2'].includes(contact.relationship_tier)) return true
  if (['friend', 'family', 'professional_contact', 'client', 'investor'].includes(contact.relationship_type)) return true
  if (contact.is_noise) return false
  return false
}

function classifyOpenLoop(messages = []) {
  const ordered = [...messages]
    .filter(m => compact(m.body || m.content || m.content_snippet))
    .sort((a, b) => (messageAt(a)?.getTime() || 0) - (messageAt(b)?.getTime() || 0))
  let candidate = null
  for (const msg of ordered) {
    const text = compact(msg.body || msg.content || msg.content_snippet, 800)
    if (!text || LOW_VALUE_PATTERNS.some(p => p.test(text))) continue
    const fromMe = Boolean(msg.from_me)
    if (candidate) {
      const candidateAt = messageAt(candidate)
      const at = messageAt(msg)
      if (at && candidateAt && at > candidateAt && CLOSING_PATTERNS.some(p => p.test(text))) {
        // A later explicit close/ack can close the loop, unless it is a weak one-word reply to a real ask.
        if (text.length > 12 || fromMe) candidate = null
      }
    }
    if (ACTION_PATTERNS.some(p => p.test(text))) {
      candidate = { ...msg, text, from_me: fromMe }
    }
  }
  return candidate
}

function isSuppressedOpenLoop(contact = {}, text = '') {
  const name = String(contactName(contact)).toLowerCase()
  const body = String(text || '').toLowerCase()
  // User-confirmed false positive: this direct row is not actionable intelligence about Nikhil.
  if (/\bnikhil\s+mehra\b/.test(name) && /\bdiving\s+trip\b/.test(body)) return true
  // Personal travel cancellations/refunds are operational coordination, not an
  // investment, relationship, or project obligation worth promoting to attention.
  if (/\b(cancel|cancellation|refund)\b/.test(body) && /\b(booking|flight|hotel|trip|travel)\b/.test(body)) return true
  return false
}

function detectRelationshipOpenLoops(input = {}) {
  const contacts = input.contacts || []
  const directMessages = input.directMessages || []
  const now = input.now ? new Date(input.now) : new Date()
  const maxAgeDays = Number.isFinite(Number(input.maxAgeDays)) ? Number(input.maxAgeDays) : 30
  const oldestAllowedAt = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000)
  const messagesByContact = new Map()
  for (const msg of directMessages) {
    const id = String(msg.contact_id || '')
    if (!id) continue
    if (!messagesByContact.has(id)) messagesByContact.set(id, [])
    messagesByContact.get(id).push(msg)
  }

  const out = []
  for (const contact of contacts) {
    const id = String(contact.id || '')
    if (!id || !isStrategicContact(contact)) continue
    const messages = messagesByContact.get(id) || []
    if (!messages.length) continue
    const open = classifyOpenLoop(messages)
    if (!open) continue
    const openAt = messageAt(open)
    // A single direct-chat message cannot establish an obligation indefinitely.
    // Let the refresh retire it after 30 days unless newer evidence reopens it.
    if (openAt && openAt < oldestAllowedAt) continue
    if (isSuppressedOpenLoop(contact, open.text)) continue
    const name = contactName(contact)
    const text = open.text
    const direction = open.from_me ? 'outbound' : 'inbound'
    const sourceId = open.source_id || open.id || `${open.chat_id || id}:${open.ts || open.occurred_at || ''}`
    const canonicalCommunicationId = open.canonical_communication_id || null
    const occurredAt = open.ts || open.occurred_at || open.created_at || contact.last_interaction_at || null
    out.push({
      opportunity_type: 'follow_up',
      title: `${name}: unresolved direct-chat loop`,
      description: `Direct chat with ${name} contains an unresolved ${direction} ask/context: “${compact(text, 300)}”`,
      recommended_next_action: open.from_me
        ? `Check whether ${name} closed this; if not, send one concise follow-up referencing the prior ask.`
        : `Reply to ${name} or deliberately dismiss this if already closed elsewhere: “${compact(text, 120)}”.`,
      why_now: occurredAt ? `Direct-chat open loop last seen ${occurredAt}.` : 'Direct-chat open loop detected.',
      priority: contact.relationship_tier === 'tier_1' ? 'high' : 'medium',
      confidence: 0.78,
      impact_score: contact.relationship_tier === 'tier_1' ? 78 : 68,
      urgency_score: 72,
      relationship_score: contact.relationship_tier === 'tier_1' ? 85 : 72,
      expected_value_score: contact.relationship_tier === 'tier_1' ? 78 : 68,
      source_system: 'signals',
      source_ref: `relationship_open_loop:${id}:${sourceId}`,
      dedupe_key: `relationship_open_loop:${id}:${sourceId}`,
      primary_contact_id: contact.id,
      contact_ids: [contact.id],
      metadata: {
        detector: 'relationship_open_loop',
        direction,
        chat_id: open.chat_id || null,
        relationship_tier: contact.relationship_tier || null,
        relationship_type: contact.relationship_type || null,
      },
      evidence: [{
        source_table: canonicalCommunicationId ? 'relationships.communications' : 'public.messages',
        source_id: canonicalCommunicationId || sourceId,
        source_ref: canonicalCommunicationId
          ? `relationships.communication:${canonicalCommunicationId}`
          : `whatsapp:${sourceId}`,
        occurred_at: occurredAt,
        quote: compact(text, 500),
        relevance: 0.9,
        metadata: { contact_id: contact.id, chat_id: open.chat_id || null, direction },
      }],
    })
  }
  return out
}

module.exports = { detectRelationshipOpenLoops, classifyOpenLoop }
