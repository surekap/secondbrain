#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const {
  requestJson,
  evaluateSmoke,
} = require('./lib/live-smoke')

function argValue(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.find(a => a.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

const API_BASE = argValue('api-base', process.env.SECONDBRAIN_API_BASE || process.env.SECONDBRAIN_BASE_URL || 'http://100.105.11.84:4001')
const UI_BASE = argValue('ui-base', process.env.SECONDBRAIN_UI_BASE || 'http://100.105.11.84:4000')
const LIMIT = Number(argValue('limit', '10'))
const TOP_N = Number(argValue('top', String(Math.min(LIMIT, 10))))
const OUTPUT_JSON = hasFlag('json')
const STRICT = hasFlag('strict')
const CRON_JSON = argValue('cron-json', process.env.SECONDBRAIN_CRON_JSON || '')

function endpoint(name, url) {
  return requestJson(url).then(result => ({ name, url, ...result }))
}

function loadCronJobs() {
  if (!CRON_JSON) return []
  try {
    const text = fs.readFileSync(path.resolve(CRON_JSON), 'utf8')
    const data = JSON.parse(text)
    return Array.isArray(data) ? data : (data.jobs || [])
  } catch (err) {
    return [{ name: 'cron-json-load', enabled: true, last_status: `error: ${err.message}` }]
  }
}

function normalizeAgents(json) {
  return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
}

async function collectSnapshot() {
  const endpoints = await Promise.all([
    endpoint('ui_home', `${UI_BASE}/`),
    endpoint('api_agents', `${API_BASE}/api/agents`),
    endpoint('search_stats', `${API_BASE}/api/search/stats`),
    endpoint('observe_health', `${API_BASE}/api/observe/health`),
    endpoint('intelligence_graph', `${API_BASE}/api/intelligence/graph/summary`),
    endpoint('entity_resolver', `${API_BASE}/api/intelligence/resolve-entity?q=rahul&limit=5`),
    endpoint('contact_tiers_summary', `${API_BASE}/api/intelligence/contact-tiers/summary`),
    endpoint('signals_summary', `${API_BASE}/api/intelligence/signals/summary`),
    endpoint('signals_recent', `${API_BASE}/api/intelligence/signals/recent?limit=5`),
    endpoint('attention_queue', `${API_BASE}/api/intelligence/attention?limit=${LIMIT}`),
    endpoint('things_to_ignore', `${API_BASE}/api/intelligence/things-to-ignore?limit=5`),
    endpoint('opportunities', `${API_BASE}/api/intelligence/opportunities?limit=${LIMIT}`),
    endpoint('refresh_status', `${API_BASE}/api/intelligence/refresh/status`),
  ])

  const byName = Object.fromEntries(endpoints.map(e => [e.name, e]))
  return {
    generated_at: new Date().toISOString(),
    api_base: API_BASE,
    ui_base: UI_BASE,
    endpoints: endpoints.map(({ name, url, ok, status, bytes, ms, error }) => ({ name, url, ok, status, bytes, ms, error: error || null })),
    agents: normalizeAgents(byName.api_agents?.json),
    searchStats: byName.search_stats?.json || {},
    observeHealth: byName.observe_health?.json || {},
    graphSummary: byName.intelligence_graph?.json || {},
    contactTiersSummary: byName.contact_tiers_summary?.json || {},
    signalsSummary: byName.signals_summary?.json || {},
    recentSignals: Array.isArray(byName.signals_recent?.json) ? byName.signals_recent.json : [],
    attentionItems: Array.isArray(byName.attention_queue?.json) ? byName.attention_queue.json : [],
    opportunities: Array.isArray(byName.opportunities?.json) ? byName.opportunities.json : [],
    refreshStatus: byName.refresh_status?.json || {},
    cronJobs: loadCronJobs(),
  }
}

function printHuman(snapshot, result) {
  console.log(`SecondBrain live smoke — ${snapshot.generated_at}`)
  console.log(`API: ${snapshot.api_base}`)
  console.log(`UI:  ${snapshot.ui_base}`)
  console.log('')

  console.log(result.ok ? 'STATUS: PASS' : 'STATUS: FAIL')
  if (result.failures.length) {
    console.log('\nFailures:')
    for (const f of result.failures) console.log(`- ${f}`)
  }
  if (result.warnings.length) {
    console.log('\nWarnings:')
    for (const w of result.warnings) console.log(`- ${w}`)
  }

  console.log('\nEndpoints:')
  for (const e of snapshot.endpoints) console.log(`- ${e.name}: ${e.ok ? 'ok' : 'FAIL'} status=${e.status} bytes=${e.bytes} ms=${e.ms}${e.error ? ` error=${e.error}` : ''}`)

  console.log('\nAgents:')
  for (const id of ['email', 'whatsapp', 'apple-contacts', 'relationships', 'projects', 'limitless', 'research']) {
    const a = snapshot.agents[id] || {}
    console.log(`- ${id}: ${a.status || 'missing'} pid=${a.pid || '-'} stats=${JSON.stringify(a.stats || {})}`)
  }

  const m = result.metrics
  console.log('\nSearch:')
  console.log(`- indexed_total=${m.indexed_total} pending_total=${m.pending_total} last_error=${snapshot.searchStats?.indexer?.lastRunError || 'null'} running=${snapshot.searchStats?.indexer?.running}`)

  console.log('\nGraph:')
  console.log(`- ${JSON.stringify(m.graph_summary)}`)

  console.log('\nContact tiers:')
  console.log(`- ${JSON.stringify(snapshot.contactTiersSummary?.by_tier || [])}`)
  if (snapshot.contactTiersSummary?.overdue?.length) {
    const overdue = snapshot.contactTiersSummary.overdue[0]
    console.log(`- top overdue: ${overdue.display_name} ${overdue.relationship_tier} overdue=${overdue.days_overdue}d`)
  }

  console.log('\nSignals:')
  console.log(`- ${JSON.stringify(m.signals_summary || {})}`)

  console.log('\nAttention quality:')
  console.log(`- top=${m.attention_quality.top_count} low_value_admin=${m.attention_quality.low_value_admin_count} generic_next_action=${m.attention_quality.generic_next_action_count} weak_evidence=${m.attention_quality.weak_evidence_count} missing_why_now=${m.attention_quality.missing_why_now_count}`)
  for (const p of m.attention_quality.problems.slice(0, 10)) {
    console.log(`  - ${p.title}: ${p.problems.join(', ')}`)
  }
}

async function main() {
  if (!Number.isSafeInteger(LIMIT) || LIMIT < 1 || LIMIT > 50) throw new Error('--limit must be 1..50')
  if (!Number.isSafeInteger(TOP_N) || TOP_N < 1 || TOP_N > LIMIT) throw new Error('--top must be 1..limit')

  const snapshot = await collectSnapshot()
  const result = evaluateSmoke(snapshot, { topN: TOP_N })
  const output = { ok: result.ok, ...result, snapshot }

  if (OUTPUT_JSON) console.log(JSON.stringify(output, null, 2))
  else printHuman(snapshot, result)

  if (!result.ok || (STRICT && result.warnings.length)) process.exitCode = 2
}

main().catch(err => {
  console.error(`secondbrain-live-smoke failed: ${err.stack || err.message}`)
  process.exitCode = 2
})
