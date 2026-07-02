// packages/sampler/powermetrics.js
'use strict'

const { spawn } = require('child_process')
const plist     = require('plist')

let child    = null
let buffer   = ''
let handlers = []
let running  = false

function onSample(fn) { handlers.push(fn) }

function _emit(sample) {
  for (const h of handlers) {
    try { h(sample) } catch (_) {}
  }
}

function _parseSample(doc) {
  try {
    const parsed = plist.parse(doc)
    const proc   = parsed.processor || {}
    const pkg    = (proc.packages || [{}])[0]

    const cpuPowerMw = Math.round((pkg.cpu_energy || 0) * 1000)
    const gpuPowerMw = Math.round((pkg.gpu_energy || 0) * 1000)
    const anePowerMw = Math.round((pkg.ane_energy || 0) * 1000)

    const gpuActive = parsed.gpu_power?.active_residency ?? null
    const gpuIdle   = parsed.gpu_power?.idle_residency   ?? null

    return {
      cpu_power_mw:             cpuPowerMw || null,
      gpu_power_mw:             gpuPowerMw || null,
      ane_power_mw:             anePowerMw || null,
      gpu_active_residency_pct: gpuActive != null ? parseFloat((gpuActive * 100).toFixed(2)) : null,
      gpu_idle_residency_pct:   gpuIdle   != null ? parseFloat((gpuIdle   * 100).toFixed(2)) : null,
      thermal_state:            parsed.thermal_state || null,
    }
  } catch (_) {
    return null
  }
}

function start() {
  if (running) return
  if (process.platform !== 'darwin') {
    // powermetrics is macOS-only. On Linux/other hosts we keep the sampler
    // alive and let index.js write null power fields plus CPU/memory telemetry.
    running = true
    return
  }
  running = true
  child = spawn('powermetrics', [
    '--samplers', 'cpu_power,gpu_power',
    '-i', '1000',
    '-f', 'plist',
  ])

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('</plist>')) !== -1) {
      const doc = buffer.slice(0, idx + '</plist>'.length)
      buffer    = buffer.slice(idx + '</plist>'.length)
      const sample = _parseSample(doc)
      if (sample) _emit(sample)
    }
  })

  child.stderr.on('data', d => {
    const msg = d.toString().trim()
    if (msg) console.warn('[sampler:powermetrics]', msg)
  })

  child.on('error', err => {
    if (err?.code === 'ENOENT') return
    console.error('[sampler:powermetrics] spawn error:', err.message)
  })
  child.on('close', code => {
    running = false
    if (code && code !== 0) console.warn('[sampler:powermetrics] exited with code', code)
  })
}

function stop() {
  if (child) { child.kill(); child = null }
  running = false
}

module.exports = { start, stop, onSample }
