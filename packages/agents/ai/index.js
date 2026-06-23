#!/usr/bin/env node
'use strict'

/**
 * AI Conversations Agent — runs both OpenAI and Gemini importers in parallel.
 * Re-run at any time; imports are fully idempotent (ON CONFLICT DO NOTHING).
 *
 * To watch for new export files and re-import automatically, set
 * AI_WATCH_INTERVAL_MINUTES in .env.local (default: disabled, one-shot run).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const cron   = require('node-cron')
const fs     = require('fs')
const path   = require('path')
const openai = require('./services/openai')
const gemini = require('./services/gemini')
const db     = require('@secondbrain/db')

console.log('🧠 AI Conversations Agent')
console.log('   Imports ChatGPT + Gemini history into the ai schema\n')

async function runImports() {
  console.log('🔄 Running imports...')

  const [oaiResult, gemResult] = await Promise.allSettled([
    openai.importConversations(),
    gemini.importConversations(),
  ])

  if (oaiResult.status === 'fulfilled') {
    const { convsImported, msgsImported } = oaiResult.value
    console.log(`   ✅ OpenAI  — ${convsImported} conversations, ${msgsImported} messages`)
  } else {
    console.error(`   ❌ OpenAI  — ${oaiResult.reason?.message}`)
  }

  if (gemResult.status === 'fulfilled') {
    const { convsImported, msgsImported } = gemResult.value
    console.log(`   ✅ Gemini  — ${convsImported} conversations, ${msgsImported} messages`)
  } else {
    console.error(`   ❌ Gemini  — ${gemResult.reason?.message}`)
  }

  console.log('✅ Import run complete\n')
}

async function ensureSchema() {
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
    await db.query(sql)
    console.log('✅ Schema ready')
  } catch (err) {
    console.error('❌ Schema setup error:', err.message)
  }
}

async function main() {
  await ensureSchema()
  await runImports()

  const intervalMinutes = parseInt(process.env.AI_WATCH_INTERVAL_MINUTES || '0', 10)
  if (intervalMinutes > 0) {
    console.log(`⏰ Watching for new exports every ${intervalMinutes} minute(s)`)
    cron.schedule(`*/${intervalMinutes} * * * *`, () => {
      runImports().catch(err => console.error('❌ Scheduled import error:', err.message))
    })
  } else {
    // One-shot: close DB and exit
    await db.end().catch(() => {})
  }
}

main().catch(async err => {
  console.error('❌ Fatal error:', err.message)
  await db.end().catch(() => {})
  process.exit(1)
})

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...')
  await db.end().catch(() => {})
  process.exit(0)
})
