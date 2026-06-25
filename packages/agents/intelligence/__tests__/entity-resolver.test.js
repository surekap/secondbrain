const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeQuery, resolveEntityAlias } = require('../services/entity-resolver')

test('entity-resolver: normalizes whitespace and case', () => {
  assert.equal(normalizeQuery('  Dr.   Anupama  '), 'dr. anupama')
})

test('entity-resolver: searches aliases and canonical names in one bounded query', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ entity_type: 'contact', entity_id: '1519', display_name: 'Dr. Anupama Sureka', matched_alias: 'Anupama', match_kind: 'alias_exact', confidence: '0.95', score: '95.00' }] }
    }
  }

  const rows = await resolveEntityAlias(pool, 'Anupama', { limit: 5, types: ['contact'] })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].entity_type, 'contact')
  assert.equal(rows[0].entity_id, '1519')
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /intelligence\.entity_aliases/)
  assert.match(calls[0].sql, /relationships\.contacts/)
  assert.equal(calls[0].params[0], 'anupama')
  assert.deepEqual(calls[0].params[2], ['contact'])
})

test('entity-resolver: rejects empty queries without hitting database', async () => {
  const pool = { async query() { throw new Error('should not query') } }
  const rows = await resolveEntityAlias(pool, '   ')
  assert.deepEqual(rows, [])
})

test('entity-resolver: caps limit and defaults to contacts and organizations', async () => {
  const pool = {
    async query(sql, params) {
      assert.equal(params[3], 50)
      assert.deepEqual(params[2], ['contact', 'organization'])
      return { rows: [] }
    }
  }
  await resolveEntityAlias(pool, 'rahul', { limit: 500 })
})
