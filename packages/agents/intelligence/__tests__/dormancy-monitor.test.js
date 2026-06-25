const test = require('node:test');
const assert = require('node:assert');
const { checkDormancy } = require('../services/dormancy-monitor');

test('dormancy-monitor: creates check_in for tier_1 contact exceeding 30 days', async () => {
  const now = new Date();
  const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

  const mockContact = {
    id: 'alice@example.com',
    relationship_tier: 'tier_1',
    last_contact_date: thirtyFiveDaysAgo
  };

  const opportunities = await checkDormancy([mockContact]);
  assert.ok(opportunities.length > 0, 'should create check_in opportunity');
  assert.strictEqual(opportunities[0].source, 'dormancy', 'should set source to dormancy');
  assert.strictEqual(opportunities[0].contact_id, 'alice@example.com', 'should link to contact');
});

test('dormancy-monitor: does not flag tier_1 contact within 30 days', async () => {
  const now = new Date();
  const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);

  const mockContact = {
    id: 'bob@example.com',
    relationship_tier: 'tier_1',
    last_contact_date: twentyDaysAgo
  };

  const opportunities = await checkDormancy([mockContact]);
  assert.strictEqual(opportunities.length, 0, 'should not flag recent contacts');
});

test('dormancy-monitor: skips contacts without next-touch obligation', async () => {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const mockContact = {
    id: 'duplicate@example.com',
    relationship_tier: 'tier_1',
    last_contact_date: ninetyDaysAgo,
    next_suggested_touch_at: null,
  };

  const opportunities = await checkDormancy([mockContact]);
  assert.strictEqual(opportunities.length, 0, 'duplicates/suppressed contacts should not create dormancy obligations');
});

test('dormancy-monitor: deduplicates on dormancy:{contact_id}:{tier}', async () => {
  const now = new Date();
  const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

  const mockContact = {
    id: 'alice@example.com',
    relationship_tier: 'tier_1',
    last_contact_date: thirtyFiveDaysAgo
  };

  // Call twice to test deduplication
  const result1 = await checkDormancy([mockContact]);
  const result2 = await checkDormancy([mockContact]);

  assert.strictEqual(result1.length, 1, 'should create one opportunity on first call');
  assert.strictEqual(result2.length, 1, 'should still return one on second call (deduplicated)');
});
