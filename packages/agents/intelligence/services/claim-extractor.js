'use strict'

const crypto = require('crypto')

const EXTRACTOR_VERSION = 'claim-v1'
const NEGATION = /\b(?:no|not|never|neither|without|cancel(?:led)?|resolved|fixed|completed|done|do not|don't|did not|didn't)\b/i
const UNCERTAINTY = /\b(?:maybe|might|could|possibly|perhaps|considering|if|hypothetical)\b/i

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function evidenceSpan(signal, max = 500) {
  return String(signal?.content || signal?.description || signal?.title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function subjectFor(signal) {
  if (signal.project_id) return { subject_type: 'project', subject_id: String(signal.project_id) }
  if (signal.contact_id) return { subject_type: 'contact', subject_id: String(signal.contact_id) }
  return { subject_type: 'unknown', subject_id: null }
}

function claimState(signal, span) {
  if (signal.lifecycle_state) return signal.lifecycle_state
  if (NEGATION.test(span)) return signal.signal_type === 'risk' ? 'resolved' : 'cancelled'
  if (UNCERTAINTY.test(span)) return 'proposed'
  return 'active'
}

function predicateFor(signal) {
  const raw = evidenceSpan(signal, 300)
    .replace(new RegExp(`^${signal.signal_type || 'other'}\\s*:\\s*`, 'i'), '')
  return raw || String(signal.signal_type || 'other')
}

function fingerprintForClaim(claim) {
  const semantic = normalize(claim.predicate).split(' ').filter(word => word.length >= 3).slice(0, 12).sort().join(' ')
  return hash([
    claim.claim_type,
    claim.subject_type,
    claim.subject_id || 'unlinked',
    semantic,
  ].join(':'))
}

function claimFromSignal(signal) {
  if (!signal?.signal_type || !signal?.source_table || signal?.source_id == null) return null
  const span = evidenceSpan(signal)
  if (!span) return null
  const subject = subjectFor(signal)
  const lifecycleState = claimState(signal, span)
  const polarity = lifecycleState === 'resolved' || lifecycleState === 'cancelled' ? 'negative' : 'positive'
  const claim = {
    claim_type: signal.signal_type,
    ...subject,
    predicate: predicateFor(signal),
    object_type: null,
    object_id: null,
    polarity,
    lifecycle_state: lifecycleState,
    valid_from: signal.occurred_at || signal.created_at || null,
    valid_until: null,
    confidence: Number(signal.confidence || 0.55),
    extractor_version: EXTRACTOR_VERSION,
    metadata: {
      signal_id: signal.id || null,
      source_ref: signal.source_ref || null,
      uncertain: UNCERTAINTY.test(span),
    },
    evidence: {
      source_table: signal.source_table,
      source_id: String(signal.source_id),
      source_ref: signal.source_ref || `${signal.source_table}:${signal.source_id}`,
      occurred_at: signal.occurred_at || signal.created_at || null,
      quote: span,
      content_hash: hash(span),
      metadata: { signal_type: signal.signal_type },
    },
  }
  claim.claim_key = fingerprintForClaim(claim)
  claim.evidence.metadata.polarity = claim.polarity
  claim.evidence.metadata.lifecycle_state = claim.lifecycle_state
  return claim
}

function guidanceApplies(fact, claim) {
  if (!fact || fact.state !== 'active') return false
  if (fact.scope_type === 'project' && String(fact.scope_id) !== String(claim.subject_type === 'project' ? claim.subject_id : '')) return false
  if (fact.scope_type === 'contact' && String(fact.scope_id) !== String(claim.subject_type === 'contact' ? claim.subject_id : '')) return false
  // These scopes require an explicit graph link before they can constrain a
  // claim. Falling through would turn one group/topic rule into global policy.
  if (['organization', 'group', 'topic'].includes(fact.scope_type)) return false
  if (!['global', 'project', 'contact'].includes(fact.scope_type)) return false
  const rule = fact.fact_value || {}
  if (rule.claim_type && rule.claim_type !== claim.claim_type) return false
  if (rule.contains && !normalize(claim.predicate).includes(normalize(rule.contains))) return false
  return true
}

function applyGuidance(claim, facts = []) {
  if (!claim) return null
  const applicable = facts.filter(fact => guidanceApplies(fact, claim))
  if (applicable.some(fact => fact.fact_type === 'suppress_claim')) return null
  const state = applicable.findLast?.(fact => fact.fact_type === 'claim_state')
    || [...applicable].reverse().find(fact => fact.fact_type === 'claim_state')
  if (state?.fact_value?.lifecycle_state) {
    claim.lifecycle_state = state.fact_value.lifecycle_state
    claim.polarity = ['resolved', 'cancelled'].includes(claim.lifecycle_state) ? 'negative' : claim.polarity
  }
  const subject = applicable.findLast?.(fact => fact.fact_type === 'canonical_subject')
    || [...applicable].reverse().find(fact => fact.fact_type === 'canonical_subject')
  if (subject?.fact_value?.subject_type) claim.subject_type = subject.fact_value.subject_type
  if (subject?.fact_value?.subject_id != null) claim.subject_id = String(subject.fact_value.subject_id)
  if (applicable.length) claim.metadata.guidance_fact_ids = applicable.map(fact => fact.id).filter(Boolean)
  claim.claim_key = fingerprintForClaim(claim)
  claim.evidence.metadata.polarity = claim.polarity
  claim.evidence.metadata.lifecycle_state = claim.lifecycle_state
  return claim
}

function extractClaims(signals = [], options = {}) {
  const byEvidence = new Map()
  for (const signal of signals) {
    const claim = applyGuidance(claimFromSignal(signal), options.guidance || [])
    if (!claim) continue
    const key = `${claim.evidence.source_table}:${claim.evidence.source_id}:${claim.claim_type}`
    byEvidence.set(key, claim)
  }
  return [...byEvidence.values()]
}

module.exports = {
  EXTRACTOR_VERSION,
  claimFromSignal,
  guidanceApplies,
  applyGuidance,
  extractClaims,
  fingerprintForClaim,
}
