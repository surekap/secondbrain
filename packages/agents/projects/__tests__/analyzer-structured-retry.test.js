'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createStructured } = require('../services/analyzer')

test('project analysis retries truncated structured output before any persistence', async () => {
  let calls = 0
  const result = await createStructured(
    { messages: [] },
    2,
    async () => {
      calls += 1
      return calls === 1
        ? { text: '{"status":"active","insights":[' }
        : { text: '{"status":"active","health":"on_track","insights":[]}' }
    },
  )

  assert.equal(calls, 2)
  assert.deepEqual(result, { status: 'active', health: 'on_track', insights: [] })
})

test('project analysis fails loudly after bounded structured retries', async () => {
  let calls = 0
  await assert.rejects(
    createStructured({}, 2, async () => {
      calls += 1
      return { text: '{"status":' }
    }),
    /invalid structured output after 2 attempts/,
  )
  assert.equal(calls, 2)
})
