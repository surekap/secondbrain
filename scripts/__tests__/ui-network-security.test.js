#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  configuredOrigins,
  isSameOriginMutation,
  secureTokenEqual,
} = require('../../packages/agents/shared/http-security')
const { AgentRuntimeStore, restartDelayMs } = require('../../packages/ui/services/agent-runtime-store')

const repo = path.resolve(__dirname, '../..')
const serverSource = fs.readFileSync(path.join(repo, 'packages/ui/server.js'), 'utf8')
const whatsappSource = fs.readFileSync(path.join(repo, 'packages/agents/whatsapp/src/app.js'), 'utf8')
const systemSchema = fs.readFileSync(path.join(repo, 'packages/agents/shared/sql/system-schema.sql'), 'utf8')
const uiPackage = JSON.parse(fs.readFileSync(path.join(repo, 'packages/ui/package.json'), 'utf8'))
const agentsPage = fs.readFileSync(path.join(repo, 'packages/ui/app/agents/page.jsx'), 'utf8')

function request(method, headers = {}, protocol = 'http') {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    method,
    protocol,
    get(name) { return normalized[String(name).toLowerCase()] },
  }
}

test('UI, API, and WhatsApp listeners bind to loopback by default', () => {
  assert.match(uiPackage.scripts.dev, /-H 127\.0\.0\.1/)
  assert.match(uiPackage.scripts.start, /-H 127\.0\.0\.1/)
  assert.match(serverSource, /SECOND_BRAIN_BIND_HOST \|\| '127\.0\.0\.1'/)
  assert.match(whatsappSource, /WHATSAPP_BIND_HOST \|\| '127\.0\.0\.1'/)
})

test('browser mutations require an allowed or request-matching Origin', () => {
  assert.equal(isSameOriginMutation(request('GET', { origin: 'https://evil.example' })), true)
  assert.equal(isSameOriginMutation(request('POST')), true, 'local non-browser callers may omit Origin')
  assert.equal(isSameOriginMutation(request('POST', {
    origin: 'https://evil.example',
    host: '127.0.0.1:4001',
    'sec-fetch-site': 'cross-site',
  })), false)
  assert.equal(isSameOriginMutation(request('PATCH', {
    origin: 'https://brain.example.ts.net',
    host: '127.0.0.1:4001',
  }), { allowedOrigins: configuredOrigins('https://brain.example.ts.net') }), true)
  assert.equal(isSameOriginMutation(request('DELETE', {
    origin: 'https://brain.example.ts.net',
    host: '127.0.0.1:4001',
    'x-forwarded-host': 'brain.example.ts.net',
    'x-forwarded-proto': 'https',
  })), true)
})

test('deploy tokens use constant-time digest comparison', () => {
  assert.equal(secureTokenEqual('a-long-random-secret', 'a-long-random-secret'), true)
  assert.equal(secureTokenEqual('a-long-random-secret', 'wrong'), false)
  assert.equal(secureTokenEqual('', ''), false)
})

test('core-agent restart delay is capped exponential backoff', () => {
  assert.equal(restartDelayMs(1), 5_000)
  assert.equal(restartDelayMs(2), 10_000)
  assert.equal(restartDelayMs(7), 300_000)
  assert.equal(restartDelayMs(20), 300_000)
})

test('startup failures do not reset backoff from a stale successful start', async () => {
  const db = {
    async query(_sql, params) {
      return { rows: [{
        agent_id: params[0],
        desired_state: 'running',
        consecutive_failures: params[1],
        restart_count: 1,
        last_started_at: new Date('2026-01-01T00:00:00Z'),
        next_restart_at: params[5],
      }] }
    },
  }
  const store = new AgentRuntimeStore(db)
  store.cache.set('projects', {
    agent_id: 'projects',
    desired_state: 'running',
    consecutive_failures: 3,
    last_started_at: new Date('2026-01-01T00:00:00Z'),
  })

  const state = await store.markFailure('projects', {
    error: 'preflight failed',
    now: new Date('2026-01-02T00:00:00Z'),
    resetAfterStableRun: false,
  })

  assert.equal(state.consecutive_failures, 4)
  assert.equal(new Date(state.next_restart_at).getTime(), new Date('2026-01-02T00:00:00Z').getTime() + 40_000)
})

test('agents UI exposes provider priority and profile health', () => {
  assert.match(agentsPage, /Provider priority/)
  assert.match(agentsPage, /llm-status/)
  assert.match(agentsPage, /LLM_PRIORITY_AGENT_IDS = new Set\(\['relationships', 'projects', 'intelligence', 'research'\]\)/)
  assert.doesNotMatch(agentsPage, /LLM_PRIORITY_AGENT_IDS = new Set\([^\n]*'limitless'/)
  assert.match(serverSource, /Blocked: no eligible provider/)
})

test('agents UI hides empty config tabs and renders importer configuration', () => {
  assert.match(agentsPage, /CONFIGURABLE_AGENT_IDS = new Set\(\['email', 'limitless', 'research', 'whatsapp', 'openai', 'gemini'\]\)/)
  assert.match(agentsPage, /tabsForAgent\(id\)\.map/)
  assert.match(agentsPage, /<AiImporterConfigForm agentId=\{id\}/)
  assert.doesNotMatch(agentsPage, /No configurable options for this agent/)
})

test('durable supervisor state is schema-owned and wired into lifecycle routes', () => {
  assert.match(systemSchema, /CREATE TABLE IF NOT EXISTS system\.agent_runtime_state/)
  assert.match(serverSource, /runtimeStore\.initialize\(CORE_AGENT_IDS\)/)
  assert.match(serverSource, /runtimeStore\.setDesired\(id, 'running'\)/)
  assert.match(serverSource, /runtimeStore\.setDesired\(id, 'stopped'\)/)
  assert.match(serverSource, /scheduleAgentRestart/)
  assert.match(serverSource, /superviseCoreAgents/)
  assert.match(agentsPage, /Cancel restart/)
})
