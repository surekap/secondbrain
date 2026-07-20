const test = require('node:test')
const assert = require('node:assert/strict')
const {
  chooseCanonicalContact,
  contradictoryStableIdentities,
  findExactIdentityDuplicateGroups,
  resolveCurrentContactIds,
  runExactIdentityMerge,
} = require('../services/exact-identity-backfill')

test('exact-identity-backfill: chooses canonical by strategic score, touch, recency, id', () => {
  assert.equal(chooseCanonicalContact([
    { id: 20, strategic_importance_score: 50, next_suggested_touch_at: null, last_interaction_at: '2026-01-01T00:00:00Z' },
    { id: 10, strategic_importance_score: 80, next_suggested_touch_at: null, last_interaction_at: '2026-01-01T00:00:00Z' },
  ]), '10')
  assert.equal(chooseCanonicalContact([
    { id: 1, is_noise: true, strategic_importance_score: 999 },
    { id: 2, is_noise: false, strategic_importance_score: 10 },
  ]), '2')
})

test('exact-identity-backfill: resolves redirect chains and quarantines terminal noise/cycles', async () => {
  let sql = ''
  const result = await resolveCurrentContactIds({
    async query(statement) {
      sql = statement
      return { rows: [
        { original_id: '3', current_id: '1', cycle: false, contact_exists: true, is_noise: false, has_redirect: false },
        { original_id: '4', current_id: '4', cycle: false, contact_exists: true, is_noise: true, has_redirect: false },
        { original_id: '5', current_id: '5', cycle: true, contact_exists: true, is_noise: false, has_redirect: true },
      ] }
    },
  }, ['3', '4', '5'])

  assert.deepEqual(result.current_ids, ['1'])
  assert.deepEqual(result.stale_contact_ids, ['3'])
  assert.deepEqual(result.unresolved_ids, ['4', '5'])
  assert.deepEqual(result.cycles, ['5'])
  assert.match(sql, /WITH RECURSIVE requested/)
  assert.match(sql, /contact_merge_redirects/)
  assert.match(sql, /redirect\.to_contact_id::text = ANY\(lineage\.path\)/)
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
  assert.match(calls[0].sql, /\[1-9\]\[0-9\]\{6,14\}@c/)
  assert.match(calls[0].sql, /REGEXP_REPLACE\(TRIM\(p\).+~ '\^\[1-9\]/s)
  assert.match(calls[0].sql, /HAVING COUNT\(DISTINCT contact_id\) > 1/)
  assert.equal(calls[0].params[0], 5)
})

test('exact-identity-backfill: contradictory stable identities require review', () => {
  assert.deepEqual(contradictoryStableIdentities([
    { emails: ['one@example.com'], phone_numbers: ['+919999999999'], wa_jids: ['919999999999@c.us'] },
    { emails: ['two@example.com'], phone_numbers: ['+919999999999'], wa_jids: ['919999999999@c.us'] },
  ], { identity_type: 'phone' }), ['email'])

  assert.deepEqual(contradictoryStableIdentities([
    { emails: ['same@example.com'], phone_numbers: ['+919999999999'] },
    { emails: ['same@example.com'], phone_numbers: ['+918888888888'] },
  ], { identity_type: 'email' }), ['phone'])

  assert.deepEqual(contradictoryStableIdentities([
    { apple_contact_id: 'apple-card-a', phone_numbers: ['+919999999999'], wa_jids: ['919999999999@c.us'] },
    { apple_contact_id: 'apple-card-b', phone_numbers: ['+919999999999'], wa_jids: ['919999999999@c.us'] },
  ], { identity_type: 'phone' }), [])
})

test('exact-identity-backfill: preserves distinct Apple cards as source identities before person merge', async () => {
  const groups = [{
    source: 'phone', identity_type: 'phone', identity_value: '919999999999',
    contact_ids: ['1', '2'], contact_count: 2,
  }]
  const contacts = [
    { id: '1', display_name: 'A', strategic_importance_score: 90, apple_contact_id: 'apple-a', phone_numbers: ['919999999999'], emails: [], wa_jids: [], is_noise: false },
    { id: '2', display_name: 'A duplicate', strategic_importance_score: 10, apple_contact_id: 'apple-b', phone_numbers: ['919999999999'], emails: [], wa_jids: [], is_noise: false },
  ]
  const pool = {
    async query(sql) {
      if (/FROM grouped/.test(sql)) return { rows: groups }
      if (/WITH RECURSIVE requested/.test(sql)) return { rows: [
        { original_id: '1', current_id: '1', cycle: false, contact_exists: true, is_noise: false, has_redirect: false },
        { original_id: '2', current_id: '2', cycle: false, contact_exists: true, is_noise: false, has_redirect: false },
      ] }
      if (/SELECT id, display_name/.test(sql)) return { rows: contacts }
      if (/SELECT id, emails, phone_numbers/.test(sql)) return { rows: [] }
      return { rows: [] }
    },
  }
  const appleWrites = []
  let mergeArgs = null
  const result = await runExactIdentityMerge(pool, {
    write: true,
    upsertContactIdentity: async (_, contactId, identityValue) => {
      appleWrites.push({ contact_id: String(contactId), ...identityValue })
      return { contact_id: contactId }
    },
    mergeContactRecords: async (_, canonicalId, duplicateIds) => {
      mergeArgs = { canonical_id: canonicalId, duplicate_ids: duplicateIds }
      return { merged: duplicateIds.length }
    },
  })

  assert.deepEqual(appleWrites.map(write => [write.contact_id, write.identity_value]), [
    ['1', 'apple-a'],
    ['2', 'apple-b'],
  ])
  assert.ok(appleWrites.every(write => write.identity_type === 'apple_contact_id'))
  assert.deepEqual(mergeArgs, { canonical_id: '1', duplicate_ids: ['2'] })
  assert.deepEqual(result.groups[0].preserved_apple_contact_ids, ['apple-a', 'apple-b'])
})

test('exact-identity-backfill: dry-run does not merge', async () => {
  const calls = []
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/FROM grouped/.test(sql)) return { rows: [{ source: 'whatsapp', identity_type: 'wa_jid', identity_value: '9199@c.us', contact_ids: ['1', '2'], contact_count: 2 }] }
      if (/WITH RECURSIVE requested/.test(sql)) return { rows: [
        { original_id: '1', current_id: '1', cycle: false, contact_exists: true, is_noise: false, has_redirect: false },
        { original_id: '2', current_id: '2', cycle: false, contact_exists: true, is_noise: false, has_redirect: false },
      ] }
      if (/SELECT id, display_name/.test(sql)) return { rows: [
        { id: '1', display_name: 'A', strategic_importance_score: 90, is_noise: false },
        { id: '2', display_name: 'A', strategic_importance_score: 10, is_noise: false },
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

test('exact-identity-backfill: overlapping groups re-resolve stale IDs after each merge', async () => {
  const redirects = new Map()
  const contacts = new Map([
    ['1', { id: '1', display_name: 'Canonical', strategic_importance_score: 100, emails: [], phone_numbers: [], wa_jids: [], is_noise: false }],
    ['2', { id: '2', display_name: 'Fragment A', strategic_importance_score: 20, emails: [], phone_numbers: [], wa_jids: [], is_noise: false }],
    ['3', { id: '3', display_name: 'Fragment B', strategic_importance_score: 30, emails: [], phone_numbers: [], wa_jids: [], is_noise: false }],
  ])
  const groups = [
    { source: 'whatsapp', identity_type: 'wa_jid', identity_value: '9199@c.us', contact_ids: ['1', '2'], contact_count: 2 },
    { source: 'phone', identity_type: 'phone', identity_value: '9199', contact_ids: ['2', '3'], contact_count: 2 },
    { source: 'email', identity_type: 'email', identity_value: 'same@example.com', contact_ids: ['1', '3'], contact_count: 2 },
  ]
  const resolve = id => {
    const seen = new Set()
    let current = String(id)
    while (redirects.has(current) && !seen.has(current)) {
      seen.add(current)
      current = redirects.get(current)
    }
    return current
  }
  const pool = {
    async query(sql, params = []) {
      if (/FROM grouped/.test(sql)) return { rows: groups }
      if (/WITH RECURSIVE requested/.test(sql)) {
        return { rows: params[0].map(originalId => {
          const currentId = resolve(originalId)
          const contact = contacts.get(currentId)
          return {
            original_id: String(originalId), current_id: currentId, cycle: false,
            contact_exists: Boolean(contact), is_noise: Boolean(contact?.is_noise), has_redirect: false,
          }
        }) }
      }
      if (/SELECT id, display_name/.test(sql)) {
        return { rows: params[0].map(String).map(id => contacts.get(id)).filter(row => row && !row.is_noise) }
      }
      if (/SELECT id, emails, phone_numbers/.test(sql)) return { rows: [] }
      return { rows: [] }
    },
  }
  const merges = []
  const mergeContactRecords = async (_, canonicalId, duplicateIds) => {
    merges.push({ canonical_id: canonicalId, duplicate_ids: [...duplicateIds] })
    for (const duplicateId of duplicateIds) {
      redirects.set(String(duplicateId), String(canonicalId))
      contacts.get(String(duplicateId)).is_noise = true
    }
    return { canonical_id: canonicalId, duplicate_ids: duplicateIds, merged: duplicateIds.length }
  }

  const result = await runExactIdentityMerge(pool, {
    write: true,
    limit: 10,
    mergeContactRecords,
  })

  assert.deepEqual(merges, [
    { canonical_id: '1', duplicate_ids: ['2'] },
    { canonical_id: '1', duplicate_ids: ['3'] },
  ])
  assert.equal(result.merged_groups, 2)
  assert.equal(result.already_converged_groups, 1)
  assert.equal(result.review_groups, 0)
  assert.deepEqual(result.groups[1].current_contact_ids, ['1', '3'])
  assert.equal(result.groups[2].already_converged, true)
  assert.deepEqual(result.groups[2].current_contact_ids, ['1'])
})
