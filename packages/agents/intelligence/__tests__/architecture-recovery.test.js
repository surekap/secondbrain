'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8')
const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const pipelineRunner = fs.readFileSync(path.join(__dirname, '..', 'services', 'pipeline-runner.js'), 'utf8')

test('intelligence schema exposes typed items, evidence claims, guidance, clarifications, and durable runs', () => {
  assert.match(schema, /item_type IN \('opportunity','issue','insight','action','risk','decision'\)/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.claims/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.claim_evidence/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.guidance_facts/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.clarification_questions/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.clarification_observations/)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.pipeline_runs/)
  assert.match(schema, /CREATE OR REPLACE VIEW intelligence\.daily_attention_queue/)
})

test('canonical communications are the only signal and claim inputs', () => {
  const signalStep = index.slice(index.indexOf('// Step 3:'), index.indexOf('// Step 3b:'))
  assert.match(signalStep, /canonicalCommunicationsResult/)
  assert.match(signalStep, /relationships\.communications/)
  assert.match(signalStep, /extractSignals\(emailsResult\.rows, 'email'\)/)
  assert.doesNotMatch(signalStep, /canonical_table: 'relationships\.groups'/)
  assert.match(signalStep, /groupMessagesResult = \{ rows: whatsappResult\.rows/)
  assert.doesNotMatch(signalStep.slice(signalStep.indexOf('const signalInputs')), /resolveContactFromEmail/)
})

test('claims and evidence commit atomically and unsupported legacy items expire', () => {
  const claimWriter = index.slice(index.indexOf('async function upsertClaim'), index.indexOf('async function reconcileEvidenceLifecycle'))
  assert.match(claimWriter, /BEGIN/)
  assert.match(claimWriter, /claim_evidence/)
  assert.match(claimWriter, /COMMIT/)
  assert.match(index, /async function reconcileEvidenceLifecycle/)
  assert.match(index, /missing_inspectable_evidence/)
  assert.match(schema, /o\.lifecycle_state = 'active'/)
})

test('detector reruns honor item-scoped wrong-person and wrong-project corrections', () => {
  const upsert = index.slice(index.indexOf('async function upsertOpportunity'), index.indexOf('async function wasOpportunityLinkRejected'))
  assert.match(upsert, /feedback_event\.action = 'wrong_person'/)
  assert.match(upsert, /feedback_event\.action = 'wrong_project'/)
  assert.match(index, /wasOpportunityLinkRejected\(db, opportunityId, 'contact'/)
  assert.match(index, /wasOpportunityLinkRejected\(db, opportunityId, 'project'/)
})

test('intelligence pipeline ensures schema before querying product data', () => {
  const start = index.indexOf('async function runIntelligenceServices')
  const body = index.slice(start, start + 300)
  assert.match(body, /await ensureSchema\(pool\)/)
})

test('durable pipeline heartbeats never overlap work on the advisory-lock connection', () => {
  assert.match(pipelineRunner, /const heartbeatPool = pool !== client/)
  const logBody = pipelineRunner.slice(pipelineRunner.indexOf('const log ='), pipelineRunner.indexOf('const stats ='))
  assert.match(logBody, /heartbeatPool\.query/)
  assert.doesNotMatch(logBody, /client\.query/)
})

test('contact tiering persists recommendations in one bulk update', () => {
  const start = index.indexOf('async function tierContacts')
  const body = index.slice(start, index.indexOf('async function promoteSignalClusters', start))
  assert.match(body, /FROM UNNEST\(/)
  assert.doesNotMatch(body, /for \(let i = 0; i < rows\.length/)
})

test('project intelligence uses stable insight ids and resolves unsupported items', () => {
  assert.match(index, /projects\.project_insights:\$\{projectInsightId\}/)
  assert.match(index, /async function reconcileProjectItems/)
  assert.match(index, /lifecycle_state = 'expired'/)
})

test('unsupported legacy relationship insights retire instead of retrying forever', () => {
  const writerStart = index.indexOf('async function upsertFromRelationshipInsight')
  const writer = index.slice(writerStart, index.indexOf('async function upsertFromProjectInsight', writerStart))
  assert.match(writer, /SET is_dismissed = TRUE/)
  assert.match(index, /COALESCE\(is_dismissed, FALSE\) = FALSE/)
})

test('automatic opportunity status transitions keep lifecycle state synchronized', () => {
  const dismissUpdates = [...index.matchAll(/SET status = 'dismissed',([^\n]*)/g)]
  assert.ok(dismissUpdates.length > 0)
  assert.ok(dismissUpdates.every(match => match[1].includes("lifecycle_state = 'dismissed'")))
  const expireUpdates = [...index.matchAll(/SET status = 'expired',([^\n]*)/g)]
  assert.ok(expireUpdates.length > 0)
  assert.ok(expireUpdates.every(match => match[1].includes("lifecycle_state = 'expired'")))
})

test('terminal items reopen only through explicit newer contradictory evidence', () => {
  const start = index.indexOf('async function reopenOpportunityFromContradictoryEvidence')
  const body = index.slice(start, index.indexOf('async function upsertSignal', start))
  assert.match(body, /confidence >= 0\.8/)
  assert.match(body, /evidence\.occurred_at/)
  assert.match(body, /previously unseen contradictory evidence/)
  assert.match(body, /explicit_reopen_service/)
  assert.match(body, /SET status = 'open', lifecycle_state = 'active'/)
})
