const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function readSchema() {
  return fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
}

test('attention-scoring: penalizes old single-evidence and archival risks', () => {
  const schema = readSchema();

  assert.match(schema, /evidence_count = 1 AND scoring_source_at < NOW\(\) - INTERVAL '14 days' THEN 15/, 'old single-evidence items should receive an explicit penalty');
  assert.match(schema, /opportunity_type = 'risk' AND scoring_source_at < NOW\(\) - INTERVAL '14 days' THEN 12/, 'old risks should be treated as archival unless refreshed');
  assert.match(schema, /THEN 'old_single_evidence'/, 'old single-evidence items should be flagged');
  assert.match(schema, /THEN 'archival_risk'/, 'old risks should be flagged as archival');
});

test('attention-scoring: boosts recent, better-evidenced, high-confidence items', () => {
  const schema = readSchema();

  assert.match(schema, /scoring_source_at >= NOW\(\) - INTERVAL '3 days' THEN 8/, 'recent source evidence should get a boost');
  assert.match(schema, /confidence >= 0\.80 THEN 5/, 'high-confidence opportunities should get a boost');
  assert.match(schema, /opportunity_type = 'group_opportunity' AND evidence_count < 2 THEN 26/, 'single-evidence group opportunities should be strongly suppressed until corroborated');
  assert.match(schema, /opportunity_type = 'group_opportunity' AND primary_contact_id IS NULL AND primary_project_id IS NULL THEN 18/, 'unlinked group opportunities should be suppressed');
  assert.match(schema, /THEN 'group_single_evidence'/, 'weak group opportunities should be flagged');
  assert.match(schema, /THEN 'unlinked_group_opportunity'/, 'unlinked group opportunities should be flagged');
});

test('attention-scoring: clamps scores at zero', () => {
  const schema = readSchema();
  assert.match(schema, /GREATEST\(0,/, 'attention scores should not become negative after penalties');
});

test('attention-scoring: penalizes low-value admin, generic next actions, and missing why-now', () => {
  const schema = readSchema();

  assert.match(schema, /evidence_count = 0 THEN 45 WHEN evidence_count = 1 THEN 60/, 'single-evidence items should be suppressed below corroborated attention items');
  assert.match(schema, /why_now IS NULL OR NULLIF\(TRIM\(COALESCE\(why_now, ''\)\), ''\) IS NULL THEN 35/, 'missing why-now should receive a strong penalty');
  assert.match(schema, /THEN 'low_value_admin'/, 'low-value admin items should be flagged');
  assert.match(schema, /THEN 18 ELSE 0 END/, 'generic next actions should receive a penalty');
  assert.match(schema, /assign an owner to validate the clustered risk/, 'generic cluster validation actions should be penalized');
  assert.match(schema, /review the clustered signals/, 'generic cluster review actions should be penalized');
  assert.match(schema, /THEN 'generic_next_action'/, 'generic next actions should be flagged');
  assert.match(schema, /THEN 'missing_why_now'/, 'items with no why-now should be flagged');
});

test('attention-scoring: surfaces high-signal channels and explicit buckets', () => {
  const schema = readSchema();

  assert.match(schema, /source_priority_bonus/, 'source-aware boosting should be present');
  assert.match(schema, /opportunity_type IN \('project_match', 'project_opportunity'\) THEN 'project'/, 'project surface should be derived from opportunity type');
  assert.match(schema, /source_system IN \('manual', 'import'\) THEN 'internal'/, 'internal surface should be derived from source system');
  assert.match(schema, /opportunity_type IN \('follow_up', 'relationship_health', 'check_in'\) THEN 'closure'/, 'closure surface should be derived structurally');
  assert.match(schema, /surface_bucket,\n\s+evidence_count,/, 'attention queue should expose the surface bucket column');
  assert.doesNotMatch(schema, /source_hint_text LIKE '%/, 'surface and boost logic should not rely on hard-coded keyword matching');
});

test('attention-scoring: applies feedback-aware scoring penalties', () => {
  const schema = readSchema();

  assert.match(schema, /feedback = 'useful' THEN 10/, 'useful feedback should modestly boost similar live items');
  assert.match(schema, /feedback IN \('not_useful','false_positive','too_low_value'\) THEN -60/, 'negative feedback should heavily suppress items');
  assert.match(schema, /THEN 'negative_feedback'/, 'negative feedback should be visible in quality flags');
});

test('attention-scoring: excludes intelligence tied to archived pseudo-projects', () => {
  const schema = readSchema();
  assert.match(schema, /primary_project_id IS NULL OR COALESCE\(p\.is_archived, FALSE\) = FALSE/);
});
