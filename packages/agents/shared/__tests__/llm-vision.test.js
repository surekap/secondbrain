'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { _internals } = require('../llm')

test('Ollama messages retain base64 image blocks for local vision models', () => {
  const messages = _internals.toOllamaMessages([{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
    ],
  }])

  assert.deepEqual(messages, [{
    role: 'user',
    content: 'Describe this image.',
    images: ['aGVsbG8='],
  }])
})

test('vision routing rejects providers whose adapters cannot carry images', async () => {
  assert.equal(await _internals.providerSupportsCapability({ provider_type: 'claude_cli' }, 'vision'), false)
  assert.equal(await _internals.providerSupportsCapability({ provider_type: 'groq' }, 'vision'), false)
  assert.equal(await _internals.providerSupportsCapability({ provider_type: 'openai' }, 'vision'), true)
  assert.equal(await _internals.providerSupportsCapability({ provider_type: 'gemini' }, 'vision'), true)
})

test('Ollama structured tasks disable thinking and enforce JSON output', () => {
  const params = _internals.buildOllamaParams(
    { model: 'gemma4:latest' },
    { messages: [{ role: 'user', content: 'Return JSON.' }], max_tokens: 600, expectJson: true }
  )

  assert.equal(params.format, 'json')
  assert.equal(params.think, false)
  assert.equal(params.options.num_predict, 600)
})
