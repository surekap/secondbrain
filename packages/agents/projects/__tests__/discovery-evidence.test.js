'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  DISCOVERY_VERSION,
  hasVerifiedOutcomeEvidence,
  parseJSON,
  projectArrayFromPayload,
  validateDiscoveredProjects,
} = require('../services/discoverer')

test('accepts the object envelope required by structured JSON providers', () => {
  assert.deepEqual(projectArrayFromPayload({ projects: [{ name: 'A' }] }), [{ name: 'A' }])
  assert.deepEqual(parseJSON('{"projects":[{"name":"A"}]}'), { projects: [{ name: 'A' }] })
})

test('recovers complete project rows from a truncated object envelope', () => {
  assert.deepEqual(
    parseJSON('{"projects":[{"name":"A"},{"name":"unfinished"'),
    [{ name: 'A' }],
  )
})

const episodes = [
  { source_id: 'email:1', content_snippet: 'Launch the ERP migration by September' },
  { source_id: 'wa:2', content_snippet: 'The launch owner is Gaurav' },
]
const existing = [{ id: 7, name: 'ERP Migration', description: 'Move production to the new ERP' }]

test('project schema stages novel candidates before catalog admission', () => {
  const schema = require('node:fs').readFileSync(require('node:path').join(__dirname, '../sql/schema.sql'), 'utf8')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS projects\.project_candidates/)
  assert.match(schema, /occurrences INT NOT NULL DEFAULT 1/)
  assert.match(schema, /status IN \('pending','admitted','rejected'\)/)
})

test('project discovery rejects channel/name-only and invented evidence', () => {
  const projects = validateDiscoveredProjects([
    { name: 'Alice relationship', evidence_refs: [] },
    { name: 'Hallucinated project', evidence_refs: ['email:missing'] },
  ], episodes, existing)
  assert.deepEqual(projects, [])
})

test('new projects require a verbatim outcome-bearing excerpt and completion test', () => {
  assert.equal(hasVerifiedOutcomeEvidence({
    completion_test: 'Production has migrated successfully',
    outcome_evidence: { ref: 'email:1', quote: 'Launch the ERP migration by September' },
  }, episodes), true)
  assert.equal(hasVerifiedOutcomeEvidence({
    completion_test: 'Learn more over time',
    outcome_evidence: { ref: 'email:1', quote: 'ERP migration' },
  }, episodes), false)

  const projects = validateDiscoveredProjects([{
    name: 'General research',
    evidence_refs: ['email:1'],
  }], episodes, existing)
  assert.deepEqual(projects, [])
})

test('existing project identity must be explicit and evidence-backed', () => {
  const [project] = validateDiscoveredProjects([{
    name: 'A similar but model-written name',
    existing_project_id: 7,
    evidence_refs: ['email:1', 'invented'],
  }], episodes, existing)
  assert.equal(project.name, 'ERP Migration')
  assert.equal(project.existing_project_id, 7)
  assert.deepEqual(project.evidence_refs, ['email:1'])
  assert.equal(project.discovery_version, DISCOVERY_VERSION)
})

test('similar new names remain distinct without an explicit existing id', () => {
  const projects = validateDiscoveredProjects([
    {
      name: 'ERP Migration Phase Two', existing_project_id: null, evidence_refs: ['email:1'],
      completion_test: 'The ERP migration is launched by September',
      outcome_evidence: { ref: 'email:1', quote: 'Launch the ERP migration by September' },
    },
    {
      name: 'ERP Migration Vendor Exit', existing_project_id: null, evidence_refs: ['email:1'],
      completion_test: 'The ERP migration is launched by September',
      outcome_evidence: { ref: 'email:1', quote: 'Launch the ERP migration by September' },
    },
  ], episodes, existing)
  assert.equal(projects.length, 2)
})
