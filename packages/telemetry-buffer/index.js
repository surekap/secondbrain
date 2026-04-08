// packages/telemetry-buffer/index.js
'use strict'

const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DEFAULT_SPILL_DIR      = path.join(os.homedir(), '.secondbrain', 'telemetry-spill')
const DEFAULT_MAX_MEMORY     = 10_000
const DEFAULT_DRAIN_INTERVAL = 5_000  // ms

function createBuffer({
  maxMemory       = DEFAULT_MAX_MEMORY,
  spillDir        = DEFAULT_SPILL_DIR,
  drainIntervalMs = DEFAULT_DRAIN_INTERVAL,
  agentName       = 'unknown',
} = {}) {
  let queue   = []
  let emitted = 0
  let dropped = 0
  let written = 0
  let failed  = 0
  let timer   = null

  if (spillDir) {
    fs.mkdirSync(spillDir, { recursive: true })
  }

  function enqueue(event) {
    emitted++
    if (queue.length >= maxMemory) {
      dropped++
      return
    }
    queue.push(event)
  }

  async function drain(writerFn) {
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    try {
      await writerFn(batch)
      written += batch.length
    } catch (err) {
      failed += batch.length
      if (spillDir) {
        const filename = `${agentName}-${Date.now()}.ndjson`
        const filepath = path.join(spillDir, filename)
        const lines    = batch.map(e => JSON.stringify(e)).join('\n')
        try {
          fs.writeFileSync(filepath, lines + '\n', 'utf8')
        } catch (_) {
          // Nothing we can do — at least we counted it
        }
      }
    }
  }

  function counts() {
    return { emitted, dropped, written, failed }
  }

  function start(writerFn) {
    if (drainIntervalMs <= 0) return
    timer = setInterval(() => drain(writerFn).catch(() => {}), drainIntervalMs)
    timer.unref()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { enqueue, drain, counts, start, stop }
}

module.exports = { createBuffer, DEFAULT_SPILL_DIR }
