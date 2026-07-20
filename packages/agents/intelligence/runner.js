#!/usr/bin/env node
'use strict'

const db = require('@secondbrain/db')
const { runDurableIntelligence } = require('./services/pipeline-runner')

const once = process.argv.includes('--once')
const intervalMinutes = Math.max(5, Number(process.env.INTELLIGENCE_INTERVAL_MINUTES || 30))
let stopping = false
let activeRun = null
let shutdownPromise = null

async function run(trigger) {
  if (activeRun) return activeRun
  activeRun = (async () => {
    const result = await runDurableIntelligence({ trigger })
    console.log(`[intelligence] run ${result.run_id || 'n/a'} ${result.status}`)
    return result
  })()
  try {
    return await activeRun
  } finally {
    activeRun = null
  }
}

async function main() {
  await run(once ? 'manual' : 'startup')
  if (once) {
    await db.end()
    return
  }
  console.log(`[intelligence] scheduled every ${intervalMinutes} minutes`)
  const timer = setInterval(() => {
    if (!stopping) run('schedule').catch(error => console.error('[intelligence] scheduled run failed:', error.message))
  }, intervalMinutes * 60 * 1000)

  const shutdown = async () => {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      stopping = true
      clearInterval(timer)
      if (activeRun) await activeRun.catch(() => {})
      await db.end()
    })()
    return shutdownPromise
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (require.main === module) {
  main().catch(async error => {
    console.error('[intelligence] fatal:', error.message)
    try { await db.end() } catch (_) {}
    process.exitCode = 1
  })
}

module.exports = { main, run }
