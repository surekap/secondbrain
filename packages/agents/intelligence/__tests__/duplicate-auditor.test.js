const test = require('node:test')
const assert = require('node:assert/strict')
const {
  capLimit,
  normalizeNameKey,
  suggestedCanonical,
  auditDuplicateContacts,
  auditDuplicateOrganizations,
} = require('../services/duplicate-auditor')

test('duplicate-auditor: normalizes titles, punctuation, suffixes, and whitespace', () => {
  assert.equal(normalizeNameKey('Dr.  Anupama Sureka'), 'anupama sureka')
  assert.equal(normalizeNameKey('Eden Realty Ventures Pvt. Ltd.'), 'eden realty ventures')
  assert.equal(normalizeNameKey('Eden Realty Ventures Pvt'), 'eden realty ventures')
})

test('duplicate-auditor: suggests canonical by importance, obligation, recency, then id', () => {
  const canonical = suggestedCanonical([
    { id: 13, strategic_importance_score: 58, next_suggested_touch_at: null, last_interaction_at: '2026-01-01T00:00:00Z' },
    { id: 1519, strategic_importance_score: 88, next_suggested_touch_at: '2026-04-29T00:00:00Z', last_interaction_at: '2026-03-30T00:00:00Z' },
    { id: 7131, strategic_importance_score: 15, next_suggested_touch_at: null, last_interaction_at: null },
  ])
  assert.equal(canonical, 1519)
})

test('duplicate-auditor: contact audit is read-only and returns candidate groups', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ duplicate_key: 'anupama sureka', duplicate_count: 3, confidence: '0.95', suggested_canonical_id: '1519', entities: [] }] }
    }
  }

  const rows = await auditDuplicateContacts(pool, { limit: 5 })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].duplicate_key, 'anupama sureka')
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /relationships\.contacts/)
  assert.match(calls[0].sql, /duplicate_decisions/)
  assert.match(calls[0].sql, /d\.action IS DISTINCT FROM 'ignored'/)
  assert.match(calls[0].sql, /'decision_action', d\.action/)
  assert.match(calls[0].sql, /HAVING COUNT\(\*\) > 1/)
  assert.doesNotMatch(calls[0].sql, /\b(UPDATE|DELETE|MERGE)\b/i)
  assert.equal(calls[0].params[0], 5)
})

test('duplicate-auditor: organization audit is read-only and returns candidate groups', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ duplicate_key: 'eden realty ventures', duplicate_count: 2, confidence: '0.90', suggested_canonical_id: '63', entities: [] }] }
    }
  }

  const rows = await auditDuplicateOrganizations(pool, { limit: 500 })

  assert.equal(rows.length, 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /intelligence\.organizations/)
  assert.match(calls[0].sql, /duplicate_decisions/)
  assert.match(calls[0].sql, /d\.action IS DISTINCT FROM 'ignored'/)
  assert.match(calls[0].sql, /o\.sector/)
  assert.match(calls[0].sql, /'sector', sector/)
  assert.doesNotMatch(calls[0].sql, /o\.category/)
  assert.doesNotMatch(calls[0].sql, /'category', category/)
  assert.doesNotMatch(calls[0].sql, /\b(UPDATE|DELETE|MERGE)\b/i)
  assert.equal(calls[0].params[0], 100)
})
