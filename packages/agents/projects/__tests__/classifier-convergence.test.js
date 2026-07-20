'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  classificationBatchId,
  contentHash,
  hasProjectAnchor,
  matchEnvelopeFromPayload,
  normalizeDecision,
  parseJSON,
  pendingPage,
  projectCatalogHash,
  projectAnchorTerms,
  validateBatchResponse,
  whatsappEpisodeId,
} = require('../services/classifier')

test('classification accepts a verified sparse-match envelope', () => {
  const items = [{ source_id: 'email:1', subject: 'x', snippet: 'y' }]
  const payload = { batch_id: classificationBatchId(items), matches: [] }
  assert.deepEqual(matchEnvelopeFromPayload(payload), payload)
  assert.deepEqual(parseJSON(JSON.stringify(payload)), payload)
  assert.deepEqual(validateBatchResponse(payload, items), new Map())
})

test('project classification persists conservative negative decisions', () => {
  const decision = normalizeDecision({ id: 'email:1', project_id: 9, relevance: 0.6, rationale: 'Only mentions the sector' }, new Set([9]))
  assert.equal(decision.decision, 'no_match')
  assert.equal(decision.project_id, null)
})

test('email prefilter requires stable project anchors rather than generic activity words', () => {
  const projects = [{ name: 'Hartex Grapevine ERP Implementation', keywords: ['erp', 'grapevine'] }]
  assert.deepEqual(projectAnchorTerms(projects[0]), ['grapevine', 'erp'])
  assert.equal(hasProjectAnchor({ subject: 'ERP cutover', snippet: 'Please approve testing' }, projects), true)
  assert.equal(hasProjectAnchor({ subject: 'Weekly update', snippet: 'Please review the attached report' }, projects), false)
})

test('project catalog fingerprint is stable regardless of input order', () => {
  const left = projectCatalogHash([{ id: 2, name: 'Beta' }, { id: 1, name: 'Alpha', keywords: ['x'] }])
  const right = projectCatalogHash([{ id: 1, name: 'Alpha', keywords: ['x'] }, { id: 2, name: 'Beta' }])
  assert.equal(left, right)
  assert.equal(
    projectCatalogHash([{ id: 1, name: 'Alpha', keywords: ['old'] }]),
    projectCatalogHash([{ id: 1, name: 'Alpha', keywords: ['new', 'wording'] }]),
  )
})

test('WhatsApp episodes are stable by chat, author, and UTC day', () => {
  assert.equal(
    whatsappEpisodeId('family@g.us', '2026-07-20T22:00:00-05:00', 'alice@c.us'),
    'whatsapp:family@g.us:2026-07-21:alice@c.us',
  )
})

test('classification pages advance beyond a fixed newest window on later runs', () => {
  const items = Array.from({ length: 1005 }, (_, index) => ({ source_id: `email:${index}`, subject: `Message ${index}`, snippet: 'body' }))
  for (const item of items) item.content_hash = contentHash(item)
  const first = pendingPage(items, new Set(), 1000)
  const decided = new Set(first.map(item => `${item.source_id}:${item.content_hash}`))
  const second = pendingPage(items, decided, 1000)
  assert.equal(first.length, 1000)
  assert.equal(second.length, 5)
  assert.equal(second[0].source_id, 'email:1000')
})

test('normal email and lifelog classification honors the completed-run watermark', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/classifier.js'), 'utf8')
  assert.match(source, /async function classifyEmails\(projects, since = null\)/)
  assert.match(source, /async function classifyLifelogs\(projects, since = null\)/)
  assert.equal((source.match(/\(\$3::timestamptz IS NULL OR rc\.occurred_at > \$3\)/g) || []).length, 2)
})

test('sparse-match batches require a receipt and discard untrusted positives', () => {
  const items = [{ source_id: 'email:1' }, { source_id: 'email:2' }]
  const batchId = classificationBatchId(items)
  assert.throws(
    () => validateBatchResponse({ batch_id: 'wrong', matches: [] }, items),
    /wrong batch receipt/,
  )
  const valid = validateBatchResponse({
    batch_id: batchId,
    matches: [
      { id: 'email:1', relevance: 0.7 },
      { id: 'email:1', relevance: 0.9 },
      { id: 'email:3', relevance: 1 },
      { relevance: 1 },
    ],
  }, items)
  assert.equal(valid.size, 1)
  assert.equal(valid.get('email:1').relevance, 0.9)
})
