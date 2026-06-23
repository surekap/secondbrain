// packages/observe/alerts.js
'use strict'

let db            = null
let timer         = null
let baselineTimer = null
// Baseline: rolling averages used for dynamic thresholds
const baseline = { gpu_power_mw: null, gpu_residency: null }

const RULES = [
  {
    name: 'gpu_residency_high',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT AVG(gpu_active_residency_pct) AS avg
        FROM telemetry.system_samples
        WHERE sampled_at > NOW() - INTERVAL '3 minutes'
      `)
      const avg = parseFloat(rows[0]?.avg)
      if (avg > 90) return `GPU active residency ${avg.toFixed(1)}% sustained >3 min`
      return null
    },
  },
  {
    name: 'gpu_power_high',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT AVG(gpu_power_mw) AS avg FROM telemetry.system_samples
        WHERE sampled_at > NOW() - INTERVAL '5 minutes'
      `)
      const avg = parseFloat(rows[0]?.avg)
      const threshold = baseline.gpu_power_mw ? baseline.gpu_power_mw * 1.5 : 30000
      if (avg > threshold) return `GPU power ${(avg/1000).toFixed(1)}W sustained >5 min (threshold ${(threshold/1000).toFixed(1)}W)`
      return null
    },
  },
  {
    name: 'zero_progress_loop',
    severity: 'critical',
    async check(db) {
      const { rows } = await db.query(`
        SELECT lr.agent_name, COUNT(*) AS req_count
        FROM telemetry.llm_requests lr
        JOIN telemetry.agent_runs ar ON ar.run_id = lr.run_id AND ar.ended_at IS NULL
        WHERE lr.started_at > NOW() - INTERVAL '10 minutes'
        GROUP BY lr.agent_name
        HAVING COUNT(*) > 5
      `)
      for (const row of rows) {
        const { rows: progress } = await db.query(`
          SELECT SUM(units_completed) AS total
          FROM telemetry.work_progress wp
          JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id AND ar.agent_name = $1
          WHERE wp.last_updated_at > NOW() - INTERVAL '10 minutes'
        `, [row.agent_name])
        const units = parseInt(progress[0]?.total || '0', 10)
        if (units === 0) return `Agent ${row.agent_name} made ${row.req_count} LLM requests with zero work-unit progress in 10 min`
      }
      return null
    },
  },
  {
    name: 'retry_storm',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT agent_name, SUM(retry_count) AS retries
        FROM telemetry.llm_requests
        WHERE started_at > NOW() - INTERVAL '5 minutes'
        GROUP BY agent_name
        HAVING SUM(retry_count) > 10
      `)
      if (rows.length > 0) return `Retry storm: ${rows.map(r => `${r.agent_name}(${r.retries})`).join(', ')}`
      return null
    },
  },
  {
    name: 'model_loaded_unused',
    severity: 'info',
    async check(db) {
      const { rows } = await db.query(`
        SELECT model_name FROM telemetry.model_sessions
        WHERE unloaded_at IS NULL
          AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '15 minutes')
          AND loaded_at < NOW() - INTERVAL '15 minutes'
      `)
      if (rows.length > 0) return `Model(s) loaded but idle >15 min: ${rows.map(r => r.model_name).join(', ')}`
      return null
    },
  },
  {
    name: 'telemetry_data_loss',
    severity: 'critical',
    async check(db) {
      const { rows } = await db.query(`
        SELECT SUM(value) AS dropped FROM telemetry.counters WHERE counter_name = 'dropped'
      `)
      const dropped = parseInt(rows[0]?.dropped || '0', 10)
      if (dropped > 0) return `Telemetry dropped ${dropped} events — check DB connectivity`
      return null
    },
  },
  {
    name: 'temperature_critical',
    severity: 'critical',
    async check(db) {
      const { rows } = await db.query(`
        SELECT MAX(cpu_temp_c) AS cpu, MAX(gpu_temp_c) AS gpu
        FROM telemetry.system_samples WHERE sampled_at > NOW() - INTERVAL '1 minute'
      `)
      const cpu = parseFloat(rows[0]?.cpu)
      const gpu = parseFloat(rows[0]?.gpu)
      if (cpu > 90) return `CPU temperature critical: ${cpu}°C`
      if (gpu > 90) return `GPU temperature critical: ${gpu}°C`
      return null
    },
  },
  {
    name: 'sampler_not_running',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT COUNT(*) AS cnt FROM telemetry.system_samples
        WHERE sampled_at > NOW() - INTERVAL '2 minutes'
      `)
      if (parseInt(rows[0]?.cnt || '0', 10) === 0) {
        return 'No system samples in last 2 minutes — is the sampler running?'
      }
      return null
    },
  },
]

async function refreshBaseline() {
  try {
    const { rows } = await db.query(`
      SELECT AVG(gpu_power_mw) AS gpu_power, AVG(gpu_active_residency_pct) AS gpu_res
      FROM telemetry.system_samples
      WHERE sampled_at > NOW() - INTERVAL '24 hours'
        AND sampled_at < NOW() - INTERVAL '5 minutes'
        AND gpu_power_mw > 0
    `)
    if (rows[0]?.gpu_power) baseline.gpu_power_mw = parseFloat(rows[0].gpu_power)
    if (rows[0]?.gpu_res)   baseline.gpu_residency = parseFloat(rows[0].gpu_res)
  } catch (_) {}
}

async function evaluateRules() {
  for (const rule of RULES) {
    try {
      const message = await rule.check(db)
      if (!message) continue
      // Check if this exact alert already fired in last 30 minutes (dedup)
      const { rows } = await db.query(`
        SELECT 1 FROM telemetry.alerts
        WHERE rule_name = $1 AND fired_at > NOW() - INTERVAL '30 minutes' AND resolved_at IS NULL
        LIMIT 1
      `, [rule.name])
      if (rows.length > 0) continue
      await db.query(`
        INSERT INTO telemetry.alerts (rule_name, severity, message)
        VALUES ($1, $2, $3)
      `, [rule.name, rule.severity, message])
      console.warn(`[alerts] ${rule.severity.toUpperCase()}: ${message}`)
    } catch (err) {
      console.warn(`[alerts] rule ${rule.name} error:`, err.message)
    }
  }
}

function start(dbInstance) {
  db = dbInstance
  refreshBaseline().catch(() => {})   // call immediately at startup
  timer = setInterval(() => evaluateRules().catch(err => console.warn('[alerts]', err.message)), 30_000)
  // Refresh baseline every 5 minutes
  baselineTimer = setInterval(() => refreshBaseline().catch(() => {}), 5 * 60_000)
}

function stop() {
  if (timer)         { clearInterval(timer);         timer         = null }
  if (baselineTimer) { clearInterval(baselineTimer); baselineTimer = null }
}

module.exports = { start, stop }
