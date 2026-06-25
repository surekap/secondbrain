'use strict'

const STOPWORDS = new Set([
  'the','and','for','with','from','this','that','into','your','you','are','was','were','has','have','had','not','but','can','will','may','should','could','again','still','issue','issues','problem','need','needs','help','message','messages','session','group','project','opportunity','risk','failed','failure',
  'https','http','www','com','logo','blog','utm','click','view','open','tracking','footer','image','png','jpg'
])

function isNoisyTerm(term) {
  return /^\d+$/.test(String(term || '')) || String(term || '').length < 3 || STOPWORDS.has(String(term || '').toLowerCase())
}

function hasUsableTerms(cluster) {
  return (cluster?.cluster_terms || []).filter(term => !isNoisyTerm(term)).length >= 2
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
        contact_id: signal.contact_id || null,
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
  if (!hasUsableTerms(cluster)) return false

  const linked = Boolean(cluster.project_id || cluster.contact_id)
  if (linked && cluster.signal_count >= 2) return true

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

function opportunityFromCluster(cluster) {
  const type = opportunityTypeForSignal(cluster.signal_type, cluster)
  const count = cluster.signal_count
  const sourcePhrase = cluster.source_count === 1 ? 'one source' : `${cluster.source_count} sources`
  const when = cluster.last_seen_at ? new Date(cluster.last_seen_at).toISOString().slice(0, 10) : 'recently'
  const whyNow = `${count} corroborating ${cluster.signal_type} signals across ${sourcePhrase}; latest signal ${when}. Promote only if it maps to a concrete owner/action, otherwise dismiss or keep monitoring.`
  return {
    opportunity_type: type,
    title: `Cluster: ${cluster.title}`.slice(0, 140),
    description: cluster.summary,
    priority: cluster.signal_type === 'risk' ? 'high' : 'medium',
    confidence: Math.min(0.9, Math.max(0.55, Number(cluster.max_confidence || 0.55))),
    primary_contact_id: cluster.contact_id || null,
    primary_project_id: cluster.project_id || null,
    source_system: 'signals',
    source_ref: `signal_cluster:${cluster.cluster_key}`,
    dedupe_key: `signals:cluster:${cluster.cluster_key}`,
    why_now: whyNow,
    recommended_next_action: cluster.signal_type === 'risk'
      ? `Assign an owner to validate the clustered risk, then mitigate, dismiss, or set a review date.`
      : `Review the clustered signals, identify the owner/contact, and either convert to one concrete action or dismiss.`,
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
