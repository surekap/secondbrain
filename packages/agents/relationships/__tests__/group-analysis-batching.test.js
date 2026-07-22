'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const llm = require('../../shared/llm')
const {
  analyzeGroups,
  batchGroupAnalysisInputs,
  validateGroupAnalysisBatch,
} = require('../services/analyzer')

function group(id) {
  return { wa_chat_id: id, name: id, msg_count: 10, my_msg_count: 2 }
}

function message(ref, body) {
  return { source_id: ref, body, from_me: false, notify_name: 'Person' }
}

test('group batching respects complete-item count and character boundaries', () => {
  const items = [
    { group: group('a'), messages: [message('a:1', 'x'.repeat(100))] },
    { group: group('b'), messages: [message('b:1', 'y'.repeat(100))] },
    { group: group('c'), messages: [message('c:1', 'z')] },
  ]
  const batches = batchGroupAnalysisInputs(items, { maxItems: 2, maxChars: 100000 })
  assert.deepEqual(batches.map(batch => batch.map(item => item.input.group_id)), [['a', 'b'], ['c']])
  assert.match(batches[0][0].input.evidence[0].text, /x{100}/)
})

test('group batch receipts must acknowledge every input group', () => {
  const batch = [
    { input: { group_id: 'a' } },
    { input: { group_id: 'b' } },
  ]
  assert.throws(
    () => validateGroupAnalysisBatch({ groups: [{ group_id: 'a', analysis: {} }] }, batch),
    /acknowledged 1\/2 groups/,
  )
  assert.throws(
    () => validateGroupAnalysisBatch({ groups: [{ group_id: 'a' }, { group_id: 'b', analysis: {} }] }, batch),
    /acknowledged 1\/2 groups/,
  )
})

test('group analyzer shares one prompt and keeps evidence scoped to each group', async t => {
  const originalCreate = llm.create
  t.after(() => { llm.create = originalCreate })

  const prompts = []
  llm.create = async (_agent, options) => {
    prompts.push(options.messages[0].content)
    return { text: JSON.stringify({ groups: [
      {
        group_id: 'a',
        analysis: {
          group_type: 'community',
          opportunities: [{ title: 'Alpha', evidence_refs: ['a:1', 'b:1'] }],
        },
      },
      { group_id: 'b', analysis: { group_type: 'management', opportunities: [] } },
    ] }) }
  }

  const results = await analyzeGroups([
    { group: group('a'), messages: [message('a:1', `alpha ${'x'.repeat(450)} alpha-tail`)] },
    { group: group('b'), messages: [message('b:1', `beta ${'y'.repeat(450)} beta-tail`)] },
  ])

  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /alpha-tail/)
  assert.match(prompts[0], /beta-tail/)
  assert.deepEqual(results.get('a').opportunities[0].evidence_refs, ['a:1'])
  assert.equal(results.get('b').group_type, 'management')
})
