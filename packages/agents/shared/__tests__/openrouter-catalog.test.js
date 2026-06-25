const test = require('node:test')
const assert = require('node:assert')
const {
  slugOf,
  providerForSlug,
  titleCase,
  deriveProviders,
  deriveModels,
} = require('../openrouter-catalog')

const FIXTURE_MODELS = [
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
  { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5' },
  { id: 'meta-llama/llama-3.3-70b', name: 'Llama 3.3 70B' },
  { id: 'no-slash-id', name: 'Malformed entry' },
]

test('slugOf: extracts vendor slug before first slash', () => {
  assert.strictEqual(slugOf('anthropic/claude-3.5-sonnet'), 'anthropic')
  assert.strictEqual(slugOf('meta-llama/llama-3.3-70b'), 'meta-llama')
})

test('slugOf: returns null for ids with no slash', () => {
  assert.strictEqual(slugOf('no-slash-id'), null)
})

test('titleCase: converts hyphenated/underscored slugs to display labels', () => {
  assert.strictEqual(titleCase('meta-llama'), 'Meta Llama')
  assert.strictEqual(titleCase('mistralai'), 'Mistralai')
})

test('providerForSlug: aliases google to canonical gemini', () => {
  assert.deepStrictEqual(providerForSlug('google'), { value: 'gemini', label: 'Gemini' })
})

test('providerForSlug: aliases moonshotai to canonical kimi', () => {
  assert.deepStrictEqual(providerForSlug('moonshotai'), { value: 'kimi', label: 'Kimi' })
})

test('providerForSlug: passes through unknown slugs using title-cased label', () => {
  assert.deepStrictEqual(providerForSlug('meta-llama'), { value: 'meta-llama', label: 'Meta Llama' })
})

test('deriveProviders: returns one entry per unique aliased slug, skipping malformed ids', () => {
  const providers = deriveProviders(FIXTURE_MODELS)
  const values = providers.map(p => p.value).sort()
  assert.deepStrictEqual(values, ['anthropic', 'gemini', 'kimi', 'meta-llama', 'openai'])
})

test('deriveProviders: every entry has chat capability and requires_api_key', () => {
  const providers = deriveProviders(FIXTURE_MODELS)
  for (const p of providers) {
    assert.deepStrictEqual(p.capabilities, ['chat'])
    assert.strictEqual(p.requires_api_key, true)
  }
})

test('deriveModels: filters to the aliased provider and maps fields', () => {
  const models = deriveModels(FIXTURE_MODELS, 'gemini')
  assert.deepStrictEqual(models, [
    { label: 'Gemini 2.5 Flash', value: 'google/gemini-2.5-flash', provider_type: 'gemini', capabilities: ['chat'] },
  ])
})

test('deriveModels: filters to a non-aliased provider using its raw slug', () => {
  const models = deriveModels(FIXTURE_MODELS, 'anthropic')
  assert.strictEqual(models.length, 2)
  assert.ok(models.every(m => m.provider_type === 'anthropic'))
})

test('deriveModels: returns empty array for a provider not present in the catalog', () => {
  assert.deepStrictEqual(deriveModels(FIXTURE_MODELS, 'cohere'), [])
})
