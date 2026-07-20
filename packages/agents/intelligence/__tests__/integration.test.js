const test = require('node:test');
const assert = require('node:assert');

test('intelligence-integration: all services can be imported', async () => {
  // Verify that all services are properly exported and importable
  const { extractSignals } = require('../services/signal-extractor');
  const { backfillOpportunities } = require('../services/backfill');
  const { checkDormancy } = require('../services/dormancy-monitor');
  const { extractOrganizations } = require('../services/organization-extractor');

  assert.ok(typeof extractSignals === 'function', 'signal-extractor should export extractSignals');
  assert.ok(typeof backfillOpportunities === 'function', 'backfill should export backfillOpportunities');
  assert.ok(typeof checkDormancy === 'function', 'dormancy-monitor should export checkDormancy');
  assert.ok(typeof extractOrganizations === 'function', 'organization-extractor should export extractOrganizations');
});

test('intelligence-integration: runIntelligenceServices is exported', async () => {
  // Verify the main orchestration function is exported
  const { runIntelligenceServices } = require('../index.js');
  assert.ok(typeof runIntelligenceServices === 'function', 'index.js should export runIntelligenceServices');
});

test('intelligence schema readiness is tracked per database interface', async () => {
  const { ensureSchema } = require('../index.js');
  const calls = [];
  const first = { query: async sql => { calls.push(['first', sql]); return { rows: [] }; } };
  const second = { query: async sql => { calls.push(['second', sql]); return { rows: [] }; } };
  await ensureSchema(first);
  await ensureSchema(first);
  await ensureSchema(second);
  assert.deepStrictEqual(calls.map(([name]) => name), ['first', 'second']);
});

test('intelligence-integration: services handle empty arrays gracefully', async () => {
  const { extractSignals } = require('../services/signal-extractor');
  const { backfillOpportunities } = require('../services/backfill');
  const { checkDormancy } = require('../services/dormancy-monitor');
  const { extractOrganizations } = require('../services/organization-extractor');

  // All services should handle empty input gracefully
  const emptySignals = await extractSignals([], 'email');
  assert.strictEqual(emptySignals.length, 0, 'extractSignals should return empty array for empty input');

  const emptyBackfill = await backfillOpportunities([], 'relationships.insights');
  assert.strictEqual(emptyBackfill.length, 0, 'backfillOpportunities should return empty array for empty input');

  const emptyDormancy = await checkDormancy([]);
  assert.strictEqual(emptyDormancy.length, 0, 'checkDormancy should return empty array for empty input');

  const emptyOrgs = await extractOrganizations([], 'contacts');
  assert.strictEqual(emptyOrgs.organizations.length, 0, 'extractOrganizations should return empty orgs for empty input');
  assert.strictEqual(emptyOrgs.contactLinks.length, 0, 'extractOrganizations should return empty links for empty input');
});
