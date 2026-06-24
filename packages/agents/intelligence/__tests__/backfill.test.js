const test = require('node:test');
const assert = require('node:assert');
const { backfillOpportunities } = require('../services/backfill');

test('backfill: migrates relationships.insights to opportunities', async () => {
  const mockInsights = [
    {
      id: 'insight_1',
      contact_id: 'alice@example.com',
      insight_type: 'project_mention',
      insight: 'mentioned new startup idea'
    }
  ];

  const opportunities = await backfillOpportunities(mockInsights, 'relationships.insights');
  assert.ok(opportunities.length > 0, 'should create opportunities from insights');
  assert.strictEqual(opportunities[0].source, 'insight', 'should set source to insight');
});

test('backfill: deduplicates on insight_id_hash', async () => {
  const mockInsights = [
    { id: 'insight_1', contact_id: 'alice@example.com', insight_type: 'project_mention', insight: 'startup' },
    { id: 'insight_1', contact_id: 'alice@example.com', insight_type: 'project_mention', insight: 'startup' }
  ];

  const opportunities = await backfillOpportunities(mockInsights, 'relationships.insights');
  assert.strictEqual(opportunities.length, 1, 'should deduplicate identical insights');
});
