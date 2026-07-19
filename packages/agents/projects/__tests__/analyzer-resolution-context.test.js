'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildResolvedInsightContext } = require('../services/analyzer')

test('buildResolvedInsightContext preserves user-inferred closure for later analysis', () => {
  const context = buildResolvedInsightContext([
    {
      content: 'May OEM collections were reported as ₹5.80 Cr rather than actual collections above ₹12 Cr.',
      resolution_status: 'inferred_resolved',
      resolution_basis: 'Correction was acknowledged; later collection reports continued without recurrence.',
      resolved_at: '2026-07-19T00:00:00Z',
    },
  ])

  assert.match(context, /Previously resolved insights/i)
  assert.match(context, /inferred_resolved/)
  assert.match(context, /later collection reports continued without recurrence/i)
  assert.match(context, /Do not reopen/i)
})

test('buildResolvedInsightContext returns empty context without resolved insights', () => {
  assert.equal(buildResolvedInsightContext([]), '')
})
