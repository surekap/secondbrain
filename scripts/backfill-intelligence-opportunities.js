#!/usr/bin/env node
'use strict'

const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') })

const WRITE = process.argv.includes('--write')
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='))
function parseLimit(arg) {
  if (!arg) return 500
  const raw = arg.split('=')[1]
  if (!/^\d+$/.test(String(raw))) throw new Error('--limit must be a positive integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('--limit must be a positive integer')
  return Math.min(value, 5000)
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
const intelligence = require('../packages/agents/intelligence')

async function tableExists(name) {
  const { rows } = await db.query('SELECT to_regclass($1) AS regclass', [name])
  return Boolean(rows[0]?.regclass)
}

async function backfillRelationshipInsights() {
  const types = ['opportunity','cross_source_opportunity','project_match','action_needed','awaiting_reply','cold_email','unread_group']
  const { rows } = await db.query(`
    SELECT id, contact_id, insight_type, title, description, priority, source_ref, source_refs, contact_ids, created_at
    FROM relationships.insights
    WHERE insight_type = ANY($1::text[])
      AND NOT is_dismissed
    ORDER BY created_at DESC
    LIMIT $2
  `, [types, LIMIT])

  let written = 0
  for (const row of rows) {
    if (WRITE) {
      const id = await intelligence.upsertFromRelationshipInsight(row.id, row.contact_id, row)
      if (id) written++
    }
  }
  return { scanned: rows.length, would_upsert: rows.length, written }
}

async function backfillProjectInsights() {
  const types = ['opportunity','risk','blocker','next_action']
  const { rows } = await db.query(`
    SELECT id, project_id, insight_type, content, priority, created_at
    FROM projects.project_insights
    WHERE insight_type = ANY($1::text[])
      AND NOT is_resolved
    ORDER BY created_at DESC
    LIMIT $2
  `, [types, LIMIT])

  let written = 0
  for (const row of rows) {
    if (WRITE) {
      const id = await intelligence.upsertFromProjectInsight(row.id, row.project_id, row)
      if (id) written++
    }
  }
  return { scanned: rows.length, would_upsert: rows.length, written }
}

async function backfillGroupOpportunities() {
  const { rows } = await db.query(`
    SELECT id, wa_chat_id, name, group_type, my_role, opportunities, last_activity_at, analyzed_at
    FROM relationships.groups
    WHERE jsonb_typeof(opportunities) = 'array'
      AND jsonb_array_length(opportunities) > 0
    ORDER BY COALESCE(analyzed_at, last_activity_at) DESC NULLS LAST
    LIMIT $1
  `, [LIMIT])

  let scannedItems = 0
  let written = 0
  for (const group of rows) {
    const opportunities = Array.isArray(group.opportunities) ? group.opportunities : []
    for (const [idx, opp] of opportunities.entries()) {
      scannedItems++
      if (WRITE) {
        const id = await intelligence.upsertFromGroupOpportunity(group.id, group, opp, idx)
        if (id) written++
      }
    }
  }
  return { scanned_groups: rows.length, scanned: scannedItems, would_upsert: scannedItems, written }
}

async function main() {
  console.log(`SecondBrain intelligence opportunity backfill (${WRITE ? 'WRITE' : 'dry-run'})`)
  console.log(`Limit per source: ${LIMIT}`)

  if (!(await tableExists('relationships.insights'))) throw new Error('relationships.insights missing')
  if (!(await tableExists('projects.project_insights'))) throw new Error('projects.project_insights missing')
  if (WRITE) await intelligence.ensureSchema()

  const relationships = await backfillRelationshipInsights()
  const projects = await backfillProjectInsights()
  const groups = await backfillGroupOpportunities()

  console.log(JSON.stringify({ mode: WRITE ? 'write' : 'dry-run', relationships, projects, groups }, null, 2))
  if (!WRITE) console.log('Dry run only. Re-run with --write to insert/update intelligence.opportunities.')
}

main().catch(err => {
  console.error(`Backfill failed: ${err.message}`)
  process.exitCode = 2
}).finally(async () => {
  await db.end().catch(() => {})
})
