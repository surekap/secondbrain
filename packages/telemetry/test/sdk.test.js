// packages/telemetry/test/sdk.test.js
'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { generateId } = require('../ids')
const { shouldStoreFull } = require('../sampling')
const { scoreStructural } = require('../quality')

test('generateId returns a non-empty string', () => {
  const id = generateId()
  assert.equal(typeof id, 'string')
  assert.ok(id.length > 0)
})

test('generateId returns unique values', () => {
  assert.notEqual(generateId(), generateId())
})

test('shouldStoreFull returns true for failed request', () => {
  assert.ok(shouldStoreFull({ success: false, retryCount: 0, sampleRate: 0 }))
})

test('shouldStoreFull returns true for retried request', () => {
  assert.ok(shouldStoreFull({ success: true, retryCount: 1, sampleRate: 0 }))
})

test('shouldStoreFull returns false at 0% sample rate for clean request', () => {
  let count = 0
  for (let i = 0; i < 100; i++) {
    if (shouldStoreFull({ success: true, retryCount: 0, sampleRate: 0 })) count++
  }
  assert.equal(count, 0)
})

test('shouldStoreFull returns true for debug mode', () => {
  assert.ok(shouldStoreFull({ success: true, retryCount: 0, sampleRate: 0, debugMode: true }))
})

test('scoreStructural: valid JSON returns score 1', () => {
  const { score } = scoreStructural('{"a":1}', { expectJson: true })
  assert.equal(score, 1)
})

test('scoreStructural: invalid JSON returns score 0', () => {
  const { score, issues } = scoreStructural('not json at all', { expectJson: true })
  assert.equal(score, 0)
  assert.ok(issues.includes('invalid JSON'))
})

test('scoreStructural: missing required key reduces score', () => {
  const { score } = scoreStructural('{"a":1}', { expectJson: true, schema: { required: ['a','b'] } })
  assert.ok(score < 1)
})
