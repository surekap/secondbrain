'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { filterResolvedInsightDuplicates } = require('../services/analyzer')

const resolved = [{
  content: 'May OEM collections were reported as ₹5.80 Cr rather than actual collections above ₹12 Cr.',
  resolved_at: '2026-07-19T00:00:00Z',
}]

test('filterResolvedInsightDuplicates suppresses a rephrased historical issue without new contradictory evidence', () => {
  const insights = [{
    insight_type: 'risk',
    content: 'May OEM collection reporting showed ₹5.80 Cr despite actual collections above ₹12 Cr.',
    priority: 'high',
  }]

  assert.deepEqual(filterResolvedInsightDuplicates(insights, resolved), [])
})

test('filterResolvedInsightDuplicates permits a dated post-resolution recurrence', () => {
  const insight = {
    insight_type: 'risk',
    content: 'May OEM collection reporting showed ₹5.80 Cr despite actual collections above ₹12 Cr.',
    priority: 'high',
    evidence_occurred_at: '2026-07-20T00:00:00Z',
    reopens_resolution: true,
  }

  assert.deepEqual(filterResolvedInsightDuplicates([insight], resolved), [insight])
})
