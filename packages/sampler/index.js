// packages/sampler/index.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const { exec } = require('child_process')
const db       = require('@secondbrain/db')
const pm       = require('./powermetrics')
const ps       = require('./process-stats')
const ollamaPs = require('./ollama-ps')

console.log('[sampler] starting (privileged)')

// ── Fast loop: powermetrics data every 1s ─────────────────────────────────────

let latestPmSample = {}

pm.onSample(sample => {
  Object.assign(latestPmSample, sample)
})

pm.start()

setInterval(async () => {
  const sample = { ...latestPmSample }
  latestPmSample = {}
  try {
    await db.query(`
      INSERT INTO telemetry.system_samples
        (sampled_at, cpu_power_mw, gpu_power_mw, ane_power_mw,
         gpu_active_residency_pct, gpu_idle_residency_pct, thermal_state)
      VALUES (NOW(),$1,$2,$3,$4,$5,$6)
    `, [
      sample.cpu_power_mw              ?? null,
      sample.gpu_power_mw              ?? null,
      sample.ane_power_mw              ?? null,
      sample.gpu_active_residency_pct  ?? null,
      sample.gpu_idle_residency_pct    ?? null,
      sample.thermal_state             ?? null,
    ])
  } catch (err) {
    console.warn('[sampler] system_samples write error:', err.message)
  }
}, 1000)

// ── Medium loop: process CPU stats every 5s ───────────────────────────────────

setInterval(async () => {
  try {
    const ollamaProcs = await ps.getProcessStats('ollama')
    const nodeProcs   = await ps.getProcessStats('node')
    const totalCpu    = [...ollamaProcs, ...nodeProcs].reduce((s, p) => s + p.cpu, 0)
    // Update the most recent system_sample row with cpu_util_pct
    await db.query(`
      UPDATE telemetry.system_samples SET cpu_util_pct = $1
      WHERE sample_id = (SELECT MAX(sample_id) FROM telemetry.system_samples)
    `, [parseFloat(totalCpu.toFixed(2))])
  } catch (err) {
    console.warn('[sampler] process-stats error:', err.message)
  }
}, 5000)

// ── Slow loop: ollama ps + vm_stat every 15s ──────────────────────────────────

let knownModels = new Set()

setInterval(async () => {
  try {
    const loaded      = await ollamaPs.getLoadedModels()
    const loadedNames = new Set(loaded.map(m => m.model))

    // Upsert active sessions — insert only if no active session exists for this model
    for (const m of loaded) {
      await db.query(`
        INSERT INTO telemetry.model_sessions (model_name, loaded_at, last_used_at)
        SELECT $1, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM telemetry.model_sessions WHERE model_name = $1 AND unloaded_at IS NULL)
      `, [m.model])
      await db.query(`
        UPDATE telemetry.model_sessions SET last_used_at = NOW()
        WHERE model_name = $1 AND unloaded_at IS NULL
      `, [m.model])
    }

    // Mark disappeared models as unloaded
    for (const prev of knownModels) {
      if (!loadedNames.has(prev)) {
        await db.query(`
          UPDATE telemetry.model_sessions SET unloaded_at = NOW()
          WHERE model_name = $1 AND unloaded_at IS NULL
        `, [prev])
      }
    }
    knownModels = loadedNames

    // vm_stat for memory pressure
    exec('vm_stat', (err, stdout) => {
      if (err) return
      const freeMatch   = stdout.match(/Pages free:\s+(\d+)/)
      const activeMatch = stdout.match(/Pages active:\s+(\d+)/)
      const wiredMatch  = stdout.match(/Pages wired down:\s+(\d+)/)
      if (!freeMatch) return
      const pageSize = 16384  // bytes on Apple Silicon
      const active   = parseInt(activeMatch?.[1] || '0', 10) * pageSize
      const wired    = parseInt(wiredMatch?.[1]  || '0', 10) * pageSize
      const usedMb   = Math.round((active + wired) / 1048576)
      db.query(`
        UPDATE telemetry.system_samples SET mem_used_mb = $1
        WHERE sample_id = (SELECT MAX(sample_id) FROM telemetry.system_samples)
      `, [usedMb]).catch(() => {})
    })
  } catch (err) {
    console.warn('[sampler] slow loop error:', err.message)
  }
}, 15000)

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('[sampler] shutting down')
  pm.stop()
  db.end()
  process.exit(0)
})
