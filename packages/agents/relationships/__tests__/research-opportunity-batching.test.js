'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const db = require('@secondbrain/db')
const llm = require('../../shared/llm')
const caching = require('../../shared/caching')
const {
  batchResearchOpportunities,
  detectResearchOpportunities,
  validateResearchOpportunityBatch,
} = require('../services/opportunities')

test('research batches preserve complete contact inputs', () => {
  const items = ['1', '2', '3'].map(contactId => ({
    input: { contact_id: contactId, research: contactId.repeat(10) },
  }))
  const batches = batchResearchOpportunities(items, { maxItems: 2, maxChars: 100000 })
  assert.deepEqual(batches.map(batch => batch.map(item => item.input.contact_id)), [['1', '2'], ['3']])
})

test('research receipts must acknowledge explicit null decisions', () => {
  const batch = [{ input: { contact_id: '1' } }, { input: { contact_id: '2' } }]
  assert.throws(
    () => validateResearchOpportunityBatch({ contacts: [{ contact_id: '1', opportunity: null }] }, batch),
    /acknowledged 1\/2 contacts/,
  )
  assert.throws(
    () => validateResearchOpportunityBatch({ contacts: [{ contact_id: '1' }, { contact_id: '2', opportunity: null }] }, batch),
    /acknowledged 1\/2 contacts/,
  )
  const results = validateResearchOpportunityBatch({ contacts: [
    { contact_id: '1', opportunity: null },
    { contact_id: '2', opportunity: { title: 'Reach out' } },
  ] }, batch)
  assert.equal(results.get('1'), null)
  assert.equal(results.get('2').title, 'Reach out')
})

test('research opportunity synthesis uses one reasoning call and durably caches nulls', async t => {
  const originals = {
    query: db.query,
    create: llm.create,
    filter: caching.filterUnprocessedItems,
    record: caching.recordProcessed,
  }
  t.after(() => {
    db.query = originals.query
    llm.create = originals.create
    caching.filterUnprocessedItems = originals.filter
    caching.recordProcessed = originals.record
  })

  db.query = async sql => {
    if (sql.includes('contact_research')) return { rows: [
      { contact_id: 1, display_name: 'Alpha', company: 'A Co', source: 'news', summary: 'Alpha launched a product.' },
      { contact_id: 2, display_name: 'Beta', company: 'B Co', source: 'news', summary: 'Beta profile refreshed.' },
    ] }
    if (sql.includes('source_ref = ANY')) return { rows: [] }
    throw new Error(`Unexpected query: ${sql}`)
  }
  caching.filterUnprocessedItems = async (_agent, _type, items) => items
  const cached = []
  caching.recordProcessed = async (...args) => cached.push(args)

  const prompts = []
  llm.create = async (_agent, options) => {
    prompts.push(options.messages[0].content)
    return { text: JSON.stringify({ contacts: [
      { contact_id: '1', opportunity: { title: 'Congratulate Alpha', description: 'A launch.', priority: 'medium' } },
      { contact_id: '2', opportunity: null },
    ] }) }
  }

  const insights = await detectResearchOpportunities(null)

  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Alpha launched a product/)
  assert.match(prompts[0], /Beta profile refreshed/)
  assert.equal(insights.length, 1)
  assert.match(insights[0].source_ref, /^research:1:[a-f0-9]{16}$/)
  assert.equal(cached.length, 1)
  assert.equal(cached[0][3].contact_id, '2')
})
