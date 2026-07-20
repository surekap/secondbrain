'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runCommunicationRecovery, loadResumeStats, validateCanonicalParticipantLinks } = require('../services/recovery')

test('raw WhatsApp recovery retains native-ID-missing rows for deterministic fallback identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
  const recoveryQuery = source.slice(
    source.indexOf('async function getWhatsAppRecoveryPage'),
    source.indexOf('async function getStaleMediaCommunications'),
  )
  assert.match(recoveryQuery, /m\.event IN \('message', 'message_create', 'message_historical'\)/)
  assert.doesNotMatch(recoveryQuery, /nativeWaIdSql\('m'\)\} IS NOT NULL/)
})

test('recovery advances bounded cursors until every source page is exhausted', async () => {
  const writes = { email: [], direct: [], group: [], limitless: [] }
  const checkpoints = []
  const order = []
  const client = {
    async query(sql, params = []) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ pg_advisory_unlock: true }] }
      if (/SELECT id, stats/.test(sql)) return { rows: [] }
      if (/INSERT INTO relationships\.communication_recovery_runs/.test(sql)) return { rows: [{ id: 91 }] }
      if (/UPDATE relationships\.communication_recovery_runs/.test(sql)) {
        checkpoints.push({ sql, params })
        return { rows: [] }
      }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { async connect() { return client } }
  const emails = Array.from({ length: 7 }, (_, i) => ({ source_row_id: i + 1, id: i + 1 }))
  const whatsapp = Array.from({ length: 7 }, (_, i) => ({
    source_row_id: i + 1,
    chat_id: i % 2 ? `group-${i}@g.us` : '919876543210@c.us',
    group_name: i % 2 ? `Group ${i}` : null,
    is_group: Boolean(i % 2),
    wa_msg_id: `wa-${i + 1}`,
    semantic_text: i === 5 ? 'Late media analysis' : null,
  }))
  const lifelogs = Array.from({ length: 7 }, (_, i) => ({ source_row_id: `l${i + 1}`, id: `l${i + 1}` }))
  const page = (rows, cursor, size) => rows.filter(row => row.source_row_id > cursor).slice(0, size)
  const source = {
    async getEmailRecoveryPage(cursor, size) { order.push('email'); return page(emails, Number(cursor), size) },
    async getWhatsAppRecoveryPage(cursor, size) { return page(whatsapp, Number(cursor), size) },
    async getLimitlessRecoveryPage(cursor, size) { return page(lifelogs, String(cursor), size) },
  }
  const store = {
    async upsertEmailCommunications(_, rows) { writes.email.push(...rows); return { inserted: rows.length } },
    async upsertDirectCommunications(_, rows) { writes.direct.push(...rows); return { inserted: rows.length } },
    async upsertGroupCommunications(_, rows) { writes.group.push(...rows); return { inserted: rows.length } },
    async upsertLimitlessCommunications(_, rows) { writes.limitless.push(...rows); return { inserted: rows.length } },
  }

  const lidStats = { version: '2026-07-20-lid-ownership-v1', communications_reassigned: 3 }
  const result = await runCommunicationRecovery(pool, {
    pageSize: 2,
    resume: false,
    source,
    store,
    async correctLidOwnership() { order.push('lid-correction'); return lidStats },
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.pages_processed, 12)
  assert.equal(result.stats.email.read, 7)
  assert.equal(result.stats.whatsapp.read, 7)
  assert.equal(result.stats.limitless.read, 7)
  assert.equal(result.stats.whatsapp.semantic_media_rows, 1)
  assert.deepEqual(result.stats.lid_ownership_correction, lidStats)
  assert.equal(order[0], 'lid-correction')
  assert.ok(Object.values(writes).every(rows => rows.length > 0))
  assert.equal(writes.group[0].group_name, 'Group 1')
  assert.ok(checkpoints.length >= result.pages_processed)
  assert.ok(['email', 'whatsapp', 'limitless'].every(name => result.stats[name].done))
})

test('post-recovery validation compares canonical participants with active WA/email identities', async () => {
  let sql = ''
  let params = []
  const result = await validateCanonicalParticipantLinks({
    async query(statement, values) {
      sql = statement
      params = values
      return { rows: [{ mismatches: 0, validated: 703 }] }
    },
  }, { selfJid: '919111111111@c.us' })
  assert.deepEqual(result, { mismatches: 0, validated: 703 })
  assert.match(sql, /ci\.identity_type = 'wa_jid'/)
  assert.match(sql, /ci\.identity_type = 'email'/)
  assert.match(sql, /communication\.contact_id IS DISTINCT FROM expected\.expected_contact_id/)
  assert.match(sql, /DISTINCT ON \(COALESCE\(NULLIF\(m\.wa_msg_id/)
  assert.match(sql, /m\.event IN \('message', 'message_create', 'message_historical'\)/)
  assert.match(sql, /CROSS JOIN LATERAL/)
  assert.match(sql, /\{id,remote/)
  assert.match(sql, /@lid/)
  assert.match(sql, /chat\.chat_id IS NOT NULL/)
  assert.match(sql, /\[1-9\]\[0-9\]\{6,14\}@c/)
  assert.deepEqual(params, ['919111111111@c.us'])
})

test('resume considers only the latest run so a completed retry consumes old failure state', async () => {
  let sql = ''
  const completed = await loadResumeStats({
    async query(statement) {
      sql = statement
      return { rows: [{ id: 3, status: 'completed', stats: { email: { done: true } } }] }
    },
  })
  assert.equal(completed, null)
  assert.doesNotMatch(sql, /WHERE status IN/)

  const failed = await loadResumeStats({
    async query() { return { rows: [{ id: 4, status: 'failed', stats: { email: { cursor: 9 } } }] } },
  })
  assert.equal(failed.id, 4)
})

test('recovery fails rather than looping when a source cursor does not advance', async () => {
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
      if (/SELECT id, stats/.test(sql)) return { rows: [] }
      if (/INSERT INTO relationships\.communication_recovery_runs/.test(sql)) return { rows: [{ id: 1 }] }
      return { rows: [] }
    },
    release() {},
  }
  const source = {
    async getEmailRecoveryPage() { return [{ source_row_id: 0, id: 1 }] },
    async getWhatsAppRecoveryPage() { return [] },
    async getLimitlessRecoveryPage() { return [] },
  }
  const store = {
    async upsertEmailCommunications() { return { inserted: 1 } },
  }
  await assert.rejects(
    runCommunicationRecovery({ async connect() { return client } }, { source, store, resume: false }),
    /cursor did not advance/
  )
})
