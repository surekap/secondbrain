// packages/collector/index.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const db   = require('@secondbrain/db')

const SPILL_DIR        = path.join(os.homedir(), '.secondbrain', 'telemetry-spill')
const SCAN_INTERVAL_MS = 30_000
const ETA_INTERVAL_MS  = 60_000

console.log('[collector] starting, spill dir:', SPILL_DIR)

// ── Spill file replay ─────────────────────────────────────────────────────────

async function replayFile(filepath) {
  const text  = fs.readFileSync(filepath, 'utf8')
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) { fs.unlinkSync(filepath); return 0 }

  const events = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch (_) {}
  }
  if (events.length === 0) { fs.unlinkSync(filepath); return 0 }

  const { writeBatch } = require('@secondbrain/telemetry/writer')
  await writeBatch(events)
  fs.unlinkSync(filepath)
  console.log(`[collector] replayed ${events.length} events from ${path.basename(filepath)}`)
  return events.length
}

async function scanAndReplay() {
  if (!fs.existsSync(SPILL_DIR)) return
  const files = fs.readdirSync(SPILL_DIR).filter(f => f.endsWith('.ndjson'))
  if (files.length === 0) return

  console.log(`[collector] found ${files.length} spill file(s)`)
  let total = 0
  for (const file of files) {
    try {
      total += await replayFile(path.join(SPILL_DIR, file))
    } catch (err) {
      console.warn(`[collector] failed to replay ${file}:`, err.message)
    }
  }

  if (total > 0) {
    try {
      await db.query(`
        INSERT INTO telemetry.counters (agent_name, counter_name, value, last_updated_at)
        VALUES ('collector', 'replayed_events', $1, NOW())
        ON CONFLICT (agent_name, counter_name) DO UPDATE
          SET value = telemetry.counters.value + EXCLUDED.value,
              last_updated_at = NOW()
      `, [total])
    } catch (err) {
      console.warn('[collector] counter update error:', err.message)
    }
  }
}

// ── ETA and work_efficiency computation ───────────────────────────────────────

async function updateEtaAndEfficiency() {
  try {
    // Compute rolling rate and ETA for active runs with progress data
    const { rows: activeProgress } = await db.query(`
      SELECT wp.run_id, wp.stage_name, wp.units_completed, wp.units_total,
             ar.started_at
      FROM telemetry.work_progress wp
      JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
      WHERE ar.ended_at IS NULL
        AND wp.units_completed > 0
    `)

    for (const row of activeProgress) {
      const elapsedMin = (Date.now() - new Date(row.started_at)) / 60000
      if (elapsedMin < 0.1) continue
      const rate = parseFloat((row.units_completed / elapsedMin).toFixed(3))
      let eta = null
      if (row.units_total && rate > 0) {
        const remaining = row.units_total - row.units_completed
        eta = remaining > 0 ? Math.round(remaining / rate * 60) : 0
      }
      await db.query(`
        UPDATE telemetry.work_progress
        SET rate_units_per_min = $1, eta_seconds = $2
        WHERE run_id = $3 AND stage_name = $4
      `, [rate, eta, row.run_id, row.stage_name])
    }

    // Compute work_efficiency: tokens/unit, ms/unit, requests/unit, failures/unit
    const { rows: effRows } = await db.query(`
      SELECT wp.run_id, wp.stage_name, wp.units_completed,
             COALESCE(SUM(lr.prompt_tokens + lr.completion_tokens), 0) AS total_tokens,
             COALESCE(SUM(lr.duration_ms), 0) AS total_ms,
             COUNT(lr.request_id) AS req_count,
             COUNT(lr.request_id) FILTER (WHERE lr.success = false) AS fail_count
      FROM telemetry.work_progress wp
      JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
      LEFT JOIN telemetry.llm_requests lr ON lr.run_id = wp.run_id
      WHERE ar.ended_at IS NULL AND wp.units_completed > 0
      GROUP BY wp.run_id, wp.stage_name, wp.units_completed
    `)

    for (const r of effRows) {
      if (!r.units_completed) continue
      const units = parseInt(r.units_completed, 10)
      await db.query(`
        INSERT INTO telemetry.work_efficiency
          (run_id, stage_name, tokens_per_unit, ms_per_unit, requests_per_unit, failures_per_unit, computed_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (run_id, stage_name) DO UPDATE SET
          tokens_per_unit   = EXCLUDED.tokens_per_unit,
          ms_per_unit       = EXCLUDED.ms_per_unit,
          requests_per_unit = EXCLUDED.requests_per_unit,
          failures_per_unit = EXCLUDED.failures_per_unit,
          computed_at       = NOW()
      `, [
        r.run_id, r.stage_name,
        parseFloat((parseInt(r.total_tokens, 10) / units).toFixed(2)),
        parseFloat((parseInt(r.total_ms,     10) / units).toFixed(2)),
        parseFloat((parseInt(r.req_count,    10) / units).toFixed(4)),
        parseFloat((parseInt(r.fail_count,   10) / units).toFixed(4)),
      ])
    }
  } catch (err) {
    console.warn('[collector] ETA/efficiency update error:', err.message)
  }
}

// ── Data retention cleanup (daily) ────────────────────────────────────────────

async function runRetentionCleanup() {
  try {
    await db.query(`DELETE FROM telemetry.llm_request_samples WHERE stored_at < NOW() - INTERVAL '7 days'`)
    await db.query(`DELETE FROM telemetry.llm_requests WHERE started_at < NOW() - INTERVAL '30 days'`)
    await db.query(`DELETE FROM telemetry.system_samples WHERE sampled_at < NOW() - INTERVAL '7 days'`)
    await db.query(`DELETE FROM telemetry.alerts WHERE fired_at < NOW() - INTERVAL '30 days'`)
    console.log('[collector] retention cleanup complete')
  } catch (err) {
    console.warn('[collector] retention cleanup error:', err.message)
  }
}

// ── Startup and scheduling ────────────────────────────────────────────────────

// Run immediately on startup
scanAndReplay().catch(err => console.warn('[collector] initial scan error:', err.message))

// Recurring scans
setInterval(() => scanAndReplay().catch(err => console.warn('[collector] scan error:', err.message)), SCAN_INTERVAL_MS)

// ETA + efficiency updates
setInterval(() => updateEtaAndEfficiency().catch(() => {}), ETA_INTERVAL_MS)

// Daily retention cleanup (offset 5 min to avoid startup collision)
setTimeout(() => {
  runRetentionCleanup()
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000)
}, 5 * 60 * 1000)

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('[collector] shutting down')
  db.end()
  process.exit(0)
})
