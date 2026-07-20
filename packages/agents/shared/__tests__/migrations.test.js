#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  checksumSql,
  runMigrations,
} = require('../migrations')

class FakeMigrationClient {
  constructor() {
    this.ledger = new Map()
    this.executed = []
    this.failOnce = new Set()
    this.released = false
  }

  async query(sql, params = []) {
    const compact = sql.replace(/\s+/g, ' ').trim()
    if (/^SELECT pg_advisory_(lock|unlock)/.test(compact)) return { rows: [] }
    if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') return { rows: [] }

    if (/^SELECT version, name, checksum, status FROM system\.schema_migrations/.test(compact)) {
      const record = this.ledger.get(params[0])
      return { rows: record ? [{ ...record }] : [] }
    }

    if (/^INSERT INTO system\.schema_migrations/.test(compact)) {
      const [version, name, checksum] = params
      const previous = this.ledger.get(version)
      this.ledger.set(version, {
        version,
        name,
        checksum,
        status: 'running',
        started_at: new Date(),
        completed_at: null,
        error: null,
        attempt_count: (previous?.attempt_count || 0) + 1,
      })
      return { rows: [] }
    }

    if (/^UPDATE system\.schema_migrations SET status = 'completed'/.test(compact)) {
      Object.assign(this.ledger.get(params[0]), {
        status: 'completed',
        completed_at: new Date(),
        error: null,
      })
      return { rows: [] }
    }

    if (/^UPDATE system\.schema_migrations SET status = 'failed'/.test(compact)) {
      Object.assign(this.ledger.get(params[0]), {
        status: 'failed',
        completed_at: null,
        error: params[1],
      })
      return { rows: [] }
    }

    this.executed.push(compact)
    if (this.failOnce.delete(compact)) throw new Error(`simulated failure: ${compact}`)
    return { rows: [] }
  }

  release() {
    this.released = true
  }
}

function fakePool(client = new FakeMigrationClient()) {
  return {
    client,
    async connect() { return client },
  }
}

test('ordered migrations execute once and completed versions are skipped', async () => {
  const pool = fakePool()
  const migrations = [
    { version: '202607200002', name: 'second', sql: 'SELECT 2;' },
    { version: '202607200001', name: 'first', sql: 'SELECT 1;' },
  ]

  const first = await runMigrations(pool, migrations)
  const second = await runMigrations(pool, migrations)

  assert.deepEqual(first, { applied: ['202607200001', '202607200002'], skipped: [] })
  assert.deepEqual(second, { applied: [], skipped: ['202607200001', '202607200002'] })
  assert.deepEqual(pool.client.executed, ['SELECT 1;', 'SELECT 2;'])
  const record = pool.client.ledger.get('202607200001')
  assert.equal(record.status, 'completed')
  assert.equal(record.attempt_count, 1)
  assert.equal(record.checksum, checksumSql('SELECT 1;'))
  assert.ok(record.started_at instanceof Date)
  assert.ok(record.completed_at instanceof Date)
  assert.equal(record.error, null)
})

test('a failed migration records the error and retries the same checksum', async () => {
  const pool = fakePool()
  const migration = { version: '202607200003', name: 'retryable', sql: 'SELECT retry;' }
  pool.client.failOnce.add(migration.sql)

  await assert.rejects(runMigrations(pool, [migration]), /simulated failure/)
  const failed = pool.client.ledger.get(migration.version)
  assert.equal(failed.status, 'failed')
  assert.ok(failed.started_at instanceof Date)
  assert.equal(failed.completed_at, null)
  assert.match(failed.error, /simulated failure/)

  assert.deepEqual(await runMigrations(pool, [migration]), {
    applied: [migration.version],
    skipped: [],
  })
  const completed = pool.client.ledger.get(migration.version)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.attempt_count, 2)
})

test('a recorded version fails closed when its SQL checksum drifts', async () => {
  const pool = fakePool()
  const original = { version: '202607200004', name: 'immutable', sql: 'SELECT original;' }
  await runMigrations(pool, [original])

  const changed = { ...original, sql: 'SELECT changed;' }
  await assert.rejects(runMigrations(pool, [changed]), /checksum drift/)
  assert.equal(pool.client.ledger.get(original.version).checksum, checksumSql(original.sql))
  assert.deepEqual(pool.client.executed, ['SELECT original;'])
})
