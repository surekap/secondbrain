'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')
const analyzerSource = fs.readFileSync(path.join(__dirname, '../services/analyzer.js'), 'utf8')
const communicationSource = fs.readFileSync(path.join(__dirname, '../services/communication.js'), 'utf8')
const extractorSource = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
const opportunitySource = fs.readFileSync(path.join(__dirname, '../services/opportunities.js'), 'utf8')
const schemaSource = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8')

test('all relationship writers use the global canonical source event conflict key', () => {
  assert.doesNotMatch(indexSource, /ON CONFLICT \(source, source_id, contact_id\)/)
  assert.match(indexSource, /communication\.upsertCanonicalCommunication/)
  assert.match(indexSource, /communication\.upsertEmailCommunications/)
  assert.match(schemaSource, /comms_source_source_id_unique_idx/)
})

test('normal runs refresh late media semantics and close telemetry exactly once', () => {
  assert.match(indexSource, /getStaleMediaCommunications\(500\)/)
  assert.match(indexSource, /telemetryStatus = 'completed'/)
  assert.match(indexSource, /const telemetryRunId = _runId\s+_runId = null/)
  assert.match(indexSource, /await telemetry\.endRun\(telemetryRunId/)
})

test('group recovery scans the source once instead of once per group', () => {
  assert.match(indexSource, /getUnstoredGroupMessagesBatch\(5000\)/)
  assert.match(extractorSource, /async function getUnstoredGroupMessagesBatch/)
  const groupLoop = indexSource.slice(indexSource.indexOf('for (const group of groups)'))
  assert.doesNotMatch(groupLoop, /getUnstoredGroupMessages\(/)
})

test('per-contact LLM failures remain retryable and full one-shot recovery is explicit', () => {
  assert.match(analyzerSource, /analysis_error: err\.message/)
  assert.match(indexSource, /if \(profile\.analysis_error\)/)
  assert.match(indexSource, /if \(analysis\.analysis_error\)/)
  assert.match(indexSource, /process\.argv\.includes\('--full'\)/)
  assert.match(indexSource, /process\.argv\.includes\('--once'\)/)
  assert.doesNotMatch(indexSource, /new Date\(c\.last_msg_at\) <= lastRunAt/)
})

test('process replacement recovers the prior lease and shutdown preserves an active run', () => {
  assert.match(indexSource, /async function recoverInterruptedRuns/)
  assert.match(indexSource, /WHERE status = 'running'/)
  assert.match(indexSource, /await recoverInterruptedRuns\(\)[\s\S]*await startAnalysis\(\)/)
  assert.match(indexSource, /if \(_analysisPromise\) await _analysisPromise\.catch/)
  assert.match(indexSource, /process\.once\('SIGTERM', shutdown\)/)
})

test('meeting names remain unresolved evidence instead of becoming identity links', () => {
  assert.doesNotMatch(opportunitySource, /normalized_name\s*=\s*LOWER/)
  assert.doesNotMatch(opportunitySource, /display_name\s+ILIKE/)
  assert.match(opportunitySource, /\[Unresolved person:/)
})

test('new WhatsApp LIDs create provisional profiles without name-only matching', () => {
  const start = communicationSource.indexOf('async function resolveDirectContact')
  const body = communicationSource.slice(start, communicationSource.indexOf('async function upsertDirectCommunications', start))
  const lidBranch = body.slice(body.indexOf('if (!contactId && isLid)'))
  assert.match(lidBranch, /provider_identity_without_person_level_corroboration/)
  assert.doesNotMatch(lidBranch, /LOWER\(BTRIM\(display_name\)\)/)
})

test('communication dedupe preserves redirects, prior participant, and full snapshot', () => {
  assert.match(schemaSource, /communication_merge_redirects/)
  assert.match(schemaSource, /from_contact_id/)
  assert.match(schemaSource, /to_contact_id/)
  assert.match(schemaSource, /to_jsonb\(duplicate\)/)
  assert.match(schemaSource, /communication_identity_conflicts/)
  assert.match(schemaSource, /deactivated_reason', 'invalid_stable_identity'/)
  assert.match(schemaSource, /identity_type = 'wa_jid'.*identity_value !~/s)
})
