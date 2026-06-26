const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const syncSource = fs.readFileSync(path.join(__dirname, '../lib/sync.js'), 'utf8')
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
const schemaSource = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')

test('historical sync is configurable for one-shot 90 day backfills', () => {
  assert.match(syncSource, /function startHistoricalSync\(client, clientId, runId = null, options = \{\}\)/)
  assert.match(syncSource, /options\.days \|\| DEFAULT_LOOKBACK_DAYS/)
  assert.match(syncSource, /options\.msgLimit \|\| DEFAULT_MSG_LIMIT/)
  assert.match(syncSource, /_fetchChatMessages\(chat, msgLimit\)/)
  assert.match(syncSource, /chat\.fetchMessages\(\{ limit: msgLimit \}\)/)
})

test('historical sync falls back when WhatsApp Web loadEarlierMsgs path is broken', () => {
  assert.match(syncSource, /waitForChatLoading/)
  assert.match(syncSource, /using loaded-message fallback/)
  assert.match(syncSource, /window\.WWebJS\.getChat\(chatId, \{ getAsModel: false \}\)/)
  assert.match(syncSource, /chatModel\?\.msgs\?\.getModelsArray/)
  assert.match(syncSource, /window\.WWebJS\.getMessageModel\(m\)/)
})

test('startup historical sync is disabled by default so manual 90 day backfill can run on a fresh bridge', () => {
  assert.match(appSource, /WHATSAPP_AUTO_SYNC_ON_READY === '1'/)
  assert.match(appSource, /startup historical sync skipped/)
  assert.doesNotMatch(appSource, /setWaState\('CONNECTED'\);\n\s*if \(telemetry\).*\n\s*startHistoricalSync\(client, process\.env\.CLIENT_ID, _runId\);/)
})

test('historical sync reports getChats failures instead of silent zero-row success', () => {
  assert.match(syncSource, /could not load chats after 3 attempts, aborting/)
  assert.match(syncSource, /syncState\.errors\.push\(\{ chat: null, error: message/)
  assert.match(syncSource, /throw new Error\(message\)/)
})

test('historical sync exposes status and rejects concurrent runs', () => {
  assert.match(syncSource, /const syncState = \{/)
  assert.match(syncSource, /historical sync already running/)
  assert.match(syncSource, /getHistoricalSyncStatus/)
  assert.match(appSource, /app\.get\('\/api\/sync\/historical\/status'/)
  assert.match(appSource, /app\.post\('\/api\/sync\/historical'/)
  assert.match(appSource, /res\.status\(409\)/)
})

test('historical sync remains deduplicated by WhatsApp message id and does not replay webhooks', () => {
  assert.match(schemaSource, /CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_msg_id_idx/)
  assert.match(syncSource, /ON CONFLICT \(wa_msg_id\) WHERE wa_msg_id IS NOT NULL DO NOTHING/)
  assert.match(syncSource, /'message_historical'/)
  assert.doesNotMatch(syncSource, /dispatcher\.dispatch/)
})

test('manual historical sync can disable media downloads to avoid a storm', () => {
  assert.match(syncSource, /downloadMedia = options\.downloadMedia !== false/)
  assert.match(appSource, /const downloadMedia = Boolean\(req\.body\?\.downloadMedia\)/)
  assert.match(appSource, /\{ days, msgLimit, chatDelayMs, downloadMedia \}/)
})
