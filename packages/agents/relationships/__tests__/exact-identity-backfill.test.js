const test = require('node:test')
const assert = require('node:assert/strict')
const {
  chooseCanonicalContact,
  findExactIdentityDuplicateGroups,
  runExactIdentityMerge,
} = require('../services/exact-identity-backfill')

test('exact-identity-backfill: chooses canonical by strategic score, touch, recency, id', () => {
  assert.equal(chooseCanonicalContact([
    { id: 20, strategic_importance_score: 50, next_suggested_touch_at: null, last_interaction_at: '2026-01-01T00:00:00Z' },
    { id: 10, strategic_importance_score: 80, next_suggested_touch_at: null, last_interaction_at: '2026-01-01T00:00:00Z' },
  ]), '10')
})

test('exact-identity-backfill: duplicate audit groups exact WhatsApp/email/phone identities', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ source: 'whatsapp', identity_type: 'wa_jid', identity_value: '9199@c.us', contact_ids: ['1', '2'], contact_count: 2 }] }
    }
  }
  const rows = await findExactIdentityDuplicateGroups(pool, { limit: 5 })
  assert.equal(rows.length, 1)
  assert.match(calls[0].sql, /unnest\(COALESCE\(c\.wa_jids/)
  assert.match(calls[0].sql, /unnest\(COALESCE\(c\.emails/)
  assert.match(calls[0].sql, /unnest\(COALESCE\(c\.phone_numbers/)
  assert.match(calls[0].sql, /c\.is_noise IS DISTINCT FROM TRUE/)
  assert.match(calls[0].sql, /HAVING COUNT\(DISTINCT contact_id\) > 1/)
  assert.equal(calls[0].params[0], 5)
})

test('exact-identity-backfill: dry-run does not merge', async () => {
  const calls = []
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/FROM grouped/.test(sql)) return { rows: [{ source: 'whatsapp', identity_type: 'wa_jid', identity_value: '9199@c.us', contact_ids: ['1', '2'], contact_count: 2 }] }
      if (/SELECT id, display_name/.test(sql)) return { rows: [
        { id: '1', display_name: 'A', strategic_importance_score: 90 },
        { id: '2', display_name: 'A', strategic_importance_score: 10 },
      ] }
      return { rows: [] }
    }
  }
  const result = await runExactIdentityMerge(pool, { write: false, limit: 1 })
  assert.equal(result.mode, 'dry-run')
  assert.equal(result.duplicate_groups, 1)
  assert.equal(result.groups[0].canonical_id, '1')
  assert.doesNotMatch(calls.map(c => c.sql).join('\n'), /UPDATE relationships\.communications SET contact_id/)
})
