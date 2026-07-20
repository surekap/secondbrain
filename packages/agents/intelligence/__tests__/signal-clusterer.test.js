const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignalClusters, shouldPromoteCluster, opportunityFromCluster, clusterPromotionPlan, validateClusterVerification } = require('../services/signal-clusterer');

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

test('canonical table pointers still corroborate across distinct channel kinds', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'Certificate rotation blocks launch', description: 'certificate rotation launch risk', project_id: 4, source_table: 'relationships.communications', source_id: 'email:1', metadata: { source_kind: 'email' } },
    { id: 2, signal_type: 'risk', title: 'Certificate rotation blocks launch', description: 'certificate rotation launch risk', project_id: 4, source_table: 'relationships.communications', source_id: 'wa:2', metadata: { source_kind: 'whatsapp' } },
  ]);
  assert.equal(cluster.source_count, 2);
  assert.ok(shouldPromoteCluster(cluster));
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
  const clusters = buildSignalClusters(signals);

  assert.equal(clusters.length, 5);
  assert.ok(clusters.every(cluster => cluster.signal_count === 1));
  assert.ok(clusters.every(cluster => shouldPromoteCluster(cluster) === false));
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

test('signal-clusterer: does not promote linked clusters from one source only', () => {
  const signals = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    signal_type: 'risk',
    title: 'Hartex ERP called Gaurav about implementation risk',
    description: 'ERP implementation risk repeated in one imported source only',
    project_id: 9,
    project_name: 'Hartex Grapevine ERP Implementation',
    occurred_at: '2026-06-25T00:00:00Z',
    confidence: 0.8,
    source_table: 'limitless',
    source_id: `l${i}`,
  }));
  const [cluster] = buildSignalClusters(signals);

  assert.equal(cluster.signal_count, 5);
  assert.equal(cluster.source_count, 1);
  assert.equal(shouldPromoteCluster(cluster), false);
});

test('signal-clusterer: suppresses self-contact clusters', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'GitHub repository security risk', description: 'security github repository storage risk', contact_id: 284, contact_name: 'Prateek Sureka', occurred_at: '2026-06-24T00:00:00Z', source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'Dropbox repository security risk', description: 'security github repository storage risk', contact_id: 284, contact_name: 'Prateek Sureka', occurred_at: '2026-06-25T00:00:00Z', source_table: 'whatsapp', source_id: 'b' },
  ]);

  assert.equal(shouldPromoteCluster(cluster), false);
});

test('signal-clusterer: generic identity/channel words are not promoted as evidence terms', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'Prateek Sureka direct 3rd Claude', description: 'Prateek Sureka direct 3rd Claude', project_id: 49, occurred_at: '2026-06-24T00:00:00Z', source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'Sureka direct Prateek Claude', description: 'direct Prateek Sureka 3rd', project_id: 49, occurred_at: '2026-06-25T00:00:00Z', source_table: 'whatsapp', source_id: 'b' },
  ]);

  assert.equal(shouldPromoteCluster(cluster), false);
});

test('signal-clusterer: promotion plan identifies stale previously-promoted clusters', () => {
  const clusters = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'MT940 missing statement', description: 'bank statement missing', project_id: 7, occurred_at: '2026-06-24T00:00:00Z', source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'MT940 statement still missing', description: 'axis bank mt940 missing', project_id: 7, occurred_at: '2026-06-25T00:00:00Z', source_table: 'projects', source_id: 'b' },
  ]);
  const validKey = clusters[0].cluster_key;
  const plan = clusterPromotionPlan(clusters, [`signal_cluster:${validKey}`, 'signal_cluster:risk:source:email:blog-com']);

  assert.deepEqual(plan.staleSourceRefs, ['signal_cluster:risk:source:email:blog-com']);
  assert.equal(plan.promotableClusters.length, 1);
});

test('signal-clusterer: promoted opportunity has why_now and multiple evidence records', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'MT940 missing statement', description: 'bank statement missing', project_id: 7, project_name: 'Allied Finance Ops', occurred_at: '2026-06-24T00:00:00Z', source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'MT940 statement still missing', description: 'axis bank mt940 missing', project_id: 7, project_name: 'Allied Finance Ops', occurred_at: '2026-06-25T00:00:00Z', source_table: 'projects', source_id: 'b' },
  ]);
  const opportunity = opportunityFromCluster(cluster);

  assert.match(opportunity.why_now, /2 corroborating risk signals/);
  assert.match(opportunity.why_now, /latest signal 2026-06-25/);
  assert.equal(opportunity.evidence.length, 2);
  assert.deepEqual(opportunity.evidence.map(item => item.source_table), ['email', 'projects']);
  assert.deepEqual(opportunity.evidence.map(item => item.source_id), ['a', 'b']);
  assert.equal(opportunity.primary_project_id, 7);
});

test('signal-clusterer: synthesizes project-linked risk into a concrete non-generic action', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'ERP implementation execution blocked', description: 'Hartex ERP implementation has blocked execution calls', project_id: 9, project_name: 'Hartex Grapevine ERP Implementation', occurred_at: '2026-06-24T00:00:00Z', source_table: 'projects', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'Hartex ERP implementation deadline risk', description: 'ERP execution needs owner and date', project_id: 9, project_name: 'Hartex Grapevine ERP Implementation', occurred_at: '2026-06-25T00:00:00Z', source_table: 'email', source_id: 'b' },
  ]);
  const opportunity = opportunityFromCluster(cluster);

  assert.equal(opportunity.title.startsWith('Cluster:'), false);
  assert.match(opportunity.title, /Hartex Grapevine ERP Implementation/);
  assert.match(opportunity.recommended_next_action, /Hartex Grapevine ERP Implementation/);
  assert.match(opportunity.recommended_next_action, /erp/i);
  assert.match(opportunity.recommended_next_action, /implementation/i);
  assert.match(opportunity.recommended_next_action, /hartex/i);
  assert.doesNotMatch(opportunity.recommended_next_action, /Assign an owner to validate the clustered risk|Review the clustered signals|convert to one concrete action/i);
});

test('signal-clusterer: synthesizes contact-linked need into a named outreach action', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'need', title: 'Rubix partnership help needed', description: 'Rubix partnership with Siddharth needs follow up', contact_id: 55, contact_name: 'Siddharth Agarwal', occurred_at: '2026-06-24T00:00:00Z', source_table: 'whatsapp', source_id: 'a' },
    { id: 2, signal_type: 'need', title: 'Siddharth Agarwal partnership need', description: 'partnership rubix siddharth action', contact_id: 55, contact_name: 'Siddharth Agarwal', occurred_at: '2026-06-25T00:00:00Z', source_table: 'email', source_id: 'b' },
  ]);
  const opportunity = opportunityFromCluster(cluster);

  assert.match(opportunity.title, /Siddharth Agarwal/);
  assert.match(opportunity.recommended_next_action, /^Ask Siddharth Agarwal/);
  assert.match(opportunity.recommended_next_action, /partnership, rubix, siddharth/i);
  assert.doesNotMatch(opportunity.recommended_next_action, /Review the clustered signals|owner\/contact|convert to one concrete action/i);
});

test('signal-clusterer: separates unrelated topics linked to the same project', () => {
  const clusters = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'Certificate rotation blocks launch', description: 'TLS certificate expires before production launch', project_id: 4, source_table: 'email', source_id: 'a' },
    { id: 2, signal_type: 'risk', title: 'Vendor invoice remains unpaid', description: 'Supplier payment invoice is overdue', project_id: 4, source_table: 'whatsapp', source_id: 'b' },
  ]);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every(cluster => cluster.project_id === 4));
});

test('schema verifier preserves actor and exact canonical evidence', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'need', title: 'Need tax advice', description: 'I need tax advice for the trust', contact_id: 5, source_table: 'relationships.communications', source_id: '101', metadata: { source_kind: 'whatsapp', direction: 'outbound' } },
    { id: 2, signal_type: 'need', title: 'Trust tax advice', description: 'I need tax advice for the trust this week', contact_id: 5, source_table: 'relationships.communications', source_id: '102', metadata: { source_kind: 'email', direction: 'outbound' } },
  ]);
  const verified = validateClusterVerification({ promote: true, claims: [{
    claim_type: 'need', actor_type: 'self', actor_id: null,
    subject_type: 'contact', subject_id: '5', predicate: 'Tax advice is needed for the trust',
    polarity: 'positive', lifecycle_state: 'active',
    evidence: [{ ref: 'relationships.communications:101', quote: 'I need tax advice for the trust' }],
  }] }, cluster);
  assert.equal(verified.promote, true);
  assert.equal(verified.claims[0].actor_type, 'self');
  assert.equal(verified.claims[0].evidence[0].signal.source_id, '101');
})

test('schema verifier rejects misattributed outbound and invented evidence', () => {
  const [cluster] = buildSignalClusters([
    { id: 1, signal_type: 'risk', title: 'Issue blocked', description: 'No update; the issue is still blocked', contact_id: 5, source_table: 'relationships.communications', source_id: '201', metadata: { source_kind: 'whatsapp', direction: 'outbound' } },
    { id: 2, signal_type: 'risk', title: 'Issue blocked', description: 'The issue is still blocked today', contact_id: 5, source_table: 'relationships.communications', source_id: '202', metadata: { source_kind: 'email', direction: 'outbound' } },
  ]);
  const verified = validateClusterVerification({ promote: true, claims: [{
    claim_type: 'risk', actor_type: 'contact', actor_id: '5',
    subject_type: 'contact', subject_id: '5', predicate: 'Issue is resolved',
    polarity: 'negative', lifecycle_state: 'resolved',
    evidence: [{ ref: 'relationships.communications:missing', quote: 'issue is still blocked' }],
  }] }, cluster);
  assert.equal(verified.promote, false);
  assert.deepEqual(verified.claims, []);
})

test('signal-clusterer: fails closed instead of globally joining unlinked evidence by shared terms', () => {
  const clusters = buildSignalClusters([
    { id: 1, signal_type: 'need', title: 'ERP implementation partner needed', description: 'Seeking ERP rollout partner', source_table: 'email', source_id: 'a', confidence: 0.8 },
    { id: 2, signal_type: 'need', title: 'Need ERP implementation partner', description: 'ERP rollout partner search', source_table: 'whatsapp', source_id: 'b', confidence: 0.8 },
    { id: 3, signal_type: 'need', title: 'ERP implementation partner search', description: 'Seeking partner for ERP rollout', source_table: 'limitless', source_id: 'c', confidence: 0.8 },
  ]);
  assert.equal(clusters.length, 3);
  assert.ok(clusters.every(cluster => shouldPromoteCluster(cluster) === false));
  assert.ok(clusters.every(cluster => cluster.cluster_key.includes(':unresolved:')));
});
