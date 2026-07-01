'use strict'

const CADENCE_BY_TIER = {
  tier_1: 30,
  tier_2: 60,
  tier_3: 120,
  unknown: 180,
  noise: null,
}

function isSelfContact(contact = {}) {
  const name = String(contact.display_name || contact.name || '').trim().toLowerCase()
  return name === 'prateek sureka'
}

function contactText(contact = {}) {
  return [contact.display_name, contact.name, contact.company, contact.job_title, contact.relationship_type]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function isOperationalContact(contact = {}) {
  const text = contactText(contact)
  return [
    'operations', 'operation', 'accounts staff', 'accounting', 'admin', 'admin staff', 'staff',
    'executive assistant', 'assistant', 'hr', 'electrician', 'employee', 'branch manager',
    'bank relationship manager', 'portfolio updates', 'institutional desk'
  ].some(term => text.includes(term))
}

function isServiceOrVendor(contact = {}) {
  return ['service_provider', 'vendor'].includes(contact.relationship_type)
}

function scoreContact(contact = {}) {
  if (isSelfContact(contact)) return 0
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

  if (isOperationalContact(contact)) score -= 35
  if (isServiceOrVendor(contact)) score -= 25

  return Math.max(0, Math.min(100, score))
}

function tierForScore(score, contact = {}) {
  if (isSelfContact(contact)) return 'noise'
  if (contact.is_noise || contact.relationship_strength === 'noise') return 'noise'
  if (score >= 75) return 'tier_1'
  if (score >= 45) return 'tier_2'
  if (score > 0) return 'tier_3'
  return 'noise'
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
  const suppressedReason = isServiceOrVendor(contact) ? 'service_or_vendor' : isOperationalContact(contact) ? 'operational_contact' : null
  let relationship_tier = tierForScore(score, contact)
  if (suppressedReason && relationship_tier === 'tier_1') relationship_tier = 'tier_2'
  const cadence = suppressedReason ? null : (CADENCE_BY_TIER[relationship_tier] || null)
  return {
    contact_id: contact.id || null,
    relationship_tier,
    strategic_importance_score: Number(score.toFixed(2)),
    preferred_cadence_days: cadence,
    dormant_threshold_days: cadence,
    next_suggested_touch_at: nextTouchAt(contact.last_interaction_at, cadence),
    intro_sensitivity: relationship_tier === 'tier_1' ? 'high' : relationship_tier === 'noise' ? 'do_not_intro' : 'medium',
    obligation_reason: suppressedReason || (cadence ? 'cadence' : 'none'),
  }
}

function normalizedName(contact = {}) {
  return String(contact.display_name || contact.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function recommendContactTiers(contacts = []) {
  const recs = contacts.map(contact => ({ contact, rec: recommendContactTier(contact) }))
  const groups = new Map()
  for (const item of recs) {
    const name = normalizedName(item.contact)
    if (!name) continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(item)
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const eligible = group.filter(item => item.rec.next_suggested_touch_at)
    if (eligible.length < 2) continue
    eligible.sort((a, b) => {
      const scoreDelta = Number(b.rec.strategic_importance_score || 0) - Number(a.rec.strategic_importance_score || 0)
      if (scoreDelta) return scoreDelta
      const aLast = new Date(a.contact.last_interaction_at || 0).getTime() || 0
      const bLast = new Date(b.contact.last_interaction_at || 0).getTime() || 0
      if (bLast !== aLast) return bLast - aLast
      return Number(a.contact.id || 0) - Number(b.contact.id || 0)
    })
    const canonicalId = eligible[0].contact.id || eligible[0].rec.contact_id
    for (const duplicate of eligible.slice(1)) {
      duplicate.rec.next_suggested_touch_at = null
      duplicate.rec.preferred_cadence_days = null
      duplicate.rec.dormant_threshold_days = null
      duplicate.rec.duplicate_of_contact_id = canonicalId
    }
  }

  return recs.map(item => item.rec)
}

module.exports = {
  CADENCE_BY_TIER,
  scoreContact,
  recommendContactTier,
  recommendContactTiers,
  nextTouchAt,
  normalizedName,
}
