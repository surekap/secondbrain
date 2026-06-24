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
