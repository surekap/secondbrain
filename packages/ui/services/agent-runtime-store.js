'use strict'

const DEFAULT_RESTART_BASE_MS = 5_000
const DEFAULT_RESTART_MAX_MS = 5 * 60_000
const DEFAULT_STABLE_RUN_MS = 5 * 60_000

function restartDelayMs(failureCount, options = {}) {
  const baseMs = options.baseMs || DEFAULT_RESTART_BASE_MS
  const maxMs = options.maxMs || DEFAULT_RESTART_MAX_MS
  const exponent = Math.max(0, Math.min(Number(failureCount || 1) - 1, 20))
  return Math.min(maxMs, baseMs * (2 ** exponent))
}

class AgentRuntimeStore {
  constructor(db, options = {}) {
    this.db = db
    this.stableRunMs = options.stableRunMs || DEFAULT_STABLE_RUN_MS
    this.cache = new Map()
  }

  async initialize(coreAgentIds) {
    if (!this.db || coreAgentIds.length === 0) return
    await this.db.query(
      `INSERT INTO system.agent_runtime_state (agent_id, desired_state)
       SELECT agent_id, 'running'
       FROM unnest($1::text[]) AS agents(agent_id)
       ON CONFLICT (agent_id) DO NOTHING`,
      [coreAgentIds],
    )
    const { rows } = await this.db.query(
      `SELECT * FROM system.agent_runtime_state WHERE agent_id = ANY($1::text[])`,
      [coreAgentIds],
    )
    for (const row of rows) this.cache.set(row.agent_id, row)
  }

  get(agentId) {
    return this.cache.get(agentId) || null
  }

  async setDesired(agentId, desiredState) {
    if (!this.db) return null
    if (!['running', 'stopped'].includes(desiredState)) throw new Error(`Invalid desired state: ${desiredState}`)
    const { rows } = await this.db.query(
      `INSERT INTO system.agent_runtime_state (agent_id, desired_state)
       VALUES ($1, $2)
       ON CONFLICT (agent_id) DO UPDATE SET
         desired_state = EXCLUDED.desired_state,
         consecutive_failures = CASE WHEN EXCLUDED.desired_state = 'stopped' THEN 0 ELSE system.agent_runtime_state.consecutive_failures END,
         next_restart_at = NULL,
         last_error = CASE WHEN EXCLUDED.desired_state = 'stopped' THEN NULL ELSE system.agent_runtime_state.last_error END,
         updated_at = NOW()
       RETURNING *`,
      [agentId, desiredState],
    )
    this.cache.set(agentId, rows[0])
    return rows[0]
  }

  async markStarted(agentId) {
    if (!this.db) return null
    const { rows } = await this.db.query(
      `UPDATE system.agent_runtime_state
       SET last_started_at = NOW(), next_restart_at = NULL, last_error = NULL, updated_at = NOW()
       WHERE agent_id = $1
       RETURNING *`,
      [agentId],
    )
    if (rows[0]) this.cache.set(agentId, rows[0])
    return rows[0] || null
  }

  async markStopped(agentId, exitCode = null) {
    if (!this.db) return null
    const { rows } = await this.db.query(
      `UPDATE system.agent_runtime_state
       SET last_exit_at = NOW(), last_exit_code = $2, next_restart_at = NULL,
           consecutive_failures = 0, last_error = NULL, updated_at = NOW()
       WHERE agent_id = $1
       RETURNING *`,
      [agentId, exitCode],
    )
    if (rows[0]) this.cache.set(agentId, rows[0])
    return rows[0] || null
  }

  async markFailure(agentId, {
    exitCode = null,
    error = null,
    now = new Date(),
    resetAfterStableRun = true,
  } = {}) {
    if (!this.db) return null
    const current = this.get(agentId)
    if (!current || current.desired_state !== 'running') return current

    const lastStartedAt = current.last_started_at ? new Date(current.last_started_at).getTime() : 0
    const ranStably = resetAfterStableRun && lastStartedAt > 0 && now.getTime() - lastStartedAt >= this.stableRunMs
    const failureCount = ranStably ? 1 : Number(current.consecutive_failures || 0) + 1
    const nextRestartAt = new Date(now.getTime() + restartDelayMs(failureCount))
    const lastError = error ? String(error).slice(0, 2000) : null

    const { rows } = await this.db.query(
      `UPDATE system.agent_runtime_state
       SET consecutive_failures = $2,
           restart_count = restart_count + 1,
           last_exit_at = $3,
           last_exit_code = $4,
           last_error = $5,
           next_restart_at = $6,
           updated_at = NOW()
       WHERE agent_id = $1 AND desired_state = 'running'
       RETURNING *`,
      [agentId, failureCount, now, exitCode, lastError, nextRestartAt],
    )
    if (rows[0]) this.cache.set(agentId, rows[0])
    return rows[0] || null
  }
}

module.exports = {
  AgentRuntimeStore,
  DEFAULT_RESTART_BASE_MS,
  DEFAULT_RESTART_MAX_MS,
  restartDelayMs,
}
