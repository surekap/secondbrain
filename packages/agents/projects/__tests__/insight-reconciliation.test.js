'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildInsightReconciliationPlan } = require('../services/analyzer')

test('omission retains stale open insight until newer evidence explicitly resolves it', () => {
  const open = [{ id: 1, insight_type: 'risk', content: 'Certificate expiry blocks the production launch' }]
  const plan = buildInsightReconciliationPlan(7, open, [], [])
  assert.equal(plan.actions.length, 0)
  assert.equal(plan.close.length, 0)
  assert.deepEqual(plan.keep.map(insight => insight.id), [1])
})

test('materially equivalent insight updates the stable row instead of delete/recreate', () => {
  const open = [{ id: 4, insight_type: 'risk', content: 'Certificate expiry blocks the production launch', insight_fingerprint: 'stable' }]
  const proposed = [{ insight_type: 'risk', content: 'The production launch is blocked by certificate expiry', evidence_refs: ['email:9'] }]
  const plan = buildInsightReconciliationPlan(7, open, proposed, [])
  assert.equal(plan.actions[0].kind, 'update')
  assert.equal(plan.actions[0].existing.id, 4)
  assert.equal(plan.actions[0].fingerprint, 'stable')
  assert.equal(plan.close.length, 0)
})

test('only explicit newer canonical evidence can resolve an open insight', () => {
  const open = [{
    id: 8,
    insight_type: 'risk',
    content: 'Certificate expiry blocks the production launch',
    evidence_occurred_at: '2026-07-01T00:00:00Z',
  }]
  const evidenceTimes = new Map([
    ['email:old', '2026-06-01T00:00:00Z'],
    ['email:new', '2026-07-10T00:00:00Z'],
  ])
  const invalid = buildInsightReconciliationPlan(7, open, [], [], [{
    insight_id: 8,
    basis: 'Fixed',
    confidence: 0.9,
    evidence_refs: ['email:old'],
  }], evidenceTimes)
  assert.equal(invalid.close.length, 0)

  const valid = buildInsightReconciliationPlan(7, open, [], [], [{
    insight_id: 8,
    basis: 'The renewal was confirmed',
    confidence: 0.9,
    evidence_refs: ['email:new'],
  }], evidenceTimes)
  assert.equal(valid.close.length, 1)
  assert.equal(valid.close[0].insight.id, 8)
  assert.deepEqual(valid.close[0].resolution.evidence_refs, ['email:new'])
})
