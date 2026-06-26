'use strict'

const STOPWORDS = new Set([
  'the','and','for','with','from','this','that','into','your','you','are','was','were','has','have','had','not','but','can','will','may','should','could','again','still','issue','issues','problem','need','needs','needed','help','message','messages','session','group','project','opportunity','risk','failed','failure','blocked','execution','calls','follow',
  'https','http','www','com','logo','blog','utm','click','view','open','tracking','footer','image','png','jpg',
  'prateek','sureka','direct','claude','chatgpt','whatsapp','email','called','call','3rd','third'
])

const SELF_CONTACT_NAMES = new Set(['prateek sureka', 'prateek'])

function isNoisyTerm(term) {
  return /^\d+$/.test(String(term || '')) || String(term || '').length < 3 || STOPWORDS.has(String(term || '').toLowerCase())
}

function hasUsableTerms(cluster) {
  return (cluster?.cluster_terms || []).filter(term => !isNoisyTerm(term)).length >= 2
}

function isSelfContactCluster(cluster) {
  return cluster?.contact_name && SELF_CONTACT_NAMES.has(normalizeText(cluster.contact_name))
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function termsFor(signal) {
  const text = normalizeText(`${signal.title || ''} ${signal.description || ''}`)
  const words = text.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w))
  const counts = new Map()
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1)
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([w]) => w)
}

function clusterKey(signal) {
  if (signal.project_id) return `${signal.signal_type || 'other'}:project:${signal.project_id}`
  if (signal.contact_id) return `${signal.signal_type || 'other'}:contact:${signal.contact_id}`
  const scope = `source:${signal.source_table || 'unknown'}`
  const topic = termsFor(signal).slice(0, 2).join('-') || normalizeText(signal.signal_type || 'other') || 'other'
  return `${signal.signal_type || 'other'}:${scope}:${topic}`
}

function asDate(value) {
  const d = value ? new Date(value) : null
  return d && !Number.isNaN(d.getTime()) ? d : null
}

function buildSignalClusters(signals = []) {
  const byKey = new Map()
  for (const signal of signals) {
    if (!signal) continue
    const key = clusterKey(signal)
    const terms = termsFor(signal)
    if (!byKey.has(key)) {
      byKey.set(key, {
        cluster_key: key,
        signal_type: signal.signal_type || 'other',
        project_id: signal.project_id || null,
        project_name: signal.project_name || null,
        contact_id: signal.contact_id || null,
        contact_name: signal.contact_name || null,
        cluster_terms: terms,
        signals: [],
        source_tables: new Set(),
        first_seen_at: null,
        last_seen_at: null,
        max_confidence: 0,
        avg_strength: 0,
      })
    }
    const cluster = byKey.get(key)
    cluster.signals.push(signal)
    if (!cluster.project_name && signal.project_name) cluster.project_name = signal.project_name
    if (!cluster.contact_name && signal.contact_name) cluster.contact_name = signal.contact_name
    if (signal.source_table) cluster.source_tables.add(signal.source_table)
    for (const term of terms) if (!cluster.cluster_terms.includes(term) && cluster.cluster_terms.length < 5) cluster.cluster_terms.push(term)
    const occurred = asDate(signal.occurred_at) || asDate(signal.created_at)
    if (occurred) {
      if (!cluster.first_seen_at || occurred < cluster.first_seen_at) cluster.first_seen_at = occurred
      if (!cluster.last_seen_at || occurred > cluster.last_seen_at) cluster.last_seen_at = occurred
    }
    const confidence = Number(signal.confidence || 0)
    if (confidence > cluster.max_confidence) cluster.max_confidence = confidence
  }

  return Array.from(byKey.values()).map(cluster => {
    const strengthSum = cluster.signals.reduce((sum, s) => sum + Number(s.strength || 50), 0)
    cluster.signal_count = cluster.signals.length
    cluster.source_count = cluster.source_tables.size
    cluster.source_tables = Array.from(cluster.source_tables)
    cluster.avg_strength = cluster.signal_count ? Number((strengthSum / cluster.signal_count).toFixed(2)) : 0
    cluster.title = titleForCluster(cluster)
    cluster.summary = summaryForCluster(cluster)
    return cluster
  }).sort((a, b) => b.signal_count - a.signal_count || String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))
}

function titleForCluster(cluster) {
  const terms = cluster.cluster_terms.slice(0, 3).join(' / ') || cluster.signal_type
  return `${cluster.signal_type}: ${terms}`.slice(0, 140)
}

function summaryForCluster(cluster) {
  const sample = cluster.signals.slice(0, 3).map(s => String(s.title || s.description || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  return sample.join(' | ').slice(0, 500)
}

function shouldPromoteCluster(cluster) {
  if (!cluster) return false
  if (isSelfContactCluster(cluster)) return false
  if (!hasUsableTerms(cluster)) return false

  const linked = Boolean(cluster.project_id || cluster.contact_id)
  if (linked && cluster.signal_count >= 2 && cluster.source_count >= 2) return true

  // Unlinked clusters need independent corroboration; volume from one inbox/source
  // is usually repeated boilerplate, notifications, newsletters, or transactional noise.
  if (!linked && cluster.signal_count >= 3 && cluster.source_count >= 2 && Number(cluster.max_confidence || 0) >= 0.7) return true

  return false
}

function opportunityTypeForSignal(signalType, cluster) {
  if (signalType === 'risk') return 'risk'
  if (cluster.project_id) return 'project_opportunity'
  if (signalType === 'need' || signalType === 'intent') return 'other'
  if (signalType === 'offer' || signalType === 'capability') return 'introduction'
  return 'other'
}

function clusterPromotionPlan(clusters = [], existingSourceRefs = []) {
  const promotableClusters = clusters.filter(shouldPromoteCluster)
  const validRefs = new Set(promotableClusters.map(cluster => `signal_cluster:${cluster.cluster_key}`))
  const staleSourceRefs = (existingSourceRefs || []).filter(ref => !validRefs.has(ref))
  return { promotableClusters, staleSourceRefs }
}

function humanTerms(cluster, limit = 3) {
  return (cluster.cluster_terms || [])
    .filter(term => !isNoisyTerm(term))
    .slice(0, limit)
}

function clusterSubject(cluster) {
  if (cluster.project_name) return cluster.project_name
  if (cluster.contact_name) return cluster.contact_name
  const terms = humanTerms(cluster)
  return terms.length ? terms.join(' / ') : cluster.signal_type || 'signal cluster'
}

function actionVerb(signalType) {
  if (signalType === 'risk') return 'confirm the risk, owner, and mitigation date for'
  if (signalType === 'need') return 'confirm the ask, owner, and next commitment for'
  if (signalType === 'intent') return 'confirm whether to act on'
  if (signalType === 'offer' || signalType === 'capability') return 'test whether there is a useful introduction around'
  return 'decide the next action for'
}

function synthesizeOpportunityText(cluster) {
  const terms = humanTerms(cluster)
  const termPhrase = terms.join(', ')
  const subject = clusterSubject(cluster)
  const count = cluster.signal_count
  const sourcePhrase = cluster.source_count === 1 ? 'one source' : `${cluster.source_count} sources`
  const when = cluster.last_seen_at ? new Date(cluster.last_seen_at).toISOString().slice(0, 10) : 'recently'
  const scope = cluster.project_name ? `project ${cluster.project_name}` : cluster.contact_name ? `contact ${cluster.contact_name}` : `topic ${subject}`
  const title = `${subject}: ${cluster.signal_type} signals on ${termPhrase || cluster.signal_type}`.slice(0, 140)
  const whyNow = `${count} corroborating ${cluster.signal_type} signals tied to ${scope} across ${sourcePhrase}; latest signal ${when}. Evidence terms: ${termPhrase || 'none'}.`

  let action
  if (cluster.contact_name) {
    action = `Ask ${cluster.contact_name} to ${actionVerb(cluster.signal_type)} ${termPhrase || subject}; request one concrete owner/date or dismiss it.`
  } else if (cluster.project_name) {
    action = `Ask the ${cluster.project_name} owner to ${actionVerb(cluster.signal_type)} ${termPhrase || subject}; get one owner/date or mark it non-actionable.`
  } else {
    action = `Check ${subject} against current priorities; act only if ${termPhrase || subject} maps to a named owner and deadline.`
  }

  return { title, why_now: whyNow, recommended_next_action: action.slice(0, 260) }
}

function opportunityFromCluster(cluster) {
  const type = opportunityTypeForSignal(cluster.signal_type, cluster)
  const count = cluster.signal_count
  const synthesized = synthesizeOpportunityText(cluster)
  return {
    opportunity_type: type,
    title: synthesized.title,
    description: cluster.summary,
    priority: cluster.signal_type === 'risk' ? 'high' : 'medium',
    confidence: Math.min(0.9, Math.max(0.55, Number(cluster.max_confidence || 0.55))),
    primary_contact_id: cluster.contact_id || null,
    primary_project_id: cluster.project_id || null,
    source_system: 'signals',
    source_ref: `signal_cluster:${cluster.cluster_key}`,
    dedupe_key: `signals:cluster:${cluster.cluster_key}`,
    why_now: synthesized.why_now,
    recommended_next_action: synthesized.recommended_next_action,
    metadata: {
      source: 'signal_cluster',
      cluster_key: cluster.cluster_key,
      signal_count: count,
      source_count: cluster.source_count,
      terms: cluster.cluster_terms,
    },
    evidence: cluster.signals.map(signal => ({
      source_table: 'intelligence.signals',
      source_id: signal.id,
      source_ref: signal.source_ref || `${signal.source_table || 'unknown'}:${signal.source_id || signal.id}`,
      occurred_at: signal.occurred_at || signal.created_at || null,
      quote: signal.description || signal.title || null,
      relevance: signal.confidence || null,
      metadata: { signal_type: signal.signal_type, source_table: signal.source_table, source_id: signal.source_id },
    })),
  }
}

module.exports = {
  buildSignalClusters,
  shouldPromoteCluster,
  opportunityFromCluster,
  clusterPromotionPlan,
  termsFor,
}
