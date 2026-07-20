'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { claimFromSignal, extractClaims, guidanceApplies } = require('../services/claim-extractor')

test('claim extractor preserves subject, lifecycle, and raw evidence', () => {
  const claim = claimFromSignal({
    id: 7,
    signal_type: 'risk',
    project_id: 42,
    description: 'The certificate expiry is blocking the launch.',
    source_table: 'email',
    source_id: '88',
    occurred_at: '2026-07-20T10:00:00Z',
    confidence: 0.82,
  })

  assert.equal(claim.subject_type, 'project')
  assert.equal(claim.subject_id, '42')
  assert.equal(claim.lifecycle_state, 'active')
  assert.equal(claim.polarity, 'positive')
  assert.equal(claim.evidence.source_id, '88')
  assert.match(claim.evidence.quote, /certificate expiry/)
})

test('claim extractor stores closure as counter-evidence instead of a fresh active risk', () => {
  const claim = claimFromSignal({
    signal_type: 'risk',
    contact_id: 3,
    description: 'The certificate issue was fixed and is no longer blocking launch.',
    source_table: 'whatsapp',
    source_id: 'abc',
  })

  assert.equal(claim.lifecycle_state, 'resolved')
  assert.equal(claim.polarity, 'negative')
})

test('claim extraction is idempotent per source evidence and claim type', () => {
  const signal = { signal_type: 'need', description: 'Need a tax advisor', source_table: 'email', source_id: '1' }
  assert.equal(extractClaims([signal, signal]).length, 1)
})

test('user guidance changes derived claim state without modifying evidence', () => {
  const signal = { signal_type: 'risk', project_id: 8, description: 'Certificate issue remains open', source_table: 'email', source_id: '1' }
  const [claim] = extractClaims([signal], { guidance: [{
    id: 99,
    state: 'active',
    scope_type: 'project',
    scope_id: '8',
    fact_type: 'claim_state',
    fact_value: { claim_type: 'risk', contains: 'certificate', lifecycle_state: 'resolved' },
  }] })
  assert.equal(claim.lifecycle_state, 'resolved')
  assert.equal(claim.polarity, 'negative')
  assert.match(claim.evidence.quote, /remains open/)
  assert.deepEqual(claim.metadata.guidance_fact_ids, [99])
})

test('unsupported scoped guidance never leaks globally', () => {
  const claim = { subject_type: 'project', subject_id: '8', claim_type: 'risk', predicate: 'certificate risk' }
  for (const scope_type of ['organization', 'group', 'topic']) {
    assert.equal(guidanceApplies({
      state: 'active', scope_type, scope_id: '8', fact_value: { claim_type: 'risk' },
    }, claim), false)
  }
  assert.equal(guidanceApplies({
    state: 'active', scope_type: 'global', scope_id: null, fact_value: { claim_type: 'risk' },
  }, claim), true)
})
