const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const syncSource = fs.readFileSync(path.join(__dirname, '../lib/sync.js'), 'utf8')
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
const schemaSource = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
const mediaAnalyzerSource = fs.readFileSync(path.join(__dirname, '../lib/mediaAnalyzer.js'), 'utf8')
const mediaDownloaderSource = fs.readFileSync(path.join(__dirname, '../lib/mediaDownloader.js'), 'utf8')
const indexerSource = fs.readFileSync(path.join(__dirname, '../../../../ui/services/indexer.js'), 'utf8')

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
  assert.match(syncSource, /bulk getChats failed; loading chats individually/)
  assert.match(syncSource, /_loadChatsIndividually\(client\)/)
  assert.match(syncSource, /could not load chats after bulk and individual attempts, aborting/)
  assert.match(syncSource, /syncState\.errors\.push\(\{ chat: null, error: message/)
  assert.match(syncSource, /throw new Error\(message\)/)
})

test('historical sync isolates malformed chats when bulk chat serialization fails', () => {
  assert.match(syncSource, /WAWebCollections'\)\.Chat\.getModelsArray\(\)/)
  assert.match(syncSource, /await client\.getChatById\(entry\.id\)/)
  assert.match(syncSource, /using raw fallback/)
  assert.match(syncSource, /_fetchRawChatMessages\(client, entry\.id, limit\)/)
  assert.match(syncSource, /WAWebCollections'\)\.Chat/)
  assert.match(syncSource, /WAWebChatLoadMessages'\)\.loadEarlierMsgs/)
  assert.match(syncSource, /data\.timestamp = data\.t \?\? message\.t/)
  assert.match(syncSource, /data\.id\._serialized = data\.id\.\$1/)
})

test('manual historical sync supports resumable chat batches', () => {
  assert.match(syncSource, /chatOffset = Math\.max\(0, Number\(options\.chatOffset \|\| 0\)\)/)
  assert.match(syncSource, /chatBatchSize = options\.chatBatchSize/)
  assert.match(syncSource, /syncable\.slice\(chatOffset, batchEnd\)/)
  assert.match(syncSource, /totalAvailableChats/)
  assert.match(appSource, /req\.body\?\.chatOffset/)
  assert.match(appSource, /req\.body\?\.chatBatchSize/)
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
  assert.match(syncSource, /msg\.id\?\._serialized \?\? msg\.id\?\.\$1/)
  assert.doesNotMatch(syncSource, /dispatcher\.dispatch/)
})

test('manual historical sync can disable media downloads to avoid a storm', () => {
  assert.match(syncSource, /downloadMedia = options\.downloadMedia !== false/)
  assert.match(appSource, /const downloadMedia = Boolean\(req\.body\?\.downloadMedia\)/)
  assert.match(appSource, /\{ days, msgLimit, chatDelayMs, downloadMedia, chatOffset, chatBatchSize \}/)
})

test('connector supports remote phone-number pairing without exposing the number in logs', () => {
  assert.match(appSource, /app\.post\('\/api\/pairing-code'/)
  assert.match(appSource, /client\.requestPairingCode\(phoneNumber\)/)
  assert.match(appSource, /AWAITING_PAIRING_CODE/)
  assert.doesNotMatch(appSource, /console\.(?:log|warn|error)\([^\n]*phoneNumber/)
})

test('connector cleans stale Chrome profile locks and closes Chrome during shutdown', () => {
  assert.match(appSource, /async function cleanupStaleSessionLock\(\)/)
  assert.match(appSource, /fs\.lstatSync\(lockPath\)/)
  assert.match(appSource, /terminating orphaned session Chrome/)
  assert.match(appSource, /await client\.destroy\(\)/)
  assert.match(appSource, /process\.once\('SIGINT'/)
  assert.match(appSource, /process\.once\('SIGTERM'/)
  assert.match(appSource, /await cleanupStaleSessionLock\(\)/)
})

test('connector registers each WhatsApp event once and only downloads callable message media', () => {
  assert.match(appSource, /new Set\(Object\.values\(Events\)\)/)
  assert.match(appSource, /typeof data\.downloadMedia === 'function'/)
})

test('connector promotes an authenticated socket to connected when READY is not emitted', () => {
  assert.match(appSource, /async function waitForConnectedState\(\)/)
  assert.match(appSource, /await client\.getState\(\) === 'CONNECTED'/)
  assert.match(appSource, /markConnected\('socket state'\)/)
})

test('media files retain extracted and semantic text with resumable analysis state', () => {
  assert.match(schemaSource, /ALTER TABLE media_files ADD COLUMN IF NOT EXISTS extracted_text TEXT/)
  assert.match(schemaSource, /ALTER TABLE media_files ADD COLUMN IF NOT EXISTS semantic_text TEXT/)
  assert.match(schemaSource, /analysis_status TEXT NOT NULL DEFAULT 'pending'/)
  assert.match(mediaAnalyzerSource, /async function extractPdfText\(buffer\)/)
  assert.match(mediaAnalyzerSource, /Describe this WhatsApp image for semantic retrieval/)
  assert.match(mediaAnalyzerSource, /analysis_attempts < 3/)
  assert.match(mediaAnalyzerSource, /startMediaAnalysisWorker/)
  assert.match(mediaAnalyzerSource, /Gemini quota unavailable; trying configured AI fallback/)
  assert.match(mediaAnalyzerSource, /async function generateWithVisionFallback/)
  assert.doesNotMatch(mediaAnalyzerSource, /require\('\.\.\/\.\.\/\.\.\/shared\/ai-client'\)/)
  assert.match(mediaAnalyzerSource, /paused because all configured providers are quota-limited/)
})

test('media downloads are bounded and derived text enters semantic search separately', () => {
  assert.match(mediaDownloaderSource, /analysis_status\)\s*\n\s*VALUES \(\$1, \$2, \$3, \$4, \$5, 'pending'\)/)
  assert.match(syncSource, /await downloadAndStore\(msg\)/)
  assert.match(indexerSource, /async function indexWhatsAppMedia\(embeddingModel\)/)
  assert.match(indexerSource, /indexSource\('whatsapp_media'/)
  assert.match(mediaDownloaderSource, /async function recoverMissingMedia\(client/)
  assert.match(mediaDownloaderSource, /await client\.getMessageById\(row\.wa_msg_id\)/)
  assert.match(appSource, /app\.post\('\/api\/media\/recovery\/run'/)
})
