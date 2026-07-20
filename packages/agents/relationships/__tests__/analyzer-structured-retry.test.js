'use strict'

const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const llm = require('../../shared/llm')
const { createStructured } = require('../services/analyzer')

const originalCreate = llm.create
after(() => { llm.create = originalCreate })

test('structured analysis retries a truncated model response', async () => {
  let calls = 0
  llm.create = async () => {
    calls++
    return { text: calls === 1 ? '{"name":' : '{"name":"recovered"}' }
  }

  const result = await createStructured({ messages: [] })

  assert.equal(calls, 2)
  assert.deepEqual(result, { name: 'recovered' })
})

test('structured analysis fails loudly after the bounded retries', async () => {
  let calls = 0
  llm.create = async () => {
    calls++
    return { text: '{"name":' }
  }

  await assert.rejects(
    () => createStructured({ messages: [] }),
    /invalid structured output after 2 attempts/
  )
  assert.equal(calls, 2)
})
