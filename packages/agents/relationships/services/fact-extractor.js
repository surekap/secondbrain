'use strict'

const FACT_PATTERNS = [
  {
    fact_type: 'support_context',
    sentiment: 'sensitive',
    confidence: 0.82,
    patterns: [
      /\b(difficult|tough|hard)\s+(time|times|period|phase)\b/i,
      /\b(be there|support|check in|reach out)\b/i,
    ],
  },
  {
    fact_type: 'cancelled_plan',
    sentiment: 'neutral',
    confidence: 0.78,
    patterns: [
      /\b(cancelled|canceled|postponed|had to cancel|called off)\b/i,
      /\b(meet|meeting|lunch|dinner|coffee|catch up)\b/i,
    ],
  },
  {
    fact_type: 'important_date',
    sentiment: 'positive',
    confidence: 0.76,
    patterns: [
      /\b(milestone birthday|birthday|anniversary)\b/i,
    ],
  },
  {
    fact_type: 'gift_sent',
    sentiment: 'neutral',
    confidence: 0.74,
    patterns: [
      /\b(sent|send|gave|gifted)\b/i,
      /\bgift\b/i,
    ],
  },
  {
    fact_type: 'gift_preference',
    sentiment: 'positive',
    confidence: 0.82,
    patterns: [
      /\b(always wanted|would like|likes|loves|prefers|preference)\b/i,
      /\b(wimbledon|wine|tickets?|champagne|sports?|tennis)\b/i,
    ],
  },
  {
    fact_type: 'personal_preference',
    sentiment: 'positive',
    confidence: 0.72,
    patterns: [
      /\b(wimbledon|wine|tennis|tickets?|champagne)\b/i,
    ],
  },
]

function normalizeFactText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function inferContactMention(text, candidates = []) {
  const lower = String(text || '').toLowerCase()
  for (const candidate of candidates) {
    const name = String(candidate.display_name || candidate.name || '').trim()
    if (!name) continue
    if (lower.includes(name.toLowerCase())) return candidate
  }
  return null
}

function extractRelationshipFactsFromText(text, options = {}) {
  const fact = normalizeFactText(text)
  if (!fact) return []

  const matched = []
  for (const spec of FACT_PATTERNS) {
    if (spec.patterns.every(pattern => pattern.test(fact))) {
      matched.push({
        contact_id: options.contact_id || null,
        fact_type: spec.fact_type,
        fact,
        sentiment: spec.sentiment,
        source: options.source || 'hermes',
        source_ref: options.source_ref || null,
        confidence: spec.confidence,
        occurred_at: options.occurred_at || null,
        metadata: options.metadata || {},
      })
    }
  }

  const deduped = []
  const seen = new Set()
  for (const item of matched) {
    const key = `${item.fact_type}:${item.fact.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }
  return deduped
}

module.exports = {
  extractRelationshipFactsFromText,
  inferContactMention,
}
