// packages/observe/server.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const express = require('express')
const path    = require('path')
const db      = require('@secondbrain/db')
const alerts  = require('./alerts')

const PORT = process.env.OBSERVE_PORT || 4002
const app  = express()

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── System: latest sample + loaded models ─────────────────────────────────────
app.get('/api/system', async (req, res) => {
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
    res.json({ sample: latest || null, models, counters })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Agents: active runs + per-agent progress ──────────────────────────────────
app.get('/api/agents', async (req, res) => {
  try {
    const { rows: runs } = await db.query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id) AS request_count,
        (SELECT COUNT(*) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id AND lr.success = false) AS error_count
      FROM telemetry.agent_runs r
      WHERE r.ended_at IS NULL OR r.started_at > NOW() - INTERVAL '24 hours'
      ORDER BY r.started_at DESC
      LIMIT 50
    `)
    const { rows: progress } = await db.query(`
      SELECT wp.*, ar.agent_name FROM telemetry.work_progress wp
      JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
      WHERE ar.ended_at IS NULL OR ar.started_at > NOW() - INTERVAL '24 hours'
      ORDER BY wp.last_updated_at DESC
    `)
    res.json({ runs, progress })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── LLM requests: paginated ───────────────────────────────────────────────────
app.get('/api/requests', async (req, res) => {
  const { agent, model, task_type, success, limit = 100, offset = 0 } = req.query
  const conditions = []
  const params     = []
  if (agent)     { params.push(agent);     conditions.push(`agent_name = $${params.length}`) }
  if (model)     { params.push(model);     conditions.push(`model = $${params.length}`) }
  if (task_type) { params.push(task_type); conditions.push(`task_type = $${params.length}`) }
  if (success != null && success !== '') { params.push(success === 'true'); conditions.push(`success = $${params.length}`) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(parseInt(limit, 10), parseInt(offset, 10))
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

// ── Models: session stats ──────────────────────────────────────────────────────
app.get('/api/models', async (req, res) => {
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

// ── Quality: scores + model comparison ───────────────────────────────────────
app.get('/api/quality', async (req, res) => {
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

// ── Human quality rating ───────────────────────────────────────────────────────
app.post('/api/quality/rate', async (req, res) => {
  const { requestId, scoreLabel, notes } = req.body
  const scoreMap = { good: 1.0, acceptable: 0.6, poor: 0.2 }
  const scoreNumeric = scoreMap[scoreLabel] ?? null
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

// ── Alerts ─────────────────────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM telemetry.alerts ORDER BY fired_at DESC LIMIT 100
    `)
    res.json({ alerts: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── SSE: live stream (system + agents every 2s) ───────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(async () => {
    try {
      const { rows: [sys] } = await db.query(`SELECT * FROM telemetry.system_samples ORDER BY sampled_at DESC LIMIT 1`)
      const { rows: runs }  = await db.query(`SELECT run_id, agent_name, status, started_at FROM telemetry.agent_runs WHERE ended_at IS NULL LIMIT 20`)
      res.write(`data: ${JSON.stringify({ system: sys || null, runs })}\n\n`)
    } catch (_) {}
  }, 2000)

  req.on('close', () => clearInterval(interval))
})

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────────────────────
alerts.start(db)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[observe] dashboard at http://0.0.0.0:${PORT}`)
})

process.on('SIGINT', () => { alerts.stop(); db.end(); process.exit(0) })
