const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeIdentityValue,
  normalizeIdentity,
  identitiesForContactLike,
  findContactByIdentity,
  recordContactIdentities,
  mergeContactRecords,
} = require('../services/identity')

test('identity: normalizes exact source identity values', () => {
  assert.equal(normalizeIdentityValue('email', ' Person@Example.COM '), 'person@example.com')
  assert.equal(normalizeIdentityValue('wa_jid', ' 919999999999@C.US '), '919999999999@c.us')
  assert.equal(normalizeIdentityValue('phone', '+91 99999-99999'), '919999999999')
  assert.equal(normalizeIdentityValue('phone', '   '), null)
})

test('identity: derives stable identities from contact-like rows', () => {
  const ids = identitiesForContactLike({
    wa_jids: ['919999999999@c.us'],
    emails: ['Person@Example.COM'],
    phone_numbers: ['+91 99999 99999'],
    apple_contact_id: 'apple-1',
  })
  assert.deepEqual(ids.map(i => [i.source, i.identity_type, i.identity_value]), [
    ['whatsapp', 'wa_jid', '919999999999@c.us'],
    ['email', 'email', 'person@example.com'],
    ['phone', 'phone', '919999999999'],
    ['apple_contacts', 'apple_contact_id', 'apple-1'],
  ])
})

test('identity: exact lookup uses source/type/value and ignores inactive identities', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ contact_id: 42 }] }
    }
  }
  const id = await findContactByIdentity(pool, { source: 'email', identity_type: 'email', identity_value: 'A@B.COM' })
  assert.equal(id, 42)
  assert.match(calls[0].sql, /relationships\.contact_identities/)
  assert.match(calls[0].sql, /is_active = TRUE/)
  assert.deepEqual(calls[0].params, ['email', 'email', 'a@b.com'])
})

test('identity: recording identities upserts active unique source identity rows', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ id: 1, contact_id: params[0] }] }
    }
  }
  const rows = await recordContactIdentities(pool, 10, [
    { source: 'whatsapp', identity_type: 'wa_jid', identity_value: '919999999999@c.us' },
  ])
  assert.equal(rows.length, 1)
  assert.match(calls[0].sql, /INSERT INTO relationships\.contact_identities/)
  assert.match(calls[0].sql, /ON CONFLICT \(source, identity_type, identity_value\) WHERE is_active/)
  assert.equal(calls[0].params[0], 10)
})

test('identity: merge moves dependent relationship and intelligence rows to canonical contact', async () => {
  const calls = []
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/SELECT id, display_name/.test(sql)) return { rows: [
        { id: '10', display_name: 'Canonical', emails: [], phone_numbers: [], wa_jids: [], tags: [], manual_overrides: {} },
        { id: '11', display_name: 'Duplicate', emails: ['d@example.com'], phone_numbers: ['9199'], wa_jids: ['9199@c.us'], tags: ['x'], manual_overrides: {} },
      ] }
      return { rows: [] }
    }
  }

  const result = await mergeContactRecords(pool, '10', ['11'], { duplicate_key: 'duplicate person', decided_by: 'test' })

  assert.deepEqual(result, { canonical_id: '10', duplicate_ids: ['11'], merged: 1 })
  const sql = calls.map(c => c.sql).join('\n')
  assert.match(sql, /BEGIN/)
  assert.match(sql, /UPDATE relationships\.communications SET contact_id = \$1::bigint/)
  assert.match(sql, /UPDATE relationships\.email_senders SET contact_id = \$1::bigint/)
  assert.match(sql, /UPDATE intelligence\.opportunities SET primary_contact_id = \$1::bigint/)
  assert.match(sql, /DELETE FROM intelligence\.entity_aliases d/)
  assert.match(sql, /d\.normalized_alias = c\.normalized_alias/)
  assert.match(sql, /DELETE FROM intelligence\.object_topics d/)
  assert.match(sql, /d\.topic_id = c\.topic_id/)
  assert.match(sql, /UPDATE intelligence\.entity_aliases/)
  assert.match(sql, /DELETE FROM relationships\.communications/)
  assert.match(sql, /INSERT INTO intelligence\.duplicate_decisions/)
  assert.match(sql, /COMMIT/)
})
