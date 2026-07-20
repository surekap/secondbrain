'use strict'

const llm = require('../../shared/llm')

const VERIFIER_VERSION = 'signal-claim-verifier-v1'

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
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([w]) => w)
}

function scopeKey(signal) {
  if (signal.project_id) return `project:${signal.project_id}`
  if (signal.contact_id) return `contact:${signal.contact_id}`
  // Unknown actors must never meet each other through globally shared words.
  // Keep them inspectable as one-evidence clusters until identity resolution
  // supplies a stable contact/project subject.
  return `unresolved:${signal.source_table || 'unknown'}:${signal.source_id || signal.id || 'unknown'}`
}

function topicSimilarity(leftTerms, rightTerms) {
  const left = new Set(leftTerms)
  const right = new Set(rightTerms)
  if (!left.size || !right.size) return 0
  const overlap = [...left].filter(term => right.has(term)).length
  const union = new Set([...left, ...right]).size
  return Math.max(overlap >= 2 ? 0.5 : 0, overlap / union)
}

function topicForSignals(signals) {
  const counts = new Map()
  for (const signal of signals) {
    for (const term of termsFor(signal)) counts.set(term, (counts.get(term) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([term]) => term)
}

function clusterKey(signalType, scope, topicTerms) {
  const topic = topicTerms.slice(0, 3).sort().join('-') || 'other'
  return `${signalType || 'other'}:${scope}:${topic}`
}

function asDate(value) {
  const d = value ? new Date(value) : null
  return d && !Number.isNaN(d.getTime()) ? d : null
}

function buildSignalClusters(signals = []) {
  // First build semantic topic components inside an entity/type scope. Source is
  // deliberately absent: independent sources must be able to corroborate the
  // same unlinked claim, while unrelated claims about one person/project remain
  // separate.
  const components = []
  for (const signal of signals) {
    if (!signal) continue
    const terms = termsFor(signal)
    const type = signal.signal_type || 'other'
    const scope = scopeKey(signal)
    let best = null
    let bestScore = 0
    for (const component of components) {
      if (component.signal_type !== type || component.scope !== scope) continue
      const score = topicSimilarity(terms, component.topic_terms)
      if (score > bestScore) {
        best = component
        bestScore = score
      }
    }
    if (!best || bestScore < 0.34) {
      best = { signal_type: type, scope, signals: [], topic_terms: terms }
      components.push(best)
    }
    best.signals.push(signal)
    best.topic_terms = topicForSignals(best.signals)
  }

  return components.map(component => {
    const seed = component.signals[0]
    const cluster = {
      cluster_key: clusterKey(component.signal_type, component.scope, component.topic_terms),
      signal_type: component.signal_type,
      project_id: seed.project_id || null,
      project_name: component.signals.find(signal => signal.project_name)?.project_name || null,
      contact_id: seed.contact_id || null,
      contact_name: component.signals.find(signal => signal.contact_name)?.contact_name || null,
      cluster_terms: component.topic_terms,
      signals: component.signals,
      source_tables: new Set(),
      first_seen_at: null,
      last_seen_at: null,
      max_confidence: 0,
      avg_strength: 0,
      contradiction_count: 0,
    }
    for (const signal of component.signals) {
      const sourceKind = signal.metadata?.source_kind || signal.source_table
      if (sourceKind) cluster.source_tables.add(sourceKind)
      const polarity = signal.polarity || signal.metadata?.polarity
      const lifecycleState = signal.lifecycle_state || signal.metadata?.lifecycle_state
      if (polarity === 'negative' || lifecycleState === 'resolved' || lifecycleState === 'cancelled') {
        cluster.contradiction_count++
      }
    const occurred = asDate(signal.occurred_at) || asDate(signal.created_at)
    if (occurred) {
      if (!cluster.first_seen_at || occurred < cluster.first_seen_at) cluster.first_seen_at = occurred
      if (!cluster.last_seen_at || occurred > cluster.last_seen_at) cluster.last_seen_at = occurred
    }
    const confidence = Number(signal.confidence || 0)
    if (confidence > cluster.max_confidence) cluster.max_confidence = confidence
    }
    const strengthSum = cluster.signals.reduce((sum, s) => sum + Number(s.strength || 50), 0)
    cluster.signal_count = cluster.signals.length
    cluster.active_signal_count = cluster.signal_count - cluster.contradiction_count
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
  if (Number(cluster.active_signal_count ?? cluster.signal_count) < 2) return false
  if (cluster.contradiction_count >= cluster.active_signal_count) return false

  const linked = Boolean(cluster.project_id || cluster.contact_id)
  if (linked && cluster.signal_count >= 2 && cluster.source_count >= 2) return true

  return false
}

function evidenceKey(signal) {
  return `${signal.source_table}:${signal.source_id}`
}

function validateClusterVerification(raw, cluster) {
  if (!raw || raw.promote !== true) return { promote: false, claims: [], verifier_version: VERIFIER_VERSION }
  const allowed = new Map(cluster.signals.map(signal => [evidenceKey(signal), signal]))
  const allowedClaimTypes = new Set(['need', 'offer', 'intent', 'risk', 'event', 'capability', 'decision', 'commitment'])
  const claims = []
  for (const candidate of Array.isArray(raw.claims) ? raw.claims : []) {
    if (!allowedClaimTypes.has(candidate?.claim_type)) continue
    const subjectType = candidate.subject_type
    const subjectId = candidate.subject_id == null ? null : String(candidate.subject_id)
    if (subjectType === 'project' && String(cluster.project_id || '') !== subjectId) continue
    if (subjectType === 'contact' && String(cluster.contact_id || '') !== subjectId) continue
    if (!['project', 'contact', 'unknown'].includes(subjectType)) continue
    const evidence = []
    for (const item of Array.isArray(candidate.evidence) ? candidate.evidence : []) {
      const signal = allowed.get(String(item?.ref || ''))
      const quote = String(item?.quote || '').replace(/\s+/g, ' ').trim()
      const haystack = String(signal?.description || signal?.content || '').replace(/\s+/g, ' ')
      if (!signal || quote.length < 5 || !haystack.toLowerCase().includes(quote.toLowerCase())) continue
      evidence.push({ ref: evidenceKey(signal), quote, signal })
    }
    if (!evidence.length) continue
    const actorType = ['self', 'contact', 'unknown'].includes(candidate.actor_type) ? candidate.actor_type : 'unknown'
    const actorId = candidate.actor_id == null ? null : String(candidate.actor_id)
    if (evidence.every(item => item.signal.metadata?.direction === 'outbound') && actorType !== 'self') continue
    if (actorType === 'contact' && actorId && String(cluster.contact_id || '') !== actorId) continue
    claims.push({
      claim_type: candidate.claim_type,
      actor_type: actorType,
      actor_id: actorId,
      subject_type: subjectType,
      subject_id: subjectId,
      predicate: String(candidate.predicate || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      polarity: ['positive', 'negative', 'uncertain'].includes(candidate.polarity) ? candidate.polarity : 'uncertain',
      lifecycle_state: ['active', 'resolved', 'cancelled', 'unknown'].includes(candidate.lifecycle_state) ? candidate.lifecycle_state : 'unknown',
      evidence,
    })
  }
  const activeClaims = claims.filter(claim => claim.lifecycle_state === 'active' && claim.polarity !== 'negative')
  return {
    promote: activeClaims.length > 0,
    claims,
    title: String(raw.title || '').trim().slice(0, 140) || null,
    description: String(raw.description || '').trim().slice(0, 1000) || null,
    recommended_next_action: String(raw.recommended_next_action || '').trim().slice(0, 260) || null,
    verifier_version: VERIFIER_VERSION,
  }
}

async function verifyCluster(cluster) {
  const evidence = cluster.signals.map(signal => ({
    ref: evidenceKey(signal),
    channel: signal.metadata?.source_kind || signal.source_table,
    direction: signal.metadata?.direction || 'unknown',
    occurred_at: signal.occurred_at || null,
    linked_contact_id: signal.contact_id || null,
    linked_project_id: signal.project_id || null,
    text: signal.description || signal.content || '',
  }))
  const prompt = `Verify a candidate communication-signal cluster. Regex matches are routing hints only, never facts.

Cluster scope: project_id=${cluster.project_id || 'null'}, contact_id=${cluster.contact_id || 'null'}
Candidate type: ${cluster.signal_type}
Evidence JSON:
${JSON.stringify(evidence)}

Return JSON only:
{"promote":false,"title":null,"description":null,"recommended_next_action":null,"claims":[{"claim_type":"need|offer|intent|risk|event|capability|decision|commitment","actor_type":"self|contact|unknown","actor_id":null,"subject_type":"project|contact|unknown","subject_id":null,"predicate":"specific proposition","polarity":"positive|negative|uncertain","lifecycle_state":"active|resolved|cancelled|unknown","evidence":[{"ref":"exact evidence ref","quote":"exact supporting span"}]}]}

Rules:
- Distinguish the speaker from the subject. An outbound statement is authored by self.
- Quoted/forwarded text does not establish that the sender believes or owns the claim.
- Negation can resolve a risk, but phrases such as "no update; still blocked" remain active.
- Evidence quote must be copied exactly from one evidence text and each ref must be exact.
- Promote only a specific, actionable, currently active proposition corroborated by the supplied evidence. Zero claims and promote=false are correct.`
  const response = await llm.create('intelligence', {
    profile: 'reasoning_synthesis',
    task_type: 'signal_claim_verification_json',
    workflow_name: 'intelligence_signal_verification',
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }],
  })
  const clean = String(response.text || '').replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  return validateClusterVerification(JSON.parse(clean), cluster)
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
      source_table: signal.source_table,
      source_id: signal.source_id,
      source_ref: signal.source_ref || `${signal.source_table || 'unknown'}:${signal.source_id || signal.id}`,
      occurred_at: signal.occurred_at || signal.created_at || null,
      quote: signal.description || signal.title || null,
      relevance: signal.confidence || null,
      metadata: {
        signal_id: signal.id,
        signal_type: signal.signal_type,
        source_kind: signal.metadata?.source_kind || signal.source_table,
        canonical_source_ref: signal.metadata?.canonical_source_ref || null,
      },
    })),
  }
}

module.exports = {
  VERIFIER_VERSION,
  buildSignalClusters,
  shouldPromoteCluster,
  opportunityFromCluster,
  validateClusterVerification,
  verifyCluster,
  clusterPromotionPlan,
  termsFor,
}
