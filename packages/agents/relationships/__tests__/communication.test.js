'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  whatsappSourceId,
  messageTextForAnalysis,
  buildMediaSnippetAndMeta,
  groupAuthorJid,
  upsertCanonicalCommunication,
  upsertGroupCommunications,
  resolveDirectContact,
  upsertLimitlessCommunications,
  upsertDirectCommunications,
  upsertEmailCommunications,
} = require('../services/communication')

function canonicalPool(options = {}) {
  const stored = new Map()
  const calls = []
  let nextId = 1
  return {
    stored,
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/SELECT contact_id/.test(sql)) {
        return { rows: options.contactId ? [{ contact_id: options.contactId }] : [] }
      }
      if (/INSERT INTO relationships\.communications/.test(sql)) {
        const sourceId = params[2]
        const previous = stored.get(sourceId)
        const row = previous || { id: nextId++ }
        Object.assign(row, {
          contact_id: params[0],
          content_snippet: params[4],
          chat_id: params[6],
          group_name: params[8],
          metadata: JSON.parse(params[11]),
        })
        stored.set(sourceId, row)
        return { rows: [{ id: row.id, inserted: !previous, identity_corrected: false }] }
      }
      return { rows: [] }
    },
  }
}

test('communications prefer immutable WhatsApp IDs and deterministic fallbacks', () => {
  assert.equal(whatsappSourceId({ wa_msg_id: 'true_9199_ABC' }, '9199@c.us'), 'wa:true_9199_ABC')

  const message = { ts: '2026-07-20T10:00:00Z', from_me: false, body: 'hello', msg_type: 'chat' }
  const first = whatsappSourceId(message, '9199@c.us')
  const second = whatsappSourceId(message, '9199@c.us')
  assert.equal(first, second)
  assert.match(first, /^wa:fallback:[a-f0-9]{24}$/)

  assert.equal(
    whatsappSourceId({ ...message, source_row_id: 1 }, '9199@c.us'),
    whatsappSourceId({ ...message, source_row_id: 999 }, '9199@c.us'),
    'duplicated raw rows without a native ID converge on the same fallback event'
  )
})

test('media semantic text becomes analyzable communication evidence', () => {
  const message = {
    msg_type: 'document',
    filename: 'proposal.pdf',
    body: '',
    wa_msg_id: 'doc-1',
    semantic_text: 'Proposal requests approval by 25 July and names Mira as owner.',
    analysis_kind: 'pdf_summary',
  }
  const text = messageTextForAnalysis(message)
  const { snippet, metadata } = buildMediaSnippetAndMeta(message)

  assert.match(text, /requests approval by 25 July/)
  assert.match(snippet, /requests approval by 25 July/)
  assert.equal(metadata.wa_msg_id, 'doc-1')
  assert.equal(metadata.media_analysis_kind, 'pdf_summary')
})

test('group communications use stable author identity without name matching', async () => {
  const pool = canonicalPool({ contactId: 42 })
  const message = {
    wa_msg_id: 'group-message-1',
    participant: '919876543210@s.whatsapp.net',
    notify_name: 'Display Name Is Not Identity',
    body: 'We need to decide by Friday.',
    msg_type: 'chat',
    ts: '2026-07-20T10:00:00Z',
  }

  assert.equal(groupAuthorJid(message), '919876543210@c.us')
  const result = await upsertGroupCommunications(pool, [message], {
    chat_id: 'group@g.us', group_name: 'Decision Group',
  })
  assert.deepEqual(result, { inserted: 1, updated: 0, linked: 1, fallback_ids: 0, skipped: 0 })

  const lookupSql = pool.calls.filter(call => /contact_identities/.test(call.sql)).map(call => call.sql).join('\n')
  assert.doesNotMatch(lookupSql, /normalized_name/)
  const insert = pool.calls.find(call => /INSERT INTO relationships\.communications/.test(call.sql))
  assert.equal(insert.params[0], 42)
  assert.equal(insert.params[2], 'wa:group-message-1')
  assert.equal(insert.params[3], 'group')
  assert.equal(insert.params[7], true)
  assert.match(insert.params[11], /"author_jid":"919876543210@c\.us"/)
})

test('group communications retain privacy-preserving LID author identity', async () => {
  const pool = canonicalPool({ contactId: 42 })
  const result = await upsertGroupCommunications(pool, [{
    wa_msg_id: 'group-lid-message-1',
    participant: '121234567890123@lid',
    notify_name: 'Known Group Member',
    body: 'Please confirm the project decision.',
    ts: '2026-07-20T10:00:00Z',
  }], { chat_id: 'group@g.us', group_name: 'Decision Group' })

  assert.deepEqual(result, { inserted: 1, updated: 0, linked: 1, fallback_ids: 0, skipped: 0 })
  const stored = pool.stored.get('wa:group-lid-message-1')
  assert.equal(stored.contact_id, 42)
  assert.match(JSON.stringify(stored.metadata), /121234567890123@lid/)
})

test('name-less stable LIDs create synthetic provider-scoped profiles without person matching', async () => {
  const calls = []
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/SELECT contact_id/.test(sql)) return { rows: [] }
      if (/INSERT INTO relationships\.contacts/.test(sql)) return { rows: [{ id: 77 }] }
      if (/INSERT INTO relationships\.contact_identities/.test(sql)) {
        return { rows: [{ id: 1, contact_id: 77 }] }
      }
      return { rows: [] }
    },
  }

  assert.equal(await resolveDirectContact(pool, '121234567890123@lid', null), 77)
  const created = calls.find(call => /INSERT INTO relationships\.contacts/.test(call.sql))
  assert.match(created.params[0], /^WhatsApp participant [a-f0-9]{8}$/)
  assert.equal(JSON.parse(created.params[3]).display_name_is_synthetic, true)
  assert.ok(calls.every(call => !/normalized_name\)\s*=|LOWER\(BTRIM\(display_name\)\)/.test(call.sql)))
})

test('unresolved group authors and Limitless events remain retry-idempotent canonical rows', async () => {
  const pool = canonicalPool()

  await upsertGroupCommunications(pool, [{
    wa_msg_id: 'unknown-author', body: 'Status update', msg_type: 'chat', ts: '2026-07-20T11:00:00Z',
  }], { chat_id: 'group@g.us' })
  await upsertLimitlessCommunications(pool, [{
    id: 7, title: 'Customer call', markdown_preview: 'The customer raised a delivery risk.', start_time: '2026-07-20T12:00:00Z',
  }])

  const inserts = pool.calls.filter(call => /INSERT INTO relationships\.communications/.test(call.sql))
  assert.equal(inserts[0].params[0], null)
  assert.equal(inserts[1].params[2], 'limitless:7')
  assert.ok(inserts.every(call => /ON CONFLICT \(source, source_id\) DO UPDATE/.test(call.sql)))
  assert.equal(pool.stored.size, 2)
})

test('email recovery handles more than the old 20-message sample and converges on rerun', async () => {
  const pool = canonicalPool()
  const emails = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    contact_id: 42,
    from_address: 'person@example.com',
    subject: `Message ${index + 1}`,
    body_text: 'Historical communication',
    date: new Date(2026, 0, index + 1).toISOString(),
  }))

  assert.deepEqual(await upsertEmailCommunications(pool, emails), { inserted: 25, updated: 0, unresolved: 0 })
  assert.deepEqual(await upsertEmailCommunications(pool, emails), { inserted: 0, updated: 25, unresolved: 0 })
  assert.equal(pool.stored.size, 25)
})

test('direct WhatsApp recovery handles more than the old 50-message sample and converges', async () => {
  const pool = canonicalPool({ contactId: 42 })
  const messages = Array.from({ length: 60 }, (_, index) => ({
    chat_id: '919876543210@c.us',
    wa_msg_id: `direct-${index + 1}`,
    from_me: index % 2 === 0,
    body: `Historical message ${index + 1}`,
    msg_type: 'chat',
    ts: new Date(2026, 0, 1, 0, index).toISOString(),
  }))

  assert.deepEqual(await upsertDirectCommunications(pool, messages), { inserted: 60, updated: 0, unresolved: 0, fallback_ids: 0, skipped: 0 })
  assert.deepEqual(await upsertDirectCommunications(pool, messages), { inserted: 0, updated: 60, unresolved: 0, fallback_ids: 0, skipped: 0 })
  assert.equal(pool.stored.size, 60)
})

test('unmapped LID direct messages remain retryable instead of being guessed as a phone contact', async () => {
  const pool = canonicalPool()
  const result = await upsertDirectCommunications(pool, [{
    chat_id: '121234567890123@lid',
    wa_msg_id: 'lid-direct-1',
    from_me: false,
    body: 'A legitimate privacy-preserving direct message',
    msg_type: 'chat',
    ts: '2026-07-20T10:00:00Z',
  }])
  assert.deepEqual(result, { inserted: 1, updated: 0, unresolved: 1, fallback_ids: 0, skipped: 0 })
  assert.equal(pool.stored.get('wa:lid-direct-1').contact_id, null)
  assert.equal(pool.stored.get('wa:lid-direct-1').chat_id, '121234567890123@lid')
  assert.equal(pool.calls.some(call => /contact_identities/.test(call.sql)), true)
})

test('a stable LID identity links direct messages without pretending it is a phone number', async () => {
  const pool = canonicalPool({ contactId: 42 })
  const result = await upsertDirectCommunications(pool, [{
    chat_id: '121234567890123@lid',
    wa_msg_id: 'known-lid-direct-1',
    body: 'A direct message from an already known LID',
    ts: '2026-07-20T10:00:00Z',
  }])
  assert.deepEqual(result, { inserted: 1, updated: 0, unresolved: 0, fallback_ids: 0, skipped: 0 })
  assert.equal(pool.stored.get('wa:known-lid-direct-1').contact_id, 42)
})

test('mixed recovery group rows retain their own chat and group context', async () => {
  const pool = canonicalPool()
  await upsertGroupCommunications(pool, [
    { chat_id: 'one@g.us', group_name: 'One', wa_msg_id: 'g1', body: 'a', ts: '2026-07-20T10:00:00Z' },
    { chat_id: 'two@g.us', group_name: 'Two', wa_msg_id: 'g2', body: 'b', ts: '2026-07-20T10:01:00Z' },
  ])
  assert.equal(pool.stored.get('wa:g1').chat_id, 'one@g.us')
  assert.equal(pool.stored.get('wa:g1').group_name, 'One')
  assert.equal(pool.stored.get('wa:g2').chat_id, 'two@g.us')
  assert.equal(pool.stored.get('wa:g2').group_name, 'Two')
})

test('canonical media row refreshes when semantic analysis arrives later', async () => {
  const pool = canonicalPool({ contactId: 42 })
  const base = {
    chat_id: '919876543210@c.us', wa_msg_id: 'late-media', msg_type: 'image',
    body: '', ts: '2026-07-20T10:00:00Z',
  }
  assert.equal((await upsertDirectCommunications(pool, [base])).inserted, 1)
  assert.equal(pool.stored.get('wa:late-media').content_snippet, '📷 Photo')
  const refreshed = await upsertDirectCommunications(pool, [{
    ...base, semantic_text: 'A whiteboard lists a 25 July launch deadline.', analysis_kind: 'image_description',
  }])
  assert.equal(refreshed.updated, 1)
  assert.match(pool.stored.get('wa:late-media').content_snippet, /25 July launch deadline/)
  assert.equal(pool.stored.get('wa:late-media').metadata.media_analysis_kind, 'image_description')
  const sql = pool.calls.find(call => /INSERT INTO relationships\.communications/.test(call.sql)).sql
  assert.match(sql, /jsonb_strip_nulls\(EXCLUDED\.metadata\)/)
})

test('unresolved email is retained with sender and account provenance', async () => {
  const pool = canonicalPool()
  const result = await upsertEmailCommunications(pool, [{
    id: 88, date: null, created_at: '2026-07-20T09:00:00Z', account_id: 2, account_email: 'me@example.com',
    from_address: '"Person" <person@example.com>', sender_email: 'person@example.com',
    subject: 'Signal', body_text: 'Potential partnership',
  }])
  assert.deepEqual(result, { inserted: 1, updated: 0, unresolved: 1 })
  const event = pool.stored.get('email:88')
  assert.equal(event.contact_id, null)
  assert.equal(event.metadata.account_email, 'me@example.com')
  assert.equal(event.metadata.sender_email, 'person@example.com')
})

test('atomic canonical upsert converges concurrent NULL-contact writers', async () => {
  const pool = canonicalPool()
  const event = {
    contact_id: null,
    source: 'email',
    source_id: 'email:concurrent',
    content_snippet: 'same event',
    occurred_at: null,
  }
  const results = await Promise.all([
    upsertCanonicalCommunication(pool, event),
    upsertCanonicalCommunication(pool, event),
  ])
  assert.deepEqual(results.map(result => result.inserted), [true, false])
  assert.equal(pool.stored.size, 1)
  const sql = pool.calls.find(call => /INSERT INTO relationships\.communications/.test(call.sql)).sql
  assert.match(sql, /ON CONFLICT \(source, source_id\) DO UPDATE/)
  assert.match(sql, /INSERT INTO relationships\.communication_source_rows/)
  assert.match(sql, /ON CONFLICT \(source, source_row_id\) DO UPDATE/)
  assert.match(sql, /\(\$12::jsonb->>'source_row_id'\)::bigint/)
})

test('later exact sender identity supersedes stale contact association', async () => {
  const pool = canonicalPool({ contactId: 77 })
  const result = await upsertEmailCommunications(pool, [{
    id: 9,
    contact_id: 42,
    sender_email: 'person@example.com',
    from_address: 'person@example.com',
    date: '2026-07-20T10:00:00Z',
    subject: 'Correction',
  }])
  assert.equal(result.inserted, 1)
  assert.equal(pool.stored.get('email:9').contact_id, 77)
  const sql = pool.calls.find(call => /INSERT INTO relationships\.communications/.test(call.sql)).sql
  assert.match(sql, /contact_id = COALESCE\(EXCLUDED\.contact_id/)
  assert.match(sql, /INSERT INTO relationships\.communication_identity_conflicts/)
})
