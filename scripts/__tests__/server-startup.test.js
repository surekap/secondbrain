#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  runServerStartup,
  terminateOnStartupFailure,
} = require('../../packages/ui/services/server-startup')

function startupDependencies(overrides = {}) {
  const calls = []
  return {
    calls,
    dependencies: {
      db: {},
      runSystemSchema: async () => { calls.push('schema') },
      runMigrations: async () => { calls.push('migrations') },
      migrateEnvToDb: async () => { calls.push('config') },
      ensurePuppeteerChrome: async () => { calls.push('chrome') },
      initializeAgentSupervisor: async () => { calls.push('supervisor') },
      onSupervisorError: (err) => { calls.push(`supervisor-error:${err.message}`) },
      listen: () => { calls.push('listen'); return 'server' },
      ...overrides,
    },
  }
}

test('required schema failure aborts before migrations, config, agent initialization, and listen', async () => {
  const { calls, dependencies } = startupDependencies({
    runSystemSchema: async () => {
      calls.push('schema')
      throw new Error('schema unavailable')
    },
  })

  await assert.rejects(runServerStartup(dependencies), /schema unavailable/)
  assert.deepEqual(calls, ['schema'])
})

test('ordered migration failure aborts before config migration, agent initialization, and listen', async () => {
  const { calls, dependencies } = startupDependencies({
    runMigrations: async () => {
      calls.push('migrations')
      throw new Error('ordered migration failed')
    },
  })

  await assert.rejects(runServerStartup(dependencies), /ordered migration failed/)
  assert.deepEqual(calls, ['schema', 'migrations'])
})

test('required config migration failure aborts before agent initialization and listen', async () => {
  const { calls, dependencies } = startupDependencies({
    migrateEnvToDb: async () => {
      calls.push('config')
      throw new Error('config migration failed')
    },
  })

  await assert.rejects(runServerStartup(dependencies), /config migration failed/)
  assert.deepEqual(calls, ['schema', 'migrations', 'config'])
})

test('startup failure is handled and terminates with a nonzero status', async () => {
  const errors = []
  const exits = []
  const cleanup = []
  const failure = Promise.reject(new Error('required migration failed'))

  await assert.doesNotReject(() => terminateOnStartupFailure(failure, {
    logger: { error: (...args) => errors.push(args) },
    beforeExit: async (error) => cleanup.push(error.message),
    exit: (status) => exits.push(status),
  }))

  assert.deepEqual(errors, [['[server] startup failed:', 'required migration failed']])
  assert.deepEqual(cleanup, ['required migration failed'])
  assert.deepEqual(exits, [1])
})

test('successful startup preserves initialization order', async () => {
  const { calls, dependencies } = startupDependencies()

  assert.equal(await runServerStartup(dependencies), 'server')
  assert.deepEqual(calls, ['schema', 'migrations', 'config', 'chrome', 'supervisor', 'listen'])
})
