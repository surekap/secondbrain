'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { _internals } = require('../llm')

test('monthly spending-cap and quota 429s fail over to another provider', () => {
  assert.equal(_internals.isCreditError({
    status: 429,
    message: 'Your project has exceeded its monthly spending cap. See billing.',
  }), true)
  assert.equal(_internals.isCreditError({
    statusCode: 429,
    message: 'You exceeded your current quota.',
  }), true)
})

test('a transient rate-limit 429 is not treated as exhausted credit', () => {
  const error = {
    status: 429,
    message: 'Rate limit reached. Retry in 8s. Upgrade at /settings/billing.',
  }
  assert.equal(_internals.isCreditError(error), false)
  assert.equal(_internals.isTransientRateLimitError(error), true)
})

test('exhausted providers stay disabled until an explicit credit reset', () => {
  assert.equal(_internals.providerEligible({ is_enabled: true, has_credits: false, last_error_at: '2020-01-01' }), false)
  assert.equal(_internals.providerEligible({ is_enabled: true, has_credits: true }), true)
  assert.equal(_internals.providerEligible({ is_enabled: false, has_credits: true }), false)
})
