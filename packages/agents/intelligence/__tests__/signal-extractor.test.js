const test = require('node:test');
const assert = require('node:assert');
const { extractSignals } = require('../services/signal-extractor');

test('signal-extractor: extracts need signals from email content', async () => {
  const mockEmail = {
    id: 'email_123',
    from_addr: 'alice@example.com',
    subject: 'help needed with backend',
    body: 'I need advice on scaling database queries'
  };

  const signals = await extractSignals([mockEmail], 'email');
  assert.ok(signals.some(s => s.signal_type === 'need' && s.content.includes('scaling')),
    'should extract need signal from email body');
});

test('signal-extractor: deduplicates on source_id_hash', async () => {
  const mockEmails = [
    { id: 'e1', from_addr: 'bob@example.com', subject: 'offer', body: 'I can help with React' },
    { id: 'e1', from_addr: 'bob@example.com', subject: 'offer', body: 'I can help with React' }
  ];

  const signals = await extractSignals(mockEmails, 'email');
  const offerCount = signals.filter(s => s.signal_type === 'offer').length;
  assert.strictEqual(offerCount, 1, 'should deduplicate identical signals');
});

test('signal-extractor: does not feed generated opportunities back into weak signals', async () => {
  const signals = await extractSignals([
    {
      id: 1,
      title: 'Prateek Sureka: risk signals on security',
      description: 'Ask Prateek Sureka to confirm the risk and owner',
      source_ref: 'cross_channel_project:1:2:284',
      primary_contact_name: 'Prateek Sureka'
    }
  ], 'opportunities');
  assert.strictEqual(signals.length, 0);
});

test('signal-extractor: keeps closure as counter-evidence instead of an active risk', async () => {
  const signals = await extractSignals([{ id: 'e2', subject: 'Certificate issue fixed', body: 'The certificate risk was resolved and is no longer blocking us.' }], 'email');
  const risk = signals.find(signal => signal.signal_type === 'risk');
  assert.equal(risk.polarity, 'negative');
  assert.equal(risk.lifecycle_state, 'resolved');
  assert.match(risk.evidence_quote, /resolved/);
});

test('canonical communication signals preserve inspectable pointers and channel identity', async () => {
  const [signal] = await extractSignals([{
    id: 991,
    source_id: 'email:42',
    canonical_table: 'relationships.communications',
    contact_id: 7,
    subject: 'Certificate rotation risk',
    content_snippet: 'The certificate rotation is blocked',
    occurred_at: '2026-07-20T00:00:00Z',
  }], 'email');
  assert.equal(signal.source_table, 'relationships.communications');
  assert.equal(signal.source_id, '991');
  assert.equal(signal.metadata.source_kind, 'email');
  assert.equal(signal.metadata.canonical_source_ref, 'email:42');
  assert.equal(signal.contact_id, 7);
});

test('signal-extractor: never splits emoji into invalid JSON surrogates', async () => {
  const signals = await extractSignals([{
    id: 77,
    subject: `Need help ${'x'.repeat(482)}😀 after`,
    body_text: 'Need help with the scheduled review',
  }], 'email');

  assert.ok(signals.length > 0);
  for (const signal of signals) {
    const json = JSON.stringify(signal.metadata);
    assert.doesNotMatch(json, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i);
  }
});
