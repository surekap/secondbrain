const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeAction,
  normalizeEntityType,
  upsertDuplicateDecision,
  listDuplicateDecisions,
} = require('../services/duplicate-decisions')

test('duplicate-decisions: validates action and entity type', () => {
  assert.equal(normalizeAction('confirm'), 'confirmed')
  assert.equal(normalizeAction('confirmed'), 'confirmed')
  assert.equal(normalizeAction('ignore'), 'ignored')
  assert.equal(normalizeAction('ignored'), 'ignored')
  assert.throws(() => normalizeAction('merge'), /Invalid duplicate decision action/)

  assert.equal(normalizeEntityType('contact'), 'contact')
  assert.equal(normalizeEntityType('organization'), 'organization')
  assert.throws(() => normalizeEntityType('project'), /Invalid duplicate entity type/)
})

test('duplicate-decisions: upserts non-destructive manual decision with canonical and duplicate ids', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ id: 7, entity_type: 'contact', duplicate_key: 'anupama sureka', action: 'confirmed' }] }
    }
  }

  const row = await upsertDuplicateDecision(pool, {
    entity_type: 'contact',
    duplicate_key: 'Anupama  Sureka',
    action: 'confirm',
    canonical_id: '1519',
    duplicate_ids: ['13', 7131],
    decided_by: 'prateek',
    note: 'same person',
  })

  assert.equal(row.action, 'confirmed')
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /INSERT INTO intelligence\.duplicate_decisions/)
  assert.match(calls[0].sql, /ON CONFLICT \(entity_type, duplicate_key\)/)
  assert.doesNotMatch(calls[0].sql, /\b(DELETE|MERGE)\b/i)
  assert.deepEqual(calls[0].params.slice(0, 5), ['contact', 'anupama sureka', 'confirmed', '1519', ['13', '7131']])
})

test('duplicate-decisions: listing can filter by entity type and action', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [] }
    }
  }

  await listDuplicateDecisions(pool, { entity_type: 'organization', action: 'ignored', limit: 500 })

  assert.match(calls[0].sql, /WHERE 1=1/)
  assert.match(calls[0].sql, /entity_type = \$1/)
  assert.match(calls[0].sql, /action = \$2/)
  assert.equal(calls[0].params[0], 'organization')
  assert.equal(calls[0].params[1], 'ignored')
  assert.equal(calls[0].params[2], 100)
})
