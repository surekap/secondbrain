#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const {
  AgentSupervisorLease,
  commandRunsEntrypoint,
  findAgentProcesses,
  parseProcessTable,
  terminateProcesses,
} = require('../../packages/ui/services/agent-process-supervisor')
const { installProcessOutputGuard } = require('../../packages/agents/shared/process-output-guard')
const fs = require('node:fs')

const serverSource = fs.readFileSync(path.resolve(__dirname, '../../packages/ui/server.js'), 'utf8')

test('process discovery matches only exact Node entrypoint arguments and returns every duplicate', () => {
  const root = '/srv/secondbrain'
  const entrypoint = path.join(root, 'packages/agents/email/index.js')
  const table = [
    `  101     1 /usr/local/bin/node ${entrypoint}`,
    `  102     1 /usr/local/bin/node --require guard.js ${entrypoint}`,
    `  103     1 /bin/zsh -c node ${entrypoint}`,
    `  104     1 /usr/local/bin/node ${entrypoint}.backup`,
  ].join('\n')

  assert.equal(parseProcessTable(table).length, 4)
  assert.equal(commandRunsEntrypoint(`/usr/local/bin/node ${entrypoint}`, entrypoint, root), true)
  assert.equal(commandRunsEntrypoint(`/usr/local/bin/node ${entrypoint}.backup`, entrypoint, root), false)

  const matches = findAgentProcesses({ email: { entrypoint } }, {
    cwd: root,
    currentPid: 999,
    runPs: () => table,
  })
  assert.deepEqual(matches.get('email').map(({ pid }) => pid), [101, 102])
})

test('termination escalates only surviving validated process IDs', async () => {
  const alive = new Set([201, 202])
  const signals = []
  const kill = (pid, signal) => {
    if (signal === 0) {
      if (!alive.has(pid)) throw new Error('ESRCH')
      return
    }
    signals.push([pid, signal])
    if (pid === 201 || signal === 'SIGKILL') alive.delete(pid)
  }

  const result = await terminateProcesses([201, 202], { kill, graceMs: 1, pollMs: 1 })
  assert.deepEqual(result.forced, [202])
  assert.deepEqual(result.survivors, [])
  assert.deepEqual(signals, [
    [201, 'SIGTERM'],
    [202, 'SIGTERM'],
    [202, 'SIGKILL'],
  ])
})

test('database advisory lease permits exactly one supervisor owner and releases its session', async () => {
  const queries = []
  let released = 0
  const client = {
    query: async (sql, params) => {
      queries.push([sql, params])
      return { rows: [{ acquired: true }] }
    },
    release: () => { released += 1 },
  }
  const lease = new AgentSupervisorLease({ connect: async () => client })

  assert.equal(await lease.acquire(), true)
  await lease.release()
  assert.match(queries[0][0], /pg_try_advisory_lock/)
  assert.match(queries[1][0], /pg_advisory_unlock/)
  assert.equal(released, 1)
})

test('database advisory lease refuses a second supervisor owner', async () => {
  let released = 0
  const client = {
    query: async () => ({ rows: [{ acquired: false }] }),
    release: () => { released += 1 },
  }
  const lease = new AgentSupervisorLease({ connect: async () => client })

  await assert.rejects(lease.acquire(), { code: 'AGENT_SUPERVISOR_LEASE_HELD' })
  assert.equal(released, 1)
})

test('worker exits instead of recursively logging when an inherited output pipe breaks', () => {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const exits = []
  const mark = Symbol.for('secondbrain.processOutputGuardInstalled')
  const previous = process[mark]
  delete process[mark]
  try {
    assert.equal(installProcessOutputGuard({ stdout, stderr, exit: code => exits.push(code) }), true)
    stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    assert.deepEqual(exits, [1])
  } finally {
    if (previous === undefined) delete process[mark]
    else process[mark] = previous
  }
})

test('API process manager owns attached workers and reaps stale processes before restart', () => {
  assert.match(serverSource, /supervisorLease\.acquire\(\)/)
  assert.match(serverSource, /await reapOrphanedAgents\(\)/)
  assert.match(serverSource, /SECOND_BRAIN_PROCESS_OUTPUT_GUARD: '1'/)
  assert.match(serverSource, /detached: false/)
  assert.doesNotMatch(serverSource, /proc\.unref\(\)/)
  assert.match(serverSource, /await terminateProcesses\(managedProcesses/)
})
