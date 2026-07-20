'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const classifier = fs.readFileSync(path.join(__dirname, '..', 'services', 'classifier.js'), 'utf8')
const analyzer = fs.readFileSync(path.join(__dirname, '..', 'services', 'analyzer.js'), 'utf8')
const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8')
const { normalizedProjectState } = require('../services/analyzer')

test('project communication counters reset after the final link is removed', () => {
  const countStep = index.slice(index.indexOf('// ── 5.'), index.indexOf('// ── 6.'))
  assert.match(countStep, /LEFT JOIN projects\.project_communications/)
  assert.match(countStep, /COUNT\(pc\.id\)::integer/)
  assert.match(countStep, /IS DISTINCT FROM current_stats\.cnt/)
})

test('reanalysis observes classification updates rather than insert timestamps only', () => {
  assert.match(schema, /project_communications ADD COLUMN IF NOT EXISTS updated_at/)
  assert.match(classifier, /classification_decision_id = EXCLUDED\.classification_decision_id,\s*updated_at = NOW\(\)/)
  assert.match(index, /COALESCE\(pc\.updated_at, pc\.created_at\) > \$1/)
  assert.doesNotMatch(index.slice(index.indexOf('// ── 6.'), index.indexOf('// ── 7.')), /p\.comm_count > 0\s+AND \(/)
})

test('historical bookkeeping changes do not trigger fresh project synthesis', () => {
  assert.match(index, /COALESCE\(pc\.updated_at, pc\.created_at\) > \$1/)
  assert.match(index, /pc\.occurred_at > \$1/)
  assert.doesNotMatch(index, /OR p\.updated_at > \$1/)
})

test('all project classification reads canonical media-enriched communications', () => {
  assert.match(classifier, /project-canonical-episode-v3/)
  assert.equal((classifier.match(/FROM relationships\.communications rc/g) || []).length, 3)
  assert.doesNotMatch(classifier, /FROM email\.emails|FROM limitless\.lifelogs|FROM public\.messages/)
  assert.match(classifier, /rc\.content_snippet/)
  assert.match(classifier, /canonical_source_refs/)
  assert.match(classifier, /metadata = EXCLUDED\.metadata/)
})

test('project analysis exposes only canonical communication refs for evidence lineage', () => {
  assert.match(analyzer, /projects\.communication_classifications decision/)
  assert.match(analyzer, /decision\.metadata->'canonical_source_refs'/)
  assert.match(analyzer, /canonical_refs=\$\{JSON\.stringify\(canonicalRefs\)\}/)
  assert.match(analyzer, /copied byte-for-byte from a canonical_refs array/)
  assert.doesNotMatch(analyzer, /\[ref=\$\{c\.source\}:\$\{c\.source_id\}/)
})

test('project analysis normalizes model enums before constrained persistence', () => {
  assert.deepEqual(
    normalizedProjectState(
      { status: 'in progress', health: 'healthy', ai_summary: '  Current evidence. ', next_action: { unsafe: true } },
      { status: 'unknown', health: 'unknown' },
    ),
    { status: 'active', health: 'on_track', ai_summary: 'Current evidence.', next_action: null },
  )
  assert.deepEqual(
    normalizedProjectState({ status: 'invented', health: 'green-ish' }, { status: 'on_hold', health: 'at_risk' }),
    { status: 'on_hold', health: 'at_risk', ai_summary: null, next_action: null },
  )
})
