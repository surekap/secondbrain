'use strict'

const http = require('http')
const https = require('https')

function requestJson(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http
    const started = Date.now()
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(body) } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, bytes: Buffer.byteLength(body), ms: Date.now() - started })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message, bytes: 0, ms: Date.now() - started }))
  })
}

function numberValue(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function titleText(item) {
  return `${item?.title || ''} ${item?.description || ''}`.toLowerCase()
}

function isLowValueAdmin(item) {
  const text = titleText(item)
  const adminTerms = [
    'flight', 'travel plan', 'hotel', 'cab', 'taxi', 'visa', 'booking', 'calendar',
    'certificate/key rotation', 'certificate rotation', 'client credentials', 'csr',
    'password', 'otp', 'login', 'subscription', 'invoice follow-up'
  ]
  const strategicTerms = ['acquisition', 'investment', 'capital', 'ipo', 'strategic', 'customer lead', 'distribution', 'partnership']
  return adminTerms.some(term => text.includes(term)) && !strategicTerms.some(term => text.includes(term))
}

function isGenericNextAction(item) {
  const action = String(item?.recommended_next_action || '').toLowerCase()
  if (!action) return true
  return [
    'turn "',
    'turn this into a concrete task',
    'identify the best-fit person or project owner',
    'send a short intro note explaining the specific mutual value',
    'save a research task',
    'assign an owner to validate the clustered risk',
    'review the clustered signals, identify the owner/contact',
    'either convert to one concrete action or dismiss',
  ].some(phrase => action.includes(phrase))
}

function isUncorroboratedCluster(item) {
  const why = String(item?.why_now || '').toLowerCase()
  const title = String(item?.title || '').toLowerCase()
  return why.includes('corroborating')
    && why.includes('across one source')
    && (title.includes('signals on') || title.startsWith('cluster:'))
}

function isAcceptableSingleEvidence(item) {
  const type = String(item?.opportunity_type || item?.type || '').toLowerCase()
  return type === 'check_in' && Boolean(item?.why_now)
}

function summarizeAttentionQuality(items = [], { topN = 10 } = {}) {
  const top = items.slice(0, topN)
  const problems = []
  let lowValueAdmin = 0
  let genericNextAction = 0
  let weakEvidence = 0
  let missingWhyNow = 0
  let uncorroboratedCluster = 0

  for (const item of top) {
    const itemProblems = []
    const evidenceCount = numberValue(item?.evidence_count, 0)
    const flags = Array.isArray(item?.quality_flags) ? item.quality_flags : []

    if (isLowValueAdmin(item)) { lowValueAdmin += 1; itemProblems.push('low_value_admin') }
    if (isGenericNextAction(item)) { genericNextAction += 1; itemProblems.push('generic_next_action') }
    if (isUncorroboratedCluster(item)) { uncorroboratedCluster += 1; itemProblems.push('uncorroborated_cluster') }
    if (!isAcceptableSingleEvidence(item) && (evidenceCount < 2 || flags.includes('single_evidence') || flags.includes('no_evidence'))) { weakEvidence += 1; itemProblems.push('weak_evidence') }
    if (!item?.why_now) { missingWhyNow += 1; itemProblems.push('missing_why_now') }

    if (itemProblems.length) {
      problems.push({ title: item?.title || '(untitled)', problems: itemProblems, attention_score: item?.attention_score ?? null })
    }
  }

  return {
    top_count: top.length,
    low_value_admin_count: lowValueAdmin,
    generic_next_action_count: genericNextAction,
    weak_evidence_count: weakEvidence,
    missing_why_now_count: missingWhyNow,
    uncorroborated_cluster_count: uncorroboratedCluster,
    problem_titles: [...new Set(problems.filter(p => p.problems.includes('low_value_admin') || p.problems.includes('generic_next_action') || p.problems.includes('weak_evidence') || p.problems.includes('uncorroborated_cluster')).map(p => p.title))],
    problems,
  }
}

function evaluateSmoke(snapshot, opts = {}) {
  const failures = []
  const warnings = []
  const minIndexedProgress = opts.minIndexedProgress ?? 1
  const topN = opts.topN ?? 10
  const nowMs = Date.parse(opts.now || new Date().toISOString())
  const whatsappStaleAfterMs = opts.whatsappStaleAfterMs ?? (48 * 60 * 60 * 1000)

  for (const endpoint of snapshot.endpoints || []) {
    if (!endpoint.ok) failures.push(`endpoint ${endpoint.name || endpoint.path} failed (${endpoint.status || endpoint.error || 'unknown'})`)
  }

  const agents = snapshot.agents || {}
  for (const id of ['email', 'whatsapp', 'relationships', 'projects', 'limitless', 'research']) {
    const agent = agents[id]
    if (!agent) failures.push(`agent ${id} missing`)
    else if (agent.status !== 'running' || !agent.pid) failures.push(`agent ${id} not running (status=${agent.status}, pid=${agent.pid})`)
  }
  const whatsapp = agents.whatsapp
  if (whatsapp?.status === 'running' && whatsapp.pid) {
    const lastMessageAt = whatsapp.stats?.last_message_at
    const lastMessageMs = Date.parse(lastMessageAt || '')
    if (!Number.isFinite(lastMessageMs)) {
      failures.push('WhatsApp message ingestion has no valid last_message_at timestamp')
    } else if (Number.isFinite(nowMs) && nowMs - lastMessageMs > whatsappStaleAfterMs) {
      const staleHours = Math.floor((nowMs - lastMessageMs) / (60 * 60 * 1000))
      failures.push(`WhatsApp message ingestion stale (${staleHours}h since last message at ${lastMessageAt})`)
    }
  }
  const apple = agents['apple-contacts']
  if (apple && apple.status !== 'running' && apple.status !== 'idle') warnings.push('apple-contacts is not running; acceptable only if recently synced')

  const search = snapshot.searchStats || {}
  const indexer = search.indexer || {}
  if (indexer.lastRunError) failures.push(`search indexer error: ${indexer.lastRunError}`)
  const indexedTotal = (search.sources || []).reduce((sum, s) => sum + numberValue(s.indexed, 0), 0)
  const pendingTotal = (search.sources || []).reduce((sum, s) => sum + Math.max(0, numberValue(s.pending, 0)), 0)
  if (indexedTotal < minIndexedProgress) failures.push('search indexer has no indexed rows')
  if (pendingTotal > 0 && indexer.running === false && !indexer.nextRunAt) warnings.push('search has pending rows but no next index run')

  const graph = snapshot.graphSummary || {}
  const graphScore = numberValue(graph.organizations) + numberValue(graph.topics) + numberValue(graph.object_topics)
  if (graphScore === 0) failures.push('intelligence graph is empty')
  if (numberValue(graph.tiered_contacts) === 0) warnings.push('no tiered contacts yet')
  if (numberValue(graph.contacts_with_next_touch) === 0) warnings.push('no contacts with next touch date yet')

  const tierRows = Array.isArray(snapshot.contactTiersSummary?.by_tier) ? snapshot.contactTiersSummary.by_tier : []
  const unknownTier = tierRows.find(row => row.relationship_tier === 'unknown')
  if (unknownTier && numberValue(unknownTier.count) > 0) failures.push(`unknown contact tier bucket has ${unknownTier.count} contacts`)

  const signals = snapshot.signalsSummary || {}
  if (Object.keys(signals).length && numberValue(signals.total) === 0) warnings.push('weak signal table is empty')

  const attention = summarizeAttentionQuality(snapshot.attentionItems || [], { topN })
  if (attention.top_count === 0) failures.push('attention queue is empty')
  if (attention.low_value_admin_count > 0 || attention.generic_next_action_count > Math.ceil(topN * 0.3) || attention.uncorroborated_cluster_count > Math.ceil(topN * 0.3)) {
    failures.push(`attention quality below gate (${attention.low_value_admin_count} low-value admin, ${attention.generic_next_action_count} generic next actions, ${attention.uncorroborated_cluster_count} uncorroborated clusters in top ${attention.top_count})`)
  }
  if (attention.weak_evidence_count > Math.ceil(topN * 0.7)) failures.push(`attention quality below evidence gate (${attention.weak_evidence_count}/${attention.top_count} weak evidence)`) 
  if (attention.missing_why_now_count > Math.ceil(topN * 0.7)) failures.push(`attention quality below timing gate (${attention.missing_why_now_count}/${attention.top_count} missing why_now)`)

  const cronJobs = snapshot.cronJobs || []
  for (const job of cronJobs.filter(j => j.enabled !== false && String(j.name || '').startsWith('secondbrain-'))) {
    if (job.last_status && job.last_status !== 'ok') failures.push(`cron ${job.name} last_status=${job.last_status}`)
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    metrics: {
      indexed_total: indexedTotal,
      pending_total: pendingTotal,
      graph_summary: graph,
      signals_summary: signals,
      attention_quality: attention,
    }
  }
}

module.exports = {
  requestJson,
  evaluateSmoke,
  summarizeAttentionQuality,
  isLowValueAdmin,
  isGenericNextAction,
  isUncorroboratedCluster,
  isAcceptableSingleEvidence,
}
