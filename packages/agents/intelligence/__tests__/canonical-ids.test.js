const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeEntityId,
  canonicalizeEntityId,
  canonicalizeEntityIds,
} = require('../services/canonical-ids')

test('canonical-ids: normalizes numeric/text ids and skips blanks', () => {
  assert.equal(normalizeEntityId(1519), '1519')
  assert.equal(normalizeEntityId(' 013 '), '013')
  assert.equal(normalizeEntityId(''), null)
  assert.equal(normalizeEntityId(null), null)
})

test('canonical-ids: maps a confirmed duplicate id to canonical id', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ canonical_id: '1519' }] }
    }
  }

  const id = await canonicalizeEntityId(pool, 'contact', '13')

  assert.equal(id, '1519')
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /intelligence\.duplicate_decisions/)
  assert.match(calls[0].sql, /action = 'confirmed'/)
  assert.match(calls[0].sql, /\$2 = canonical_id OR \$2 = ANY\(duplicate_ids\)/)
  assert.deepEqual(calls[0].params, ['contact', '13'])
})

test('canonical-ids: returns original id when no confirmed decision exists', async () => {
  const pool = { async query() { return { rows: [] } } }
  assert.equal(await canonicalizeEntityId(pool, 'organization', 278), '278')
})

test('canonical-ids: batch maps ids and deduplicates canonical outputs preserving order', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [
        { input_id: '13', canonical_id: '1519' },
        { input_id: '7131', canonical_id: '1519' },
      ] }
    }
  }

  const ids = await canonicalizeEntityIds(pool, 'contact', [13, 1519, 7131, 13, null])

  assert.deepEqual(ids, ['1519'])
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /UNNEST\(\$2::text\[\]\)/)
  assert.deepEqual(calls[0].params, ['contact', ['13', '1519', '7131']])
})
