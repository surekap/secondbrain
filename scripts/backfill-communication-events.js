#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') })

const db = require('../packages/db')
const { backfillCommunicationEvents } = require('../packages/agents/intelligence/services/communication-event-extractor')

function parseDays(argv) {
  const value = argv.find((arg, idx) => arg === '--days' ? argv[idx + 1] : null)
  if (value) return Number(value)
  const inline = argv.find(arg => arg.startsWith('--days='))
  if (inline) return Number(inline.split('=')[1])
  return 30
}

async function main() {
  const days = parseDays(process.argv.slice(2))
  const result = await backfillCommunicationEvents(db, {
    days,
    log: (...args) => console.log('[backfill-communication-events]', ...args),
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch(err => {
  console.error(err.stack || err.message)
  process.exitCode = 1
}).finally(async () => {
  await db.end().catch(() => {})
})
