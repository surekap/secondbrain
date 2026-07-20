'use strict'

const os = require('os')
const db = require('@secondbrain/db')
const { ensureSchema, runIntelligenceServices } = require('../index')

const ADVISORY_LOCK_ID = 2072026

async function markStaleRuns(pool, staleAfterHours = 4) {
  const result = await pool.query(`
    UPDATE intelligence.pipeline_runs
    SET status = 'failed',
        error = COALESCE(error, 'Runner stopped before completion'),
        completed_at = NOW(), heartbeat_at = NOW()
    WHERE status = 'running'
      AND heartbeat_at < NOW() - ($1::text || ' hours')::interval
  `, [String(staleAfterHours)])
  return result.rowCount || 0
}

async function runDurableIntelligence(options = {}) {
  const pool = options.pool || db
  const trigger = options.trigger || 'manual'
  const runnerId = options.runner_id || `${os.hostname()}:${process.pid}`
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function' ? () => client.release() : () => {}
  let runId = null
  let locked = false
  try {
    await ensureSchema(client)
    await markStaleRuns(client)
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_ID])
    locked = lock.rows[0]?.acquired === true
    if (!locked) {
      const skipped = await client.query(`
        INSERT INTO intelligence.pipeline_runs (trigger, status, runner_id, error, completed_at)
        VALUES ($1, 'skipped', $2, 'Another intelligence runner owns the advisory lock', NOW())
        RETURNING id
      `, [trigger, runnerId])
      return { run_id: skipped.rows[0]?.id || null, status: 'skipped' }
    }

    const started = await client.query(`
      INSERT INTO intelligence.pipeline_runs (trigger, status, runner_id)
      VALUES ($1, 'running', $2)
      RETURNING id, started_at
    `, [trigger, runnerId])
    runId = started.rows[0].id
    // The advisory lock belongs to this dedicated client for the entire run.
    // Heartbeat/log writes must use the pool so they never overlap a pipeline
    // query on that same PostgreSQL connection.
    const heartbeatPool = pool !== client && typeof pool.query === 'function' ? pool : null

    const log = (level, message, meta = {}) => {
      const line = `[intelligence:${runId}] ${message}`
      if (level === 'error') console.error(line, meta)
      else if (level === 'warn') console.warn(line, meta)
      else console.log(line, meta)
      if (!heartbeatPool) return
      heartbeatPool.query(`
        UPDATE intelligence.pipeline_runs
        SET heartbeat_at = NOW(),
            checkpoints = checkpoints || $2::jsonb
        WHERE id = $1
      `, [runId, JSON.stringify({ last_message: message, last_level: level, last_meta: meta })]).catch(() => {})
    }

    const stats = await runIntelligenceServices(client, { ...options, started_at: started.rows[0].started_at, log })
    await client.query(`
      UPDATE intelligence.pipeline_runs
      SET status = 'completed', stats = $2::jsonb,
          heartbeat_at = NOW(), completed_at = NOW()
      WHERE id = $1
    `, [runId, JSON.stringify(stats)])
    return { run_id: runId, status: 'completed', stats }
  } catch (error) {
    if (runId) {
      try {
        await client.query(`
          UPDATE intelligence.pipeline_runs
          SET status = 'failed', error = $2,
              heartbeat_at = NOW(), completed_at = NOW()
          WHERE id = $1
        `, [runId, String(error.message || error).slice(0, 4000)])
      } catch (_) {}
    }
    throw error
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]) } catch (_) {}
    }
    release()
  }
}

module.exports = { ADVISORY_LOCK_ID, markStaleRuns, runDurableIntelligence }
