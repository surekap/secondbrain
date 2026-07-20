const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeIdentityValue,
  normalizeIdentity,
  identitiesForContactLike,
  findContactByIdentity,
  upsertContactIdentity,
  recordContactIdentities,
  mergeContactRecords,
} = require('../services/identity')

test('identity: normalizes exact source identity values', () => {
  assert.equal(normalizeIdentityValue('email', ' Person@Example.COM '), 'person@example.com')
  assert.equal(normalizeIdentityValue('wa_jid', ' 919999999999@C.US '), '919999999999@c.us')
  assert.equal(normalizeIdentityValue('wa_jid', ' 121234567890123@LID '), '121234567890123@lid')
  assert.equal(normalizeIdentityValue('phone', '+91 99999-99999'), '919999999999')
  assert.equal(normalizeIdentityValue('phone', '   '), null)
  assert.equal(normalizeIdentityValue('wa_jid', '0@c.us'), null)
  assert.equal(normalizeIdentityValue('wa_jid', '0000000@c.us'), null)
  assert.equal(normalizeIdentityValue('phone', '0'), null)
  assert.equal(normalizeIdentityValue('phone', '0123456789'), null)
  assert.equal(normalizeIdentityValue('wa_jid', '919999999999@s.whatsapp.net'), '919999999999@c.us')
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
  assert.match(calls[0].sql, /DO NOTHING/)
  assert.equal(calls[0].params[0], 10)
})

test('identity: conflicting ownership is recorded without reassigning the identity', async () => {
  const calls = []
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/INSERT INTO relationships\.contact_identities/.test(sql)) return { rows: [] }
      if (/SELECT \*/.test(sql)) return { rows: [{ id: 5, contact_id: 10, identity_type: 'email', identity_value: 'person@example.com' }] }
      return { rows: [] }
    }
  }

  const row = await upsertContactIdentity(pool, 20, {
    source: 'email', identity_type: 'email', identity_value: 'Person@Example.com'
  })

  assert.equal(row.contact_id, 10)
  assert.equal(row.requested_contact_id, 20)
  assert.equal(row.conflict, true)
  const sql = calls.map(call => call.sql).join('\n')
  assert.match(sql, /INSERT INTO relationships\.identity_conflicts/)
  assert.doesNotMatch(sql, /DO UPDATE SET\s+contact_id/i)
})

test('identity: existing owner accepts fractional confidence without integer inference', async () => {
  const calls = []
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/INSERT INTO relationships\.contact_identities/.test(sql)) return { rows: [] }
      if (/SELECT \*/.test(sql)) return { rows: [{ id: 5, contact_id: 10, confidence: '0.8' }] }
      if (/UPDATE relationships\.contact_identities/.test(sql)) {
        return { rows: [{ id: 5, contact_id: 10, confidence: '0.98' }] }
      }
      return { rows: [] }
    },
  }
  const row = await upsertContactIdentity(pool, 10, {
    source: 'phone', identity_type: 'phone', identity_value: '+91 99999 99999', confidence: 0.98,
  })
  assert.equal(row.confidence, '0.98')
  const update = calls.find(call => /UPDATE relationships\.contact_identities/.test(call.sql))
  assert.match(update.sql, /\$2::numeric/)
  assert.equal(update.params[1], 0.98)
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
  assert.match(sql, /INSERT INTO relationships\.contact_merge_redirects/)
  assert.match(sql, /UPDATE projects\.project_communications SET contact_id/)
  assert.match(sql, /UPDATE projects\.communication_classifications SET contact_id/)
  assert.match(sql, /UPDATE projects\.projects\s+SET key_contact_ids/)
  assert.match(sql, /UPDATE intelligence\.communication_events SET source_contact_id/)
  assert.match(sql, /COMMIT/)
})

test('identity: optional missing intelligence schema rolls back to a savepoint and still commits', async () => {
  const calls = []
  let simulatedMissingTable = false
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/SELECT id, display_name/.test(sql)) return { rows: [
        { id: '10', display_name: 'Canonical', emails: [], phone_numbers: [], wa_jids: [], tags: [], manual_overrides: {} },
        { id: '11', display_name: 'Duplicate', emails: [], phone_numbers: [], wa_jids: [], tags: [], manual_overrides: {} },
      ] }
      if (!simulatedMissingTable && /UPDATE intelligence\.signals/.test(sql)) {
        simulatedMissingTable = true
        throw new Error('relation "intelligence.signals" does not exist')
      }
      return { rows: [] }
    }
  }

  const result = await mergeContactRecords(pool, '10', ['11'], { recordDecision: false })
  assert.equal(result.merged, 1)
  const sql = calls.map(call => call.sql).join('\n')
  assert.match(sql, /ROLLBACK TO SAVEPOINT merge_optional_/)
  assert.match(sql, /INSERT INTO relationships\.contact_merge_redirects/)
  assert.match(sql, /COMMIT/)
  assert.doesNotMatch(sql, /^ROLLBACK$/m)
})

test('identity: merge pins its transaction and savepoints to one pool client', async () => {
  const poolCalls = []
  const clientCalls = []
  let released = false
  const client = {
    async query(sql, params = []) {
      clientCalls.push({ sql, params })
      if (/SELECT id, display_name/.test(sql)) return { rows: [
        { id: '10', display_name: 'Canonical', emails: [], phone_numbers: [], wa_jids: [], tags: [], manual_overrides: {} },
        { id: '11', display_name: 'Duplicate', emails: [], phone_numbers: [], wa_jids: [], tags: [], manual_overrides: {} },
      ] }
      return { rows: [] }
    },
    release() { released = true },
  }
  const pool = {
    async query(sql, params = []) {
      poolCalls.push({ sql, params })
      return { rows: [] }
    },
    async connect() { return client },
  }

  await mergeContactRecords(pool, '10', ['11'], { recordDecision: false })
  assert.equal(released, true)
  assert.doesNotMatch(poolCalls.map(call => call.sql).join('\n'), /BEGIN|SAVEPOINT|COMMIT/)
  const transactionSql = clientCalls.map(call => call.sql).join('\n')
  assert.match(transactionSql, /BEGIN/)
  assert.match(transactionSql, /SAVEPOINT merge_optional_/)
  assert.match(transactionSql, /COMMIT/)
})
