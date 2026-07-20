#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const db = require('@secondbrain/db')
const { runCommunicationRecovery } = require('./services/recovery')

function option(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv.find(arg => arg.startsWith(prefix))
  return value ? value.slice(prefix.length) : fallback
}

async function main() {
  const ready = await db.query(`
    SELECT to_regclass('relationships.comms_source_source_id_unique_idx') IS NOT NULL AS unique_ready,
           to_regclass('relationships.communication_recovery_runs') IS NOT NULL AS recovery_ready
  `)
  if (!ready.rows[0]?.unique_ready || !ready.rows[0]?.recovery_ready) {
    throw new Error('relationship schema migration is required before recovery; run the relationships init-db command first')
  }

  const result = await runCommunicationRecovery(db, {
    pageSize: Number(option('page-size', 1000)),
    resume: option('resume', 'true') !== 'false',
    log: event => console.log(JSON.stringify(event)),
  })
  console.log(JSON.stringify(result, null, 2))
}

main()
  .then(() => db.end())
  .catch(async err => {
    console.error(`[communication-recovery] ${err.message}`)
    try { await db.end() } catch (_) {}
    process.exit(1)
  })
