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
  assert.match(schema, /evidence_count >= 3 THEN 4 WHEN evidence_count = 2 THEN 1/, 'multiple evidence records should get a modest boost');
  assert.match(schema, /THEN 'recent_source'/, 'recent source items should be flagged');
});

test('attention-scoring: clamps scores at zero', () => {
  const schema = readSchema();
  assert.match(schema, /GREATEST\(0,/, 'attention scores should not become negative after penalties');
});

test('attention-scoring: penalizes low-value admin, generic next actions, and missing why-now', () => {
  const schema = readSchema();

  assert.match(schema, /THEN 35 ELSE 0 END/, 'low-value admin items should receive a large penalty');
  assert.match(schema, /THEN 'low_value_admin'/, 'low-value admin items should be flagged');
  assert.match(schema, /THEN 18 ELSE 0 END/, 'generic next actions should receive a penalty');
  assert.match(schema, /THEN 'generic_next_action'/, 'generic next actions should be flagged');
  assert.match(schema, /THEN 'missing_why_now'/, 'items with no why-now should be flagged');
});
