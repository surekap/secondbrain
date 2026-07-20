#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

try { require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') }) } catch (_) {}

const goldPath = process.env.SECOND_BRAIN_GOLD_PATH || process.argv.find(arg => arg.startsWith('--gold='))?.slice(7)
if (!goldPath) {
  console.error('SKIPPED/FAIL: set SECOND_BRAIN_GOLD_PATH or pass --gold=<private-json>. Absence of a private gold set is never a passing evaluation.')
  process.exit(2)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(2)
}

let gold
try { gold = JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8')) } catch (error) {
  console.error(`Unable to read gold set: ${error.message}`)
  process.exit(2)
}
if (!gold.version || !Array.isArray(gold.cases)) {
  console.error('Gold set requires a version and cases array')
  process.exit(2)
}

const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const results = []

function same(actual, expected) {
  if (expected === null) return actual == null
  return String(actual ?? '') === String(expected)
}

async function evaluate(testCase) {
  if (testCase.kind === 'identity') {
    const { rows } = await pool.query(`
      SELECT contact_id
      FROM relationships.contact_identities
      WHERE source = $1 AND identity_type = $2 AND identity_value = $3 AND is_active
    `, [testCase.source, testCase.identity_type, testCase.identity_value])
    return same(rows[0]?.contact_id, testCase.expected_contact_id)
  }

  if (testCase.kind === 'project_classification') {
    const { rows } = await pool.query(`
      SELECT project_id, decision
      FROM projects.communication_classifications
      WHERE source = $1 AND episode_id = $2 AND is_current
      ORDER BY updated_at DESC LIMIT 1
    `, [testCase.source, testCase.episode_id])
    const expectedDecision = testCase.expected_project_id == null ? 'no_match' : 'matched'
    return rows[0]?.decision === expectedDecision && same(rows[0]?.project_id, testCase.expected_project_id)
  }

  if (testCase.kind === 'item') {
    const { rows } = await pool.query(`
      SELECT o.*, ARRAY_REMOVE(ARRAY_AGG(DISTINCT e.source_table || ':' || e.source_id), NULL) AS evidence_refs
      FROM intelligence.opportunities o
      LEFT JOIN intelligence.opportunity_evidence e ON e.opportunity_id = o.id
      WHERE ($1::bigint IS NOT NULL AND o.id = $1)
         OR ($2::text IS NOT NULL AND o.source_ref = $2)
      GROUP BY o.id
      ORDER BY o.updated_at DESC LIMIT 1
    `, [testCase.item_id || null, testCase.source_ref || null])
    const item = rows[0]
    if (!item) return false
    const fieldMatches = Object.entries(testCase.expected || {}).every(([field, expected]) => same(item[field], expected))
    const evidenceMatches = (testCase.required_evidence || []).every(ref => (item.evidence_refs || []).includes(ref))
    return fieldMatches && evidenceMatches
  }

  if (testCase.kind === 'clarification') {
    const { rows } = await pool.query(`
      SELECT q.*, fact.fact_type, fact.fact_value, fact.state AS guidance_state
      FROM intelligence.clarification_questions q
      LEFT JOIN intelligence.guidance_facts fact ON fact.id = q.answer_guidance_fact_id
      WHERE q.ambiguity_key = $1
    `, [testCase.ambiguity_key])
    const row = rows[0]
    if (!row) return false
    return Object.entries(testCase.expected || {}).every(([field, expected]) => same(row[field], expected))
  }

  if (testCase.kind === 'attention') {
    const { rows } = await pool.query(`
      SELECT id, source_ref, item_type, primary_contact_id, primary_project_id
      FROM intelligence.daily_attention_queue
      ORDER BY attention_score DESC NULLS LAST, id
      LIMIT 10
    `)
    const refs = new Set(rows.map(row => row.source_ref))
    return (testCase.required_source_refs || []).every(ref => refs.has(ref))
      && (testCase.forbidden_source_refs || []).every(ref => !refs.has(ref))
  }

  throw new Error(`Unknown gold case kind: ${testCase.kind}`)
}

async function main() {
  for (const testCase of gold.cases) {
    try {
      const passed = await evaluate(testCase)
      results.push({ id: testCase.id, kind: testCase.kind, passed })
    } catch (error) {
      results.push({ id: testCase.id, kind: testCase.kind, passed: false, error: error.message })
    }
  }
  const byKind = {}
  for (const result of results) {
    byKind[result.kind] ||= { passed: 0, total: 0 }
    byKind[result.kind].total++
    if (result.passed) byKind[result.kind].passed++
  }
  const summary = {
    gold_version: gold.version,
    evaluated_at: new Date().toISOString(),
    passed: results.filter(result => result.passed).length,
    total: results.length,
    accuracy: results.length ? results.filter(result => result.passed).length / results.length : 0,
    by_kind: byKind,
    failures: results.filter(result => !result.passed),
  }
  console.log(JSON.stringify(summary, null, 2))
  const minimum = Number(gold.minimum_accuracy ?? 0.9)
  if (!results.length || summary.accuracy < minimum || summary.failures.some(result => result.error)) process.exitCode = 2
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 2
}).finally(() => pool.end().catch(() => {}))
