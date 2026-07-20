#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const fs = require('fs')
const path = require('path')
const cron = require('node-cron')
const db = require('@secondbrain/db')
const { run: fetchFromLimitless } = require('./cron/fetchLifelogs')
const { cleanupOrphanedRuns, killDuplicateProcesses } = require('../shared/cleanup')

let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}

let fetchInProgress = false

async function ensureSchema() {
  const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
  await db.query(sql)
  console.log('[limitless] Schema ready')
}

async function fetchLifelogs(trigger = 'schedule') {
  if (fetchInProgress) {
    console.warn('[limitless] Fetch already in progress; skipping overlapping run')
    return { skipped: true }
  }

  fetchInProgress = true
  let runId = null
  try {
    if (telemetry) {
      runId = await telemetry.startRun({ agentId: 'limitless', workflowName: 'lifelog_ingestion' })
    }
    console.log(`[limitless] Fetching lifelogs (${trigger})`)
    const result = await fetchFromLimitless()
    if (telemetry && runId) {
      telemetry.progress(runId, 'recordings_imported', { completed: result?.saved || 0 })
      await telemetry.endRun(runId, { status: 'completed' })
      await telemetry.flush()
    }
    console.log(`[limitless] Fetch complete: ${result?.saved || 0} rows upserted`)
    return result
  } catch (error) {
    console.error('[limitless] Fetch failed:', error.message)
    if (telemetry && runId) {
      await telemetry.endRun(runId, { status: 'failed' }).catch(() => {})
      await telemetry.flush().catch(() => {})
    }
    throw error
  } finally {
    fetchInProgress = false
  }
}

async function shutdown(signal) {
  console.log(`[limitless] ${signal}; closing database connection`)
  await db.end().catch(() => {})
  process.exit(0)
}

async function main() {
  killDuplicateProcesses()
  await ensureSchema()
  await cleanupOrphanedRuns(db, 'limitless')
  await fetchLifelogs('startup')
  cron.schedule(process.env.FETCH_INTERVAL_CRON || '*/5 * * * *', () => {
    fetchLifelogs('schedule').catch(() => {})
  })
  console.log('[limitless] Ingestion agent running')
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', error => console.error('[limitless] Uncaught exception:', error.message))
process.on('unhandledRejection', error => console.error('[limitless] Unhandled rejection:', error?.message || error))

if (require.main === module) {
  main().catch(error => {
    console.error('[limitless] Fatal:', error.message)
    process.exit(1)
  })
}

module.exports = { ensureSchema, fetchLifelogs, main }
