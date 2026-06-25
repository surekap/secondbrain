const test = require('node:test')
const assert = require('node:assert')
const { getProviderDefinitions, getStaticModels } = require('../model-catalog')

test('getProviderDefinitions: merges gemini embeddings (fixed) with chat (from OpenRouter)', async () => {
  const providers = await getProviderDefinitions()
  const gemini = providers.find(p => p.value === 'gemini')
  assert.ok(gemini, 'gemini provider should be present')
  assert.ok(gemini.capabilities.includes('embeddings'), 'gemini should keep its fixed embeddings capability')
  assert.ok(gemini.capabilities.includes('chat'), 'gemini should gain chat capability from OpenRouter')
})

test('getProviderDefinitions: filtering by embeddings excludes chat-only providers', async () => {
  const providers = await getProviderDefinitions('embeddings')
  const values = providers.map(p => p.value)
  assert.ok(values.includes('gemini'))
  assert.ok(values.includes('jina'))
  assert.ok(values.includes('ollama'))
  assert.ok(!values.includes('claude_cli'), 'claude_cli has no embeddings capability')
})

test('getStaticModels: only returns jina rows now', () => {
  const models = getStaticModels({})
  assert.ok(models.every(m => m.provider_type === 'jina'))
  assert.strictEqual(models.length, 2)
})
