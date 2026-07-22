'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('@secondbrain/db')
const llm = require('../../shared/llm')
const caching = require('../../shared/caching')
const {
  batchCompleteConversations,
  extractMeetingActionItems,
  validateMeetingBatch,
} = require('../services/opportunities')

test('Limitless batching keeps each complete conversation intact', () => {
  const logs = [
    { id: 'a', markdown: 'a'.repeat(6) },
    { id: 'b', markdown: 'b'.repeat(6) },
    { id: 'c', markdown: 'c'.repeat(2) },
  ]
  const batches = batchCompleteConversations(logs, { maxItems: 25, maxChars: 10 })
  assert.deepEqual(batches.map(batch => batch.map(log => log.id)), [['a'], ['b', 'c']])
  assert.equal(batches[0][0].markdown.length, 6)
})

test('meeting batch receipts must acknowledge every input conversation', () => {
  const logs = [{ id: 'a' }, { id: 'b' }]
  assert.throws(
    () => validateMeetingBatch({ conversations: [{ lifelog_id: 'a', action_items: [] }] }, logs),
    /acknowledged 1\/2 conversations/,
  )
  assert.throws(
    () => validateMeetingBatch({ conversations: [{ lifelog_id: 'a' }, { lifelog_id: 'b', action_items: [] }] }, logs),
    /acknowledged 1\/2 conversations/,
  )
  const result = validateMeetingBatch({ conversations: [
    { lifelog_id: 'a', action_items: [] },
    { lifelog_id: 'b', action_items: [{ title: 'Follow up' }] },
  ] }, logs)
  assert.equal(result.get('a').length, 0)
  assert.equal(result.get('b')[0].title, 'Follow up')
})

test('meeting intelligence sends complete conversations in one model request and caches only empty results', async t => {
  const originals = {
    query: db.query,
    create: llm.create,
    recordProcessed: caching.recordProcessed,
  }
  t.after(() => {
    db.query = originals.query
    llm.create = originals.create
    caching.recordProcessed = originals.recordProcessed
  })

  const logs = [
    { id: 'a', title: 'Alpha', start_time: new Date('2026-07-20'), updated_at: new Date('2026-07-21'), markdown: `opening ${'x'.repeat(5000)} alpha-tail` },
    { id: 'b', title: 'Beta', start_time: new Date('2026-07-20'), updated_at: new Date('2026-07-21'), markdown: `opening ${'y'.repeat(5000)} beta-tail` },
  ]
  db.query = async () => ({ rows: logs })
  const prompts = []
  llm.create = async (_agent, options) => {
    prompts.push(options.messages[0].content)
    return { text: JSON.stringify({ conversations: [
      { lifelog_id: 'a', action_items: [{ title: 'Send proposal', description: 'Send it', priority: 'high', contact_name: null }] },
      { lifelog_id: 'b', action_items: [] },
    ] }) }
  }
  const cached = []
  caching.recordProcessed = async (...args) => cached.push(args)

  const insights = await extractMeetingActionItems(null)

  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /alpha-tail/)
  assert.match(prompts[0], /beta-tail/)
  assert.equal(insights.length, 1)
  assert.equal(insights[0].source_ref, 'lifelog:a')
  assert.deepEqual(cached.map(call => call[2]), ['b'])
})
