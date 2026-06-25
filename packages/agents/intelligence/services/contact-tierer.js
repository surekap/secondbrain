'use strict'

const CADENCE_BY_TIER = {
  tier_1: 30,
  tier_2: 60,
  tier_3: 120,
  unknown: 180,
  noise: null,
}

function scoreContact(contact = {}) {
  if (contact.is_noise || contact.relationship_strength === 'noise') return 0

  let score = 0
  const strength = contact.relationship_strength || 'weak'
  if (strength === 'strong') score += 55
  else if (strength === 'moderate') score += 35
  else if (strength === 'weak') score += 15

  const type = contact.relationship_type || 'unknown'
  if (type === 'family') score += 30
  else if (['client', 'colleague', 'professional_contact'].includes(type)) score += 15
  else if (['vendor', 'service_provider'].includes(type)) score += 5

  const commCount = Number(contact.comm_count || 0)
  if (commCount >= 50) score += 15
  else if (commCount >= 15) score += 10
  else if (commCount >= 5) score += 5

  const insightCount = Number(contact.insight_count || 0)
  if (insightCount >= 3) score += 10
  else if (insightCount >= 1) score += 5

  if (contact.company) score += 3
  if (contact.job_title) score += 3

  return Math.max(0, Math.min(100, score))
}

function tierForScore(score, contact = {}) {
  if (contact.is_noise || contact.relationship_strength === 'noise') return 'noise'
  if (score >= 75) return 'tier_1'
  if (score >= 45) return 'tier_2'
  if (score > 0) return 'tier_3'
  return 'unknown'
}

function nextTouchAt(lastInteractionAt, cadenceDays) {
  if (!lastInteractionAt || !cadenceDays) return null
  const base = new Date(lastInteractionAt)
  if (Number.isNaN(base.getTime())) return null
  const next = new Date(base.getTime())
  next.setUTCDate(next.getUTCDate() + Number(cadenceDays))
  return next
}

function recommendContactTier(contact = {}) {
  const score = scoreContact(contact)
  const relationship_tier = tierForScore(score, contact)
  const cadence = CADENCE_BY_TIER[relationship_tier] || null
  return {
    contact_id: contact.id || null,
    relationship_tier,
    strategic_importance_score: Number(score.toFixed(2)),
    preferred_cadence_days: cadence,
    dormant_threshold_days: cadence,
    next_suggested_touch_at: nextTouchAt(contact.last_interaction_at, cadence),
    intro_sensitivity: relationship_tier === 'tier_1' ? 'high' : relationship_tier === 'noise' ? 'do_not_intro' : 'medium',
  }
}

module.exports = {
  CADENCE_BY_TIER,
  scoreContact,
  recommendContactTier,
  nextTouchAt,
}
