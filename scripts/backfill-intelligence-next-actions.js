#!/usr/bin/env node
'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') })

const WRITE = process.argv.includes('--write')
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='))

function parseLimit(arg) {
  if (!arg) return 100
  const raw = arg.split('=')[1]
  if (!/^\d+$/.test(String(raw))) throw new Error('--limit must be a positive integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('--limit must be a positive integer')
  return Math.min(value, 1000)
}

let LIMIT
try {
  LIMIT = parseLimit(LIMIT_ARG)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Create .env.local or export DATABASE_URL.')
  process.exit(1)
}

const db = require('@secondbrain/db')
const { deriveRecommendedNextAction } = require('../packages/agents/intelligence')

async function tableExists(name) {
  const { rows } = await db.query('SELECT to_regclass($1) AS regclass', [name])
  return Boolean(rows[0]?.regclass)
}

async function main() {
  console.log(`SecondBrain intelligence next-action backfill (${WRITE ? 'WRITE' : 'dry-run'})`)
  console.log(`Limit: ${LIMIT}`)

  if (!(await tableExists('intelligence.opportunities'))) throw new Error('intelligence.opportunities missing')

  const { rows } = await db.query(`
    SELECT id, opportunity_type, title, description, priority, source_system, source_ref,
           primary_contact_id, primary_project_id, surfaced_insight_id, surfaced_project_insight_id
    FROM intelligence.opportunities
    WHERE status = 'open'
      AND NULLIF(TRIM(COALESCE(recommended_next_action, '')), '') IS NULL
    ORDER BY expected_value_score DESC NULLS LAST, last_seen_at DESC NULLS LAST, created_at DESC
    LIMIT $1
  `, [LIMIT])

  const proposed = rows.map(row => ({
    id: row.id,
    title: row.title,
    opportunity_type: row.opportunity_type,
    recommended_next_action: deriveRecommendedNextAction(row),
  }))

  let written = 0
  if (WRITE) {
    for (const item of proposed) {
      const { rowCount } = await db.query(`
        UPDATE intelligence.opportunities
        SET recommended_next_action = $2,
            metadata = metadata || $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
          AND NULLIF(TRIM(COALESCE(recommended_next_action, '')), '') IS NULL
      `, [
        item.id,
        item.recommended_next_action,
        JSON.stringify({ next_action_backfill: { strategy: 'heuristic_v1', at: new Date().toISOString() } }),
      ])
      written += rowCount
    }
  }

  console.log(JSON.stringify({
    mode: WRITE ? 'write' : 'dry-run',
    scanned: rows.length,
    would_update: proposed.length,
    written,
    sample: proposed.slice(0, 10),
  }, null, 2))
  if (!WRITE) console.log('Dry run only. Re-run with --write to update intelligence.opportunities.')
}

main().catch(err => {
  console.error(`Next-action backfill failed: ${err.message}`)
  process.exitCode = 2
}).finally(async () => {
  await db.end().catch(() => {})
})
