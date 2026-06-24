#!/usr/bin/env node
'use strict'

const http = require('http')
const https = require('https')
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') })

const BASE_URL = (process.argv.find(a => a.startsWith('--base-url=')) || '').split('=')[1]
  || process.env.SECONDBRAIN_BASE_URL
  || 'http://100.105.11.84:4001'
const REQUIRE_DB = process.argv.includes('--require-db')
const LIMIT = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 5)

function requestJson(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(body) } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, bytes: Buffer.byteLength(body) })
      })
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message, bytes: 0 }))
  })
}

async function checkApi() {
  const paths = [
    '/api/observe/health',
    '/api/observe/agents',
    `/api/intelligence/attention?limit=${LIMIT}`,
    `/api/intelligence/opportunities?limit=${LIMIT}`,
  ]
  const results = []
  for (const p of paths) {
    const result = await requestJson(`${BASE_URL}${p}`)
    results.push({ path: p, status: result.status, ok: result.ok, bytes: result.bytes, error: result.error || null })
  }
  return results
}

async function checkDb() {
  if (!process.env.DATABASE_URL) {
    return { skipped: true, reason: 'DATABASE_URL not configured' }
  }
  const db = require('@secondbrain/db')
  try {
    const expected = [
      'relationships.contacts',
      'relationships.insights',
      'relationships.groups',
      'projects.projects',
      'projects.project_insights',
      'intelligence.opportunities',
      'intelligence.opportunity_evidence',
      'intelligence.signals',
      'intelligence.attention_queue',
    ]
    const checks = []
    for (const rel of expected) {
      const { rows } = await db.query('SELECT to_regclass($1) AS regclass', [rel])
      checks.push({ relation: rel, exists: Boolean(rows[0]?.regclass) })
    }
    const { rows: attention } = await db.query(`
      SELECT
        COUNT(*)::int AS open_attention,
        COUNT(*) FILTER (WHERE array_position(quality_flags, 'missing_next_action') IS NOT NULL)::int AS missing_next_action,
        COUNT(*) FILTER (WHERE evidence_count = 0)::int AS no_evidence
      FROM intelligence.attention_queue
    `)
    const { rows: freshness } = await db.query(`
      SELECT
        (SELECT MAX(created_at) FROM intelligence.opportunities) AS latest_opportunity,
        (SELECT MAX(created_at) FROM intelligence.opportunity_evidence) AS latest_evidence,
        (SELECT MAX(updated_at) FROM relationships.contacts) AS latest_contact_update,
        (SELECT MAX(last_activity_at) FROM projects.projects) AS latest_project_activity
    `)
    return { skipped: false, checks, attention: attention[0], freshness: freshness[0] }
  } finally {
    await db.end().catch(() => {})
  }
}

async function main() {
  if (!Number.isSafeInteger(LIMIT) || LIMIT < 1 || LIMIT > 50) throw new Error('--limit must be 1..50')
  console.log(`SecondBrain holistic intelligence smoke (${BASE_URL})`)
  const api = await checkApi()
  const db = await checkDb()
  const failedApi = api.filter(x => !x.ok)
  const missingRelations = db.skipped ? [] : db.checks.filter(x => !x.exists)
  const result = { api, db, ok: failedApi.length === 0 && missingRelations.length === 0 && !(REQUIRE_DB && db.skipped) }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 2
}

main().catch(err => {
  console.error(`Holistic smoke failed: ${err.message}`)
  process.exitCode = 2
})
