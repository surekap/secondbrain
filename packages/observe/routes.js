// packages/observe/routes.js
'use strict'

const express = require('express')

function parseNonNegativeInt(value, fallback, max = 1000) {
  if (value == null || value === '') return fallback
  if (!/^\d+$/.test(String(value))) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return Math.min(parsed, max)
}

function parsePositiveInt(value, fallback, max = 1000) {
  const parsed = parseNonNegativeInt(value, fallback, max)
  if (parsed === null || parsed < 1) return null
  return parsed
}

function sampleAgeSeconds(sample) {
  if (!sample?.sampled_at) return null
  const ms = Date.now() - new Date(sample.sampled_at).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 1000))
}

function decorateSystemHealth(sample) {
  const ageSeconds = sampleAgeSeconds(sample)
  const staleAfterSeconds = 5 * 60
  const samplerStatus = !sample
    ? 'missing'
    : ageSeconds > staleAfterSeconds
      ? 'stale'
      : 'ok'
  return {
    sampler_status: samplerStatus,
    sampler_age_seconds: ageSeconds,
    sampler_stale_after_seconds: staleAfterSeconds,
    sampler_sampled_at: sample?.sampled_at || null,
  }
}

function decorateRun(row) {
  const staleAfterSeconds = 6 * 60 * 60
  const ageSeconds = row?.started_at
    ? Math.max(0, Math.floor((Date.now() - new Date(row.started_at).getTime()) / 1000))
    : null
  const staleRunning = !row?.ended_at && ageSeconds != null && ageSeconds > staleAfterSeconds
  return {
    ...row,
    display_status: staleRunning ? 'stale_running' : (row?.ended_at ? (row.status || 'completed') : 'running'),
    stale_running: staleRunning,
    age_seconds: ageSeconds,
  }
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (['true', '1', 'yes'].includes(String(value).toLowerCase())) return true
  if (['false', '0', 'no'].includes(String(value).toLowerCase())) return false
  return null
}

function createObserveRouter(db) {
  const router = express.Router()

  router.use((req, res, next) => {
    if (!db) return res.status(503).json({ error: 'No database' })
    next()
  })

  // ── System: latest sample + loaded models ───────────────────────────────────
  router.get('/system', async (req, res) => {
    try {
      const { rows: [latest] } = await db.query(`
        SELECT * FROM telemetry.system_samples ORDER BY sampled_at DESC LIMIT 1
      `)
      const { rows: models } = await db.query(`
        SELECT * FROM telemetry.model_sessions WHERE unloaded_at IS NULL ORDER BY loaded_at DESC
      `)
      const { rows: counters } = await db.query(`
        SELECT agent_name, counter_name, value FROM telemetry.counters ORDER BY last_updated_at DESC LIMIT 100
      `)
      res.json({ sample: latest || null, models, counters, health: decorateSystemHealth(latest || null) })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Agents: active runs + per-agent progress ────────────────────────────────
  router.get('/agents', async (req, res) => {
    try {
      const { rows: runs } = await db.query(`
        SELECT r.*,
          (SELECT COUNT(*) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id) AS request_count,
          (SELECT COUNT(*) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id AND lr.success = false) AS error_count
        FROM telemetry.agent_runs r
        WHERE r.ended_at IS NULL OR r.started_at > NOW() - INTERVAL '24 hours'
        ORDER BY
          CASE WHEN r.ended_at IS NULL THEN 0 ELSE 1 END,
          CASE WHEN r.ended_at IS NULL AND r.started_at < NOW() - INTERVAL '6 hours' THEN 0 ELSE 1 END,
          r.started_at DESC
        LIMIT 75
      `)
      const { rows: progress } = await db.query(`
        SELECT wp.*, ar.agent_name FROM telemetry.work_progress wp
        JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
        WHERE ar.ended_at IS NULL OR ar.started_at > NOW() - INTERVAL '24 hours'
        ORDER BY wp.last_updated_at DESC
      `)
      res.json({ runs: runs.map(decorateRun), progress })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── LLM requests: paginated ─────────────────────────────────────────────────
  router.get('/requests', async (req, res) => {
    const { agent, model, task_type, success } = req.query
    const limit = parsePositiveInt(req.query.limit, 100, 500)
    const offset = parseNonNegativeInt(req.query.offset, 0, 100000)
    if (limit === null || offset === null) return res.status(400).json({ error: 'Invalid limit/offset' })

    const conditions = []
    const params = []
    if (agent)     { params.push(agent);     conditions.push(`agent_name = $${params.length}`) }
    if (model)     { params.push(model);     conditions.push(`model = $${params.length}`) }
    if (task_type) { params.push(task_type); conditions.push(`task_type = $${params.length}`) }
    if (success != null && success !== '') {
      if (!['true', 'false'].includes(String(success))) return res.status(400).json({ error: 'Invalid success filter' })
      params.push(success === 'true'); conditions.push(`success = $${params.length}`)
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    params.push(limit, offset)
    try {
      const { rows } = await db.query(`
        SELECT * FROM telemetry.llm_requests ${where}
        ORDER BY started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}
      `, params)
      res.json({ requests: rows })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Models: session stats ───────────────────────────────────────────────────
  router.get('/models', async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT
          model,
          COUNT(*) AS total_requests,
          SUM(prompt_tokens) AS total_prompt_tokens,
          SUM(completion_tokens) AS total_completion_tokens,
          AVG(duration_ms)::int AS avg_latency_ms,
          COUNT(*) FILTER (WHERE success = false) AS error_count,
          MAX(started_at) AS last_used_at
        FROM telemetry.llm_requests
        WHERE started_at > NOW() - INTERVAL '7 days'
        GROUP BY model
        ORDER BY total_requests DESC
      `)
      const { rows: sessions } = await db.query(`
        SELECT * FROM telemetry.model_sessions ORDER BY loaded_at DESC LIMIT 50
      `)
      res.json({ stats: rows, sessions })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Quality: scores + model comparison ──────────────────────────────────────
  router.get('/quality', async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT lr.model, lr.task_type, lr.agent_name,
          COUNT(*) AS total,
          AVG(qs.score_numeric) FILTER (WHERE qs.evaluation_type = 'structural') AS avg_structural,
          AVG(qs.score_numeric) FILTER (WHERE qs.evaluation_type = 'human') AS avg_human,
          COUNT(*) FILTER (WHERE lr.success = false) AS errors,
          AVG(lr.retry_count) AS avg_retries
        FROM telemetry.llm_requests lr
        LEFT JOIN telemetry.quality_scores qs ON qs.request_id = lr.request_id
        WHERE lr.started_at > NOW() - INTERVAL '7 days'
        GROUP BY lr.model, lr.task_type, lr.agent_name
        ORDER BY total DESC
      `)
      res.json({ comparison: rows })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Human quality rating ────────────────────────────────────────────────────
  router.post('/quality/rate', async (req, res) => {
    const { requestId, scoreLabel, notes } = req.body
    const scoreMap = { good: 1.0, acceptable: 0.6, poor: 0.2 }
    const scoreNumeric = scoreMap[scoreLabel] ?? null
    if (!requestId || scoreNumeric == null) return res.status(400).json({ error: 'Invalid rating' })
    try {
      await db.query(`
        INSERT INTO telemetry.quality_scores (request_id, evaluation_type, score_numeric, score_label, evaluator, notes)
        VALUES ($1, 'human', $2, $3, 'operator', $4)
      `, [requestId, scoreNumeric, scoreLabel, notes || null])
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })



  // ── Health: explicit observability freshness/status ─────────────────────────
  router.get('/health', async (req, res) => {
    try {
      const { rows: [latest] } = await db.query(`
        SELECT * FROM telemetry.system_samples ORDER BY sampled_at DESC LIMIT 1
      `)
      const { rows: staleRuns } = await db.query(`
        SELECT run_id, agent_name, status, started_at, ended_at
        FROM telemetry.agent_runs
        WHERE ended_at IS NULL
          AND started_at < NOW() - INTERVAL '6 hours'
        ORDER BY started_at ASC
        LIMIT 25
      `)
      res.json({
        ...decorateSystemHealth(latest || null),
        stale_running_runs: staleRuns.map(decorateRun),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })



  // ── Agent-run cleanup: close old idle telemetry rows ────────────────────────
  router.post('/agent-runs/cleanup-stale', async (req, res) => {
    const olderThanHours = parsePositiveInt(req.body?.older_than_hours ?? req.query.older_than_hours, 6, 24 * 30)
    const inactiveMinutes = parsePositiveInt(req.body?.inactive_minutes ?? req.query.inactive_minutes, 10, 24 * 60)
    const limit = parsePositiveInt(req.body?.limit ?? req.query.limit, 100, 1000)
    const dryRun = parseBoolean(req.body?.dry_run ?? req.query.dry_run, true)
    if (olderThanHours === null) return res.status(400).json({ error: 'Invalid older_than_hours' })
    if (inactiveMinutes === null) return res.status(400).json({ error: 'Invalid inactive_minutes' })
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' })
    if (dryRun === null) return res.status(400).json({ error: 'Invalid dry_run' })

    try {
      const params = [olderThanHours, inactiveMinutes, limit]
      const { rows: candidates } = await db.query(`
        SELECT r.run_id, r.agent_name, r.workflow_name, r.status, r.started_at, r.ended_at, r.host_name, r.pid,
               GREATEST(
                 COALESCE((SELECT MAX(lr.started_at) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id), r.started_at),
                 COALESCE((SELECT MAX(wp.last_updated_at) FROM telemetry.work_progress wp WHERE wp.run_id = r.run_id), r.started_at)
               ) AS last_activity_at
        FROM telemetry.agent_runs r
        WHERE r.ended_at IS NULL
          AND r.started_at < NOW() - ($1::int * INTERVAL '1 hour')
          AND NOT EXISTS (
            SELECT 1 FROM telemetry.llm_requests lr
            WHERE lr.run_id = r.run_id
              AND lr.started_at > NOW() - ($2::int * INTERVAL '1 minute')
          )
          AND NOT EXISTS (
            SELECT 1 FROM telemetry.work_progress wp
            WHERE wp.run_id = r.run_id
              AND wp.last_updated_at > NOW() - ($2::int * INTERVAL '1 minute')
          )
        ORDER BY r.started_at ASC
        LIMIT $3
      `, params)

      if (dryRun || candidates.length === 0) {
        return res.json({
          dry_run: dryRun,
          older_than_hours: olderThanHours,
          inactive_minutes: inactiveMinutes,
          candidate_count: candidates.length,
          updated_count: 0,
          candidates: candidates.map(decorateRun),
          updated: [],
        })
      }

      const runIds = candidates.map(r => r.run_id)
      const { rows: updated } = await db.query(`
        UPDATE telemetry.agent_runs
        SET ended_at = NOW(), status = 'failed'
        WHERE run_id = ANY($1::text[])
          AND ended_at IS NULL
        RETURNING run_id, agent_name, workflow_name, status, started_at, ended_at, host_name, pid
      `, [runIds])

      res.json({
        dry_run: false,
        older_than_hours: olderThanHours,
        inactive_minutes: inactiveMinutes,
        candidate_count: candidates.length,
        updated_count: updated.length,
        candidates: candidates.map(decorateRun),
        updated: updated.map(decorateRun),
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Alerts ──────────────────────────────────────────────────────────────────
  router.get('/alerts', async (req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT * FROM telemetry.alerts ORDER BY fired_at DESC LIMIT 100
      `)
      res.json({ alerts: rows })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── SSE: live stream (system + agents every 2s) ─────────────────────────────
  router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const interval = setInterval(async () => {
      try {
        const { rows: [sys] } = await db.query(`SELECT * FROM telemetry.system_samples ORDER BY sampled_at DESC LIMIT 1`)
        const { rows: runs }  = await db.query(`SELECT run_id, agent_name, status, started_at, ended_at FROM telemetry.agent_runs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 20`)
        res.write(`data: ${JSON.stringify({ system: sys || null, health: decorateSystemHealth(sys || null), runs: runs.map(decorateRun) })}\n\n`)
      } catch (_) {}
    }, 2000)

    req.on('close', () => clearInterval(interval))
  })

  return router
}

module.exports = { createObserveRouter }
