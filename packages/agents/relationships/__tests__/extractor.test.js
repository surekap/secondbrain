'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeEmailSenderRow } = require('../services/extractor')
const fs = require('fs')
const path = require('path')

test('email sender extractor exposes one documented raw/name/email contract', () => {
  const sender = normalizeEmailSenderRow({
    from_address: '"Grace Hopper" <GRACE@Example.COM>',
    email_count: '12',
  })
  assert.equal(sender.raw_address, '"Grace Hopper" <GRACE@Example.COM>')
  assert.equal(sender.from_address, sender.raw_address)
  assert.equal(sender.name, 'Grace Hopper')
  assert.equal(sender.email, 'grace@example.com')
  assert.equal(sender.parsed_email, undefined)
})

test('group and Limitless recovery queries exclude already-canonical source IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
  assert.match(source, /getUnstoredGroupMessages/)
  assert.match(source, /c\.source_id = 'wa:' \|\|/)
  assert.match(source, /getUnstoredLimitlessConversations/)
  assert.match(source, /c\.source_id = 'limitless:' \|\| l\.id::text/)
})

test('direct WhatsApp and email recovery are source-level missing scans, not per-contact samples', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
  assert.match(source, /getUnstoredDirectMessages/)
  assert.match(source, /c\.source_id = 'wa:' \|\|/)
  assert.match(source, /getUnstoredEmailCommunications/)
  assert.match(source, /c\.source_id = 'email:' \|\| e\.id::text/)
  assert.match(source, /ORDER BY e\.date ASC, e\.id ASC/)
  assert.match(source, /canonicalWhatsAppChatIdSql/)
  assert.match(source, /chat\.chat_id LIKE '%@lid'/)
  assert.match(source, /COALESCE\(NULLIF\(.*wa_msg_id/)
})

test('direct-contact names are aggregated in one canonical scan', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
  assert.match(source, /WITH messages AS MATERIALIZED/)
  assert.match(source, /notify_counts AS/)
  assert.match(source, /best_notify_name AS/)
  assert.doesNotMatch(source, /canonicalChatSql\('m2'/)
})

test('scheduled extraction finds semantic media that arrived after canonical ingestion', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
  assert.match(source, /async function getStaleMediaCommunications/)
  assert.match(source, /JOIN relationships\.communications c/)
  assert.match(source, /c\.metadata->>'media_semantic_text'/)
  assert.match(source, /media\.semantic_text/)
})

test('full email recovery retains unresolved senders and account provenance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/extractor.js'), 'utf8')
  assert.match(source, /LEFT JOIN relationships\.email_senders es/)
  assert.match(source, /account\.email AS account_email/)
  assert.match(source, /es\.parsed_email AS sender_email/)
})
