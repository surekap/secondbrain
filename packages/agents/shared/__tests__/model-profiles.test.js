'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { MODEL_PROFILES, getProfilePolicy } = require('../model-profiles')
const { _internals } = require('../llm')

test('bulk structured work prefers Luna and retains cross-provider fallbacks', () => {
  const policy = getProfilePolicy('bulk_structured')
  assert.deepStrictEqual(policy.map(p => p.provider_type), ['openai', 'gemini', 'anthropic'])
  assert.strictEqual(policy[0].model, 'gpt-5.6-luna')
  assert.strictEqual(policy[0].reasoning_effort, 'low')
})

test('reasoning and tool profiles use Sol without routing every workload to it', () => {
  assert.strictEqual(MODEL_PROFILES.reasoning_synthesis[0].model, 'gpt-5.6-sol')
  assert.strictEqual(MODEL_PROFILES.autonomous_tools[0].model, 'gpt-5.6-sol')
  assert.strictEqual(MODEL_PROFILES.bulk_structured[0].model, 'gpt-5.6-luna')
})

test('unknown profiles fail closed', () => {
  assert.throws(() => getProfilePolicy('not-a-profile'), /unknown model profile/)
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
