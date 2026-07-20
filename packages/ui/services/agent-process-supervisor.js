'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DEFAULT_GRACE_MS = 5_000
const DEFAULT_POLL_MS = 100
const SUPERVISOR_LEASE_KEY = 'secondbrain:agent-supervisor:v1'

function parseProcessTable(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3].trim(),
    }))
}

function commandRunsEntrypoint(command, entrypoint, cwd = process.cwd()) {
  const normalized = String(command || '').trim()
  const executable = normalized.split(/\s+/, 1)[0]?.replace(/^['"]|['"]$/g, '')
  if (path.basename(executable || '') !== 'node') return false

  const candidates = new Set([
    path.resolve(entrypoint),
    path.relative(cwd, path.resolve(entrypoint)),
  ])
  return [...candidates].some((candidate) => {
    if (!candidate || candidate === '.') return false
    const offset = normalized.indexOf(candidate)
    if (offset < 0) return false
    const before = offset === 0 ? ' ' : normalized[offset - 1]
    const after = normalized[offset + candidate.length] || ' '
    return /[\s'"]/.test(before) && /[\s'"]/.test(after)
  })
}

function findAgentProcesses(agentDefinitions, {
  cwd = process.cwd(),
  currentPid = process.pid,
  runPs = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
} = {}) {
  const processes = parseProcessTable(runPs())
  const matches = new Map()

  for (const [agentId, definition] of Object.entries(agentDefinitions)) {
    matches.set(agentId, processes.filter((candidate) => (
      candidate.pid !== currentPid
      && commandRunsEntrypoint(candidate.command, definition.entrypoint, cwd)
    )))
  }
  return matches
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminateProcesses(processes, {
  kill = process.kill,
  graceMs = DEFAULT_GRACE_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  const pids = [...new Set((processes || [])
    .map((processInfo) => Number(processInfo?.pid ?? processInfo))
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid))]

  for (const pid of pids) {
    try { kill(pid, 'SIGTERM') } catch {}
  }

  const deadline = Date.now() + Math.max(0, graceMs)
  let survivors = pids.filter((pid) => isAlive(pid, kill))
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    survivors = survivors.filter((pid) => isAlive(pid, kill))
  }

  const forced = [...survivors]
  for (const pid of forced) {
    try { kill(pid, 'SIGKILL') } catch {}
  }
  const forceDeadline = Date.now() + Math.min(1_000, Math.max(100, graceMs))
  survivors = forced.filter((pid) => isAlive(pid, kill))
  while (survivors.length > 0 && Date.now() < forceDeadline) {
    await delay(Math.min(pollMs, Math.max(1, forceDeadline - Date.now())))
    survivors = survivors.filter((pid) => isAlive(pid, kill))
  }

  return { requested: pids, forced, survivors }
}

class AgentSupervisorLease {
  constructor(pool, { key = SUPERVISOR_LEASE_KEY } = {}) {
    this.pool = pool
    this.key = key
    this.client = null
  }

  async acquire() {
    if (!this.pool?.connect) throw new Error('Agent supervisor requires a database connection')
    if (this.client) return true

    const client = await this.pool.connect()
    try {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [this.key],
      )
      if (!rows[0]?.acquired) {
        const error = new Error('Another SecondBrain agent supervisor already owns the runtime lease')
        error.code = 'AGENT_SUPERVISOR_LEASE_HELD'
        throw error
      }
      this.client = client
      return true
    } catch (error) {
      client.release()
      throw error
    }
  }

  ownsLease() {
    return this.client !== null
  }

  async release() {
    const client = this.client
    this.client = null
    if (!client) return
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.key])
    } finally {
      client.release()
    }
  }
}

module.exports = {
  AgentSupervisorLease,
  SUPERVISOR_LEASE_KEY,
  commandRunsEntrypoint,
  findAgentProcesses,
  parseProcessTable,
  terminateProcesses,
}
