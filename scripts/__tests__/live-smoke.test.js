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
    attentionItems: [
      { title: 'Book direct India-Munich flight', recommended_next_action: 'Turn this into a concrete task', evidence_count: 1, quality_flags: ['single_evidence'] }
    ],
    cronJobs: [{ name: 'secondbrain-group1-supervisor', last_status: 'ok', enabled: true }]
  }

  const result = evaluateSmoke(snapshot)

  assert.equal(result.ok, false)
  assert.ok(result.failures.some(f => f.includes('observe_health')))
  assert.ok(result.failures.some(f => f.includes('graph')))
  assert.ok(result.failures.some(f => f.includes('attention quality')))
})
