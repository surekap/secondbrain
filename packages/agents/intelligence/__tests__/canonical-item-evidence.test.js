'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  CANONICAL_ITEM_EVIDENCE_TABLE,
  persistCanonicalItemEvidence,
  selectNewerRecurrenceEvidence,
  validateCanonicalItemEvidence,
} = require('../index')

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const schemaSource = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8')

test('item evidence rejects derived and raw tables before any database lookup', async () => {
  let queries = 0
  const pool = { async query() { queries++; return { rows: [{ ok: true }] } } }

  await assert.rejects(
    validateCanonicalItemEvidence(pool, { source_table: 'relationships.insights', source_id: 12 }),
    /must reference relationships\.communications/,
  )
  await assert.rejects(
    validateCanonicalItemEvidence(pool, { source_table: 'email.emails', source_id: 91 }),
    /must reference relationships\.communications/,
  )
  assert.equal(queries, 0)
})

test('item evidence accepts only a resolvable canonical communication', async () => {
  const seen = []
  const pool = {
    async query(sql, params) {
      seen.push({ sql: String(sql), params })
      return { rows: params[0] === '42' ? [{ exists: 1 }] : [] }
    },
  }

  const valid = await validateCanonicalItemEvidence(pool, {
    source_table: CANONICAL_ITEM_EVIDENCE_TABLE,
    source_id: 42,
    quote: 'Canonical evidence',
  })
  assert.equal(valid.source_id, '42')
  assert.equal(valid.quote, 'Canonical evidence')
  assert.match(seen[0].sql, /relationships\.communications/)
  assert.deepEqual(seen[0].params, ['42'])

  await assert.rejects(
    validateCanonicalItemEvidence(pool, { source_table: CANONICAL_ITEM_EVIDENCE_TABLE, source_id: 99 }),
    /does not resolve/,
  )
})

test('recurrence selection requires unseen canonical evidence newer than the terminal decision', () => {
  const item = { status: 'dismissed', terminal_at: '2026-07-10T10:00:00Z' }
  const seen = new Set(['relationships.communications:8'])
  const selected = selectNewerRecurrenceEvidence(item, [
    { source_table: 'email.emails', source_id: 99, occurred_at: '2026-07-20T10:00:00Z' },
    { source_table: CANONICAL_ITEM_EVIDENCE_TABLE, source_id: 7, occurred_at: '2026-07-10T10:00:00Z' },
    { source_table: CANONICAL_ITEM_EVIDENCE_TABLE, source_id: 8, occurred_at: '2026-07-18T10:00:00Z' },
    { source_table: CANONICAL_ITEM_EVIDENCE_TABLE, source_id: 9, occurred_at: '2026-07-19T10:00:00Z' },
    { source_table: CANONICAL_ITEM_EVIDENCE_TABLE, source_id: 10, occurred_at: '2026-07-20T10:00:00Z' },
  ], seen)

  assert.equal(selected.source_id, 10)
  assert.equal(selectNewerRecurrenceEvidence({ status: 'open', terminal_at: item.terminal_at }, [selected]), null)
})

test('terminal item stays terminal when persistence has no explicit recurrence decision', async () => {
  let connected = false
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ')
      if (normalized.includes('FROM relationships.communications')) return { rows: [{ exists: 1 }] }
      if (normalized.includes('FROM intelligence.opportunities')) {
        return { rows: [{ id: 5, status: 'actioned', lifecycle_state: 'resolved', terminal_at: '2026-07-10T10:00:00Z' }] }
      }
      throw new Error(`Unexpected query: ${normalized}`)
    },
    async connect() { connected = true; throw new Error('must not reopen') },
  }

  const result = await persistCanonicalItemEvidence(pool, 5, [{
    source_table: CANONICAL_ITEM_EVIDENCE_TABLE,
    source_id: 12,
    occurred_at: '2026-07-20T10:00:00Z',
  }])

  assert.deepEqual(result, { active: false, reopened: false, terminal: true })
  assert.equal(connected, false)
})

test('explicit recurrence reopens a terminal item only with unseen newer canonical evidence', async () => {
  const statements = []
  const terminal = { id: 5, status: 'expired', lifecycle_state: 'expired', terminal_at: '2026-07-10T10:00:00Z' }
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (normalized.startsWith('SELECT 1 FROM relationships.communications')) return { rows: [{ exists: 1 }] }
      if (normalized.includes('FROM intelligence.opportunities') && normalized.includes('FOR UPDATE')) return { rows: [terminal] }
      if (normalized.startsWith('INSERT INTO intelligence.opportunity_evidence')) return { rows: [{ id: 71 }] }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const pool = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT 1 FROM relationships.communications')) return { rows: [{ exists: 1 }] }
      if (normalized.includes('FROM intelligence.opportunities')) return { rows: [terminal] }
      if (normalized.includes('FROM intelligence.opportunity_evidence')) return { rows: [] }
      throw new Error(`Unexpected query: ${normalized}`)
    },
    async connect() { return client },
  }

  const result = await persistCanonicalItemEvidence(pool, 5, [{
    source_table: CANONICAL_ITEM_EVIDENCE_TABLE,
    source_id: 72,
    occurred_at: '2026-07-20T10:00:00Z',
  }], {
    reopen: { kind: 'recurrence', confidence: 0.9, reason: 'The condition recurred after newer communication' },
  })

  assert.deepEqual(result, { active: true, reopened: true, terminal: false })
  const reopen = statements.find(sql => sql.includes("SET status = 'open', lifecycle_state = 'active'"))
  assert.ok(reopen)
  assert.match(reopen, /expires_at = NULL/)
})

test('schema quarantines legacy noncanonical evidence and enforces the canonical source contract', () => {
  assert.match(schemaSource, /opportunity_evidence_canonical_source_check/)
  assert.match(schemaSource, /CHECK \(source_table = 'relationships\.communications'\)/)
  assert.match(schemaSource, /opportunity_evidence_quarantine/)
  assert.match(schemaSource, /lifecycle_state IN \('active', 'candidate'\)/)
})

test('derived writers keep provenance as metadata and stale email uses its canonical communication id', () => {
  const relationshipWriter = indexSource.slice(
    indexSource.indexOf('async function upsertFromRelationshipInsight'),
    indexSource.indexOf('async function upsertFromProjectInsight'),
  )
  const projectWriter = indexSource.slice(
    indexSource.indexOf('async function upsertFromProjectInsight'),
    indexSource.indexOf('async function reconcileProjectItems'),
  )
  const groupWriter = indexSource.slice(
    indexSource.indexOf('async function upsertFromGroupOpportunity'),
    indexSource.indexOf('async function upsertFromStaleEmailThread'),
  )
  const staleWriter = indexSource.slice(
    indexSource.indexOf('async function upsertFromStaleEmailThread'),
    indexSource.indexOf('async function runIntelligenceServices'),
  )

  for (const writer of [relationshipWriter, projectWriter, groupWriter]) {
    assert.doesNotMatch(writer, /source_table:\s*['"](?:relationships\.insights|projects\.project_insights|relationships\.groups)['"]/)
  }
  assert.match(staleWriter, /source_id:\s*thread\.latest_action_canonical_communication_id/)
  assert.doesNotMatch(staleWriter, /source_table:\s*['"]email\.emails['"]/)
})

test('item-candidate persistence failures are rethrown to the durable pipeline', () => {
  for (const message of [
    'Failed to backfill insight',
    'Failed to promote stale email thread',
    'Failed to promote cross-channel project signal',
    'Failed to promote relationship open loop',
    'Failed to promote home-improvement project opportunity',
    'Failed to create dormancy check-in',
  ]) {
    const start = indexSource.indexOf(message)
    assert.notEqual(start, -1, `missing durable pipeline error path: ${message}`)
    assert.match(indexSource.slice(start, start + 500), /throw error/)
  }
})
