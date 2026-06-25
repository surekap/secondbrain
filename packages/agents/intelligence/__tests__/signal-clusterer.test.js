const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignalClusters, shouldPromoteCluster, opportunityFromCluster } = require('../services/signal-clusterer');

test('signal-clusterer: clusters corroborated signals by project and meaningful topic terms', () => {
  const signals = [
    { id: 1, signal_type: 'risk', title: 'SPIC cleanup failed again', description: 'Cleanup SPIC messages failed', project_id: 42, occurred_at: '2026-06-24T00:00:00Z', confidence: 0.7, strength: 65, source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'SPIC cleanup messages not deleted', description: 'SPIC cleanup messages failure', project_id: 42, occurred_at: '2026-06-25T00:00:00Z', confidence: 0.8, strength: 70, source_table: 'whatsapp', source_id: 'b' },
    { id: 3, signal_type: 'risk', title: 'SPIC Apps Script cleanup failed', description: 'Google Apps Script cleanup failed for SPIC', project_id: 42, occurred_at: '2026-06-23T00:00:00Z', confidence: 0.75, strength: 60, source_table: 'projects', source_id: 'c' },
    { id: 4, signal_type: 'risk', title: 'Unrelated certificate rotation', description: 'Axis cert rotation issue', project_id: 99, occurred_at: '2026-06-25T00:00:00Z', confidence: 0.7, strength: 55, source_table: 'email', source_id: 'd' },
  ];

  const clusters = buildSignalClusters(signals);
  const spic = clusters.find(c => c.cluster_key.includes('project:42'));

  assert.ok(spic, 'expected a project-linked SPIC cluster');
  assert.equal(spic.signal_count, 3);
  assert.equal(spic.project_id, 42);
  assert.ok(spic.cluster_terms.includes('spic'));
  assert.ok(shouldPromoteCluster(spic));
});

test('signal-clusterer: does not promote single unlinked weak signals', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'offer', title: 'Aircraft broker referral', description: 'someone can help', occurred_at: '2026-06-25T00:00:00Z', confidence: 0.55, source_table: 'whatsapp', source_id: 'x' },
  ]);

  assert.equal(cluster.signal_count, 1);
  assert.equal(shouldPromoteCluster(cluster), false);
});

test('signal-clusterer: does not promote unlinked one-source clusters even with many hits', () => {
  const signals = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    signal_type: 'risk',
    title: 'IndusInd bank transaction risk',
    description: 'Bank transaction risk repeated in one source only',
    occurred_at: '2026-06-25T00:00:00Z',
    confidence: 0.8,
    source_table: 'email',
    source_id: `e${i}`,
  }));
  const [cluster] = buildSignalClusters(signals);

  assert.equal(cluster.signal_count, 5);
  assert.equal(cluster.source_count, 1);
  assert.equal(shouldPromoteCluster(cluster), false);
});

test('signal-clusterer: rejects noisy URL/numeric clusters', () => {
  const signals = Array.from({ length: 4 }, (_, i) => ({
    id: i + 1,
    signal_type: 'risk',
    title: 'https com 11737503 logo',
    description: 'https com 11737503 logo repeated tracking footer',
    occurred_at: '2026-06-25T00:00:00Z',
    confidence: 0.8,
    source_table: i % 2 ? 'email' : 'whatsapp',
    source_id: `n${i}`,
  }));
  const [cluster] = buildSignalClusters(signals);

  assert.equal(shouldPromoteCluster(cluster), false);
});

test('signal-clusterer: promoted opportunity has why_now and multiple evidence records', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'MT940 missing statement', description: 'bank statement missing', project_id: 7, occurred_at: '2026-06-24T00:00:00Z', source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'MT940 statement still missing', description: 'axis bank mt940 missing', project_id: 7, occurred_at: '2026-06-25T00:00:00Z', source_table: 'projects', source_id: 'b' },
  ]);
  const opportunity = opportunityFromCluster(cluster);

  assert.match(opportunity.why_now, /2 corroborating risk signals/);
  assert.equal(opportunity.evidence.length, 2);
  assert.equal(opportunity.primary_project_id, 7);
});
