'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { MODEL_PROFILES, getAgentProfileRequirements, getProfilePolicy } = require('../model-profiles')
const { _internals } = require('../llm')

test('bulk structured work defaults to Luna and fails closed without an explicit override', () => {
  const policy = getProfilePolicy('bulk_structured')
  assert.deepStrictEqual(policy.map(p => p.provider_type), ['openai'])
  assert.strictEqual(policy[0].model, 'gpt-5.6-luna')
  assert.strictEqual(policy[0].reasoning_effort, 'low')
})

test('synthesis uses Terra while autonomous tools retain Sol', () => {
  assert.deepStrictEqual(MODEL_PROFILES.reasoning_synthesis.map(p => p.provider_type), ['openai'])
  assert.strictEqual(MODEL_PROFILES.reasoning_synthesis[0].model, 'gpt-5.6-terra')
  assert.strictEqual(MODEL_PROFILES.reasoning_synthesis[0].reasoning_effort, 'high')
  assert.strictEqual(MODEL_PROFILES.autonomous_tools[0].model, 'gpt-5.6-sol')
  assert.strictEqual(MODEL_PROFILES.bulk_structured[0].model, 'gpt-5.6-luna')
})

test('automated profiles do not wake local Ollama models as a fallback', () => {
  for (const profile of ['bulk_structured', 'reasoning_synthesis', 'autonomous_tools']) {
    assert.equal(MODEL_PROFILES[profile].some(candidate => candidate.provider_type === 'ollama'), false)
  }
})

test('profiled workloads do not use the legacy Anthropic environment fallback', () => {
  const source = require('node:fs').readFileSync(require.resolve('../llm'), 'utf8')
  const emptyProviderBranch = source.slice(
    source.indexOf('if (providers.length === 0)'),
    source.indexOf('const errors = []'),
  )
  assert.match(emptyProviderBranch, /if \(profile\)[\s\S]+no eligible providers configured for profile/)
  assert.ok(emptyProviderBranch.indexOf('if (profile)') < emptyProviderBranch.indexOf('ANTHROPIC_API_KEY'))
})

test('unknown profiles fail closed', () => {
  assert.throws(() => getProfilePolicy('not-a-profile'), /unknown model profile/)
})

test('model-using agents declare their required workload profiles', () => {
  assert.deepStrictEqual(getAgentProfileRequirements('relationships'), ['bulk_structured', 'reasoning_synthesis'])
  assert.deepStrictEqual(getAgentProfileRequirements('projects'), ['bulk_structured', 'reasoning_synthesis'])
  assert.deepStrictEqual(getAgentProfileRequirements('intelligence'), ['reasoning_synthesis'])
  assert.deepStrictEqual(getAgentProfileRequirements('limitless'), [])
  assert.deepStrictEqual(getAgentProfileRequirements('email'), [])
})

test('profile routes accept the exact model through OpenRouter but reject model substitution', () => {
  const route = MODEL_PROFILES.bulk_structured[0]
  assert.equal(_internals.providerMatchesProfileRoute({ provider_type: 'openai', model: 'gpt-5.6-luna' }, route), true)
  assert.equal(_internals.providerMatchesProfileRoute({ provider_type: 'openai', model: 'openai/gpt-5.6-luna', base_url: 'https://openrouter.ai/api/v1' }, route), true)
  assert.equal(_internals.providerMatchesProfileRoute({ provider_type: 'x-ai', model: 'x-ai/grok-4.5' }, route), false)
})

test('explicit agent priority overrides the profile default and preserves order', () => {
  const policy = MODEL_PROFILES.bulk_structured
  const providers = _internals.selectConfiguredProfileProviders([
    { id: 14, name: 'xAI', provider_type: 'x-ai', model: 'x-ai/grok-4.5', is_enabled: true, has_credits: true, priority: 1 },
    { id: 2, name: 'OpenAI', provider_type: 'openai', model: 'gpt-5.6-luna', is_enabled: true, has_credits: false, priority: 2 },
    { id: 7, name: 'Groq', provider_type: 'groq', model: 'llama-3.3-70b-versatile', is_enabled: true, has_credits: true, priority: 3 },
  ], policy)

  assert.deepStrictEqual(providers.map(provider => provider.id), [14, 7])
  assert.equal(providers[0].reasoning_effort, undefined)
  assert.equal(providers[1].reasoning_effort, undefined)
})

test('profile defaults remain in force when no agent priority is configured', () => {
  assert.equal(_internals.selectConfiguredProfileProviders([
    { id: 2, provider_type: 'openai', model: 'gpt-5.6-luna', is_enabled: true, has_credits: true, priority: null },
  ], MODEL_PROFILES.bulk_structured), null)
})

test('OpenRouter chat requests preserve the configured model and profile effort', () => {
  const params = _internals.buildOpenRouterParams(
    { model: 'openai/gpt-5.6-luna', reasoning_effort: 'low' },
    { system: 'Return JSON.', messages: [{ role: 'user', content: 'Classify this.' }], max_tokens: 200 }
  )
  assert.equal(params.model, 'openai/gpt-5.6-luna')
  assert.deepStrictEqual(params.reasoning, { effort: 'low' })
  assert.equal(params.messages[0].role, 'system')
})

test('native providers with slash model IDs are not mistaken for OpenRouter', () => {
  assert.equal(_internals.isOpenRouterProvider({ provider_type: 'groq', model: 'openai/gpt-oss-120b' }), false)
  assert.equal(_internals.isOpenRouterProvider({ provider_type: 'x-ai', model: 'x-ai/grok-4.5' }), false)
  assert.equal(_internals.isOpenRouterProvider({ provider_type: 'deepseek', model: 'deepseek/deepseek-v4' }), true)
  assert.equal(_internals.isOpenRouterProvider({ provider_type: 'openai', model: 'openai/gpt-5.6-luna', base_url: 'https://openrouter.ai/api/v1' }), true)
})

test('xAI catalog model IDs normalize to the native API model name', () => {
  assert.equal(_internals.xaiModelId('x-ai/grok-4.5'), 'grok-4.5')
  assert.equal(_internals.xaiModelId('grok-4.5'), 'grok-4.5')
})

test('Responses input preserves tool-call state across an autonomous loop', () => {
  const input = _internals.toResponsesInput([
    { role: 'user', content: 'Find today\'s priorities' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', name: 'search', input: { q: 'priorities' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"count":2}' },
  ])
  assert.deepStrictEqual(input[1], {
    type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"priorities"}',
  })
  assert.deepStrictEqual(input[2], {
    type: 'function_call_output', call_id: 'call_1', output: '{"count":2}',
  })
})

test('Responses output maps function calls to the shared provider-neutral shape', () => {
  const parsed = _internals.parseResponsesResponse({
    id: 'resp_1',
    model: 'gpt-5.6-sol',
    output_text: '',
    output: [{ type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  })
  assert.deepStrictEqual(parsed.tool_calls, [{ id: 'call_1', name: 'search', input: { q: 'x' } }])
  assert.strictEqual(parsed.stop_reason, 'tool_use')
  assert.strictEqual(parsed.provider_response_id, 'resp_1')
})
