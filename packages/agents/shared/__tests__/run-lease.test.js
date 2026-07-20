'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { acquireRunLease } = require('../run-lease')

test('run lease stays on its dedicated connection until explicit release', async () => {
  const calls = []
  let releases = 0
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows: [{ acquired: true }] }
    },
    release() { releases++ },
  }
  const lease = await acquireRunLease({ connect: async () => client }, 42)
  assert.equal(lease.acquired, true)
  assert.equal(releases, 0)
  await lease.release()
  await lease.release()
  assert.equal(releases, 1)
  assert.match(calls[0].sql, /pg_try_advisory_lock/)
  assert.match(calls[1].sql, /pg_advisory_unlock/)
})

test('contended lease releases its connection immediately', async () => {
  let releases = 0
  const client = {
    async query() { return { rows: [{ acquired: false }] } },
    release() { releases++ },
  }
  const lease = await acquireRunLease({ connect: async () => client }, 43)
  assert.equal(lease.acquired, false)
  assert.equal(releases, 1)
})
