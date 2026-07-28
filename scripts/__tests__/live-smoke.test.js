#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateSmoke, summarizeAttentionQuality } = require('../lib/live-smoke')

test('summarizeAttentionQuality flags low-value admin and weak evidence in top attention items', () => {
  const items = [
    {
      title: '[Meeting] Book direct India-Munich flight',
      recommended_next_action: 'Turn this into a concrete task with owner, deadline, and next message.',
      evidence_count: 1,
      quality_flags: ['single_evidence'],
      attention_score: '71.25'
    },
    {
      title: 'Strategic acquisition conversation with high-quality operator',
      recommended_next_action: 'Ask A for an introduction to B before Friday.',
      evidence_count: 3,
      quality_flags: [],
      attention_score: '88.00'
    }
  ]

  const summary = summarizeAttentionQuality(items, { topN: 2 })

  assert.equal(summary.top_count, 2)
  assert.equal(summary.low_value_admin_count, 1)
  assert.equal(summary.generic_next_action_count, 1)
  assert.equal(summary.weak_evidence_count, 1)
  assert.deepEqual(summary.problem_titles, ['[Meeting] Book direct India-Munich flight'])
})

test('summarizeAttentionQuality flags generic clustered actions', () => {
  const summary = summarizeAttentionQuality([
    {
      title: 'Cluster: risk: security / github / repositories',
      recommended_next_action: 'Assign an owner to validate the clustered risk, then mitigate, dismiss, or set a review date.',
      why_now: '6 corroborating risk signals across one source; latest signal 2026-06-25.',
      evidence_count: 6,
      quality_flags: [],
    }
  ], { topN: 1 })

  assert.equal(summary.generic_next_action_count, 1)
  assert.equal(summary.uncorroborated_cluster_count, 1)
  assert.equal(summary.problems[0].problems.includes('generic_next_action'), true)
  assert.equal(summary.problems[0].problems.includes('uncorroborated_cluster'), true)
})

test('summarizeAttentionQuality accepts relationship check-ins with a why_now as sufficient evidence', () => {
  const summary = summarizeAttentionQuality([
    {
      title: 'Check in with Siddharth Agarwal',
      opportunity_type: 'check_in',
      recommended_next_action: 'Send Siddharth a concise check-in tied to the relationship cadence.',
      why_now: 'tier_2 relationship crossed dormancy threshold',
      evidence_count: 1,
      quality_flags: ['single_evidence'],
    }
  ], { topN: 1 })

  assert.equal(summary.weak_evidence_count, 0)
  assert.equal(summary.problems.length, 0)
})

test('evaluateSmoke fails when contact tier summary contains unknown tier bucket', () => {
  const snapshot = {
    endpoints: [{ name: 'contact_tiers_summary', ok: true }],
    agents: {
      email: { status: 'running', pid: 1 },
      whatsapp: { status: 'running', pid: 2 },
      relationships: { status: 'running', pid: 3 },
      projects: { status: 'running', pid: 4 },
      limitless: { status: 'running', pid: 5 },
      research: { status: 'running', pid: 6 },
    },
    searchStats: { indexer: { lastRunError: null }, sources: [{ indexed: 1, pending: 0 }] },
    graphSummary: { organizations: 1, topics: 1, object_topics: 1, tiered_contacts: 10, contacts_with_next_touch: 1 },
    contactTiersSummary: { by_tier: [{ relationship_tier: 'unknown', count: 212 }] },
    signalsSummary: { total: 1 },
    attentionItems: [{ title: 'Useful item', recommended_next_action: 'Ask Rahul for confirmation by Friday.', evidence_count: 2, why_now: 'Recent evidence.' }],
    cronJobs: [],
  }

  const result = evaluateSmoke(snapshot, { topN: 1 })

  assert.equal(result.ok, false)
  assert.ok(result.failures.some(f => f.includes('unknown contact tier bucket')))
})

test('evaluateSmoke fails when WhatsApp reports running but message ingestion is stale', () => {
  const snapshot = {
    endpoints: [{ name: 'api_agents', ok: true }],
    agents: {
      email: { status: 'running', pid: 1 },
      whatsapp: { status: 'running', pid: 2, stats: { last_message_at: '2026-07-23T07:35:49.446Z' } },
      relationships: { status: 'running', pid: 3 },
      projects: { status: 'running', pid: 4 },
      limitless: { status: 'running', pid: 5 },
      research: { status: 'running', pid: 6 },
    },
    searchStats: { indexer: { lastRunError: null }, sources: [{ indexed: 1, pending: 0 }] },
    graphSummary: { organizations: 1, topics: 1, object_topics: 1, tiered_contacts: 10, contacts_with_next_touch: 1 },
    contactTiersSummary: { by_tier: [] },
    signalsSummary: { total: 1 },
    attentionItems: [{ title: 'Useful item', recommended_next_action: 'Ask Rahul for confirmation by Friday.', evidence_count: 2, why_now: 'Recent evidence.' }],
    cronJobs: [],
  }

  const result = evaluateSmoke(snapshot, { topN: 1, now: '2026-07-28T04:45:46.415Z' })

  assert.equal(result.ok, false)
  assert.ok(result.failures.some(f => f.includes('WhatsApp message ingestion stale')))
})

test('evaluateSmoke fails when core services are down or attention quality is below gate', () => {
  const snapshot = {
    endpoints: [
      { name: 'api_agents', ok: true },
      { name: 'search_stats', ok: true },
      { name: 'observe_health', ok: false, status: 503 },
    ],
    agents: { email: { status: 'running', pid: 1 }, whatsapp: { status: 'running', pid: 2 } },
    searchStats: { indexer: { lastRunError: null }, sources: [{ pending: 100 }] },
    graphSummary: { organizations: 0, topics: 0, object_topics: 0 },
    attentionItems: Array.from({ length: 10 }, (_, i) => ({
      title: i === 0 ? 'Book direct India-Munich flight' : `Weak single-evidence item ${i}`,
      recommended_next_action: i === 0 ? 'Turn this into a concrete task' : 'Review the evidence and decide',
      evidence_count: 1,
      quality_flags: ['single_evidence']
    })),
    cronJobs: [{ name: 'secondbrain-group1-supervisor', last_status: 'ok', enabled: true }]
  }

  const result = evaluateSmoke(snapshot)

  assert.equal(result.ok, false)
  assert.ok(result.failures.some(f => f.includes('observe_health')))
  assert.ok(result.failures.some(f => f.includes('graph')))
  assert.ok(result.failures.some(f => f.includes('attention quality')))
  assert.ok(result.failures.some(f => f.includes('evidence gate')))
  assert.ok(result.failures.some(f => f.includes('timing gate')))
})
