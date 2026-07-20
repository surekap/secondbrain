'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  jidFromValue,
  isEligibleWhatsAppChatId,
  isGroupWhatsAppChatId,
  canonicalWhatsAppChatId,
  canonicalWhatsAppChatIdSql,
} = require('../whatsapp-chat')

test('canonical chat identity follows id.remote for modern inbound and outbound events', () => {
  assert.equal(canonicalWhatsAppChatId({
    id: { remote: '121234567890123@lid', fromMe: false },
    from: '121234567890123@lid',
    to: '919111111111@c.us',
  }, { selfJid: '919111111111@c.us' }), '121234567890123@lid')

  assert.equal(canonicalWhatsAppChatId({
    id: { remote: '120363123456789012@g.us', fromMe: true },
    from: '999999999999999@lid',
    to: '120363123456789012@g.us',
  }, { selfJids: ['919111111111@c.us', '999999999999999@lid'] }), '120363123456789012@g.us')
})

test('directional fallback does not mistake the account owner for an outbound conversation', () => {
  assert.equal(canonicalWhatsAppChatId({
    id: { fromMe: true },
    from: '919111111111@c.us',
    to: '919876543210@c.us',
  }, { selfJid: '919111111111@c.us', storedChatId: '919111111111@c.us' }), '919876543210@c.us')

  assert.equal(canonicalWhatsAppChatId({
    id: { fromMe: true },
    from: '999999999999999@lid',
    to: '120363123456789012@g.us',
  }, { storedChatId: '999999999999999@lid' }), '120363123456789012@g.us')
})

test('historical Wid objects and s.whatsapp.net addresses normalize without changing message IDs', () => {
  const historical = {
    id: { remote: { user: '919876543210', server: 's.whatsapp.net' }, fromMe: false },
    from: { _serialized: '919876543210@s.whatsapp.net' },
    to: { _serialized: '919111111111@c.us' },
  }
  assert.equal(jidFromValue(historical.from), '919876543210@c.us')
  assert.equal(canonicalWhatsAppChatId(historical, { selfJid: '919111111111@c.us' }), '919876543210@c.us')
})

test('eligibility retains legitimate LIDs and groups but rejects pseudo-chats', () => {
  for (const jid of ['919876543210@c.us', '121234567890123@lid', '120363123456789012@g.us']) {
    assert.equal(isEligibleWhatsAppChatId(jid), true)
  }
  for (const jid of ['0@c.us', 'status@broadcast', '12345@newsletter', '919111111111@broadcast', 'true_9199_MESSAGE']) {
    assert.equal(isEligibleWhatsAppChatId(jid), false)
  }
  assert.equal(isGroupWhatsAppChatId('120363123456789012@g.us'), true)
  assert.equal(canonicalWhatsAppChatId({ id: { remote: 'status@broadcast' } }), null)
  assert.equal(canonicalWhatsAppChatId({ id: { remote: '919111111111@c.us' } }, { selfJid: '919111111111@c.us' }), null)
})

test('SQL derivation shares remote/direction/group/self and eligibility rules', () => {
  const sql = canonicalWhatsAppChatIdSql({ selfExpression: '$2' })
  assert.match(sql, /\{id,remote/)
  assert.match(sql, /fromMe/)
  assert.match(sql, /@lid/)
  assert.match(sql, /@g\\\.us/)
  assert.match(sql, /candidate\.jid <>/)
  assert.doesNotMatch(sql, /id,_serialized/)
})
