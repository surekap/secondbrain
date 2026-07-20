const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  _messageId,
  _messageTimestamp,
  _normalizeOptions,
  _saveMessage,
  _syncChat,
} = require('../lib/sync')

const syncSource = fs.readFileSync(path.join(__dirname, '../lib/sync.js'), 'utf8')
const syncRepoSource = fs.readFileSync(path.join(__dirname, '../lib/historicalSyncRepo.js'), 'utf8')
const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8')
const schemaSource = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
const mediaAnalyzerSource = fs.readFileSync(path.join(__dirname, '../lib/mediaAnalyzer.js'), 'utf8')
const mediaDownloaderSource = fs.readFileSync(path.join(__dirname, '../lib/mediaDownloader.js'), 'utf8')
const postgresStoreSource = fs.readFileSync(path.join(__dirname, '../lib/PostgresStore.js'), 'utf8')
const indexerSource = fs.readFileSync(path.join(__dirname, '../../../../ui/services/indexer.js'), 'utf8')

test('fixed overlap windows and page settings normalize deterministically', () => {
  const normalized = _normalizeOptions({
    windowEnd: '2026-07-20T12:00:00.000Z',
    overlapMinutes: 90,
    pageSize: 5000,
    msgLimit: 10,
    downloadMedia: false,
  })
  assert.equal(normalized.windowEnd.toISOString(), '2026-07-20T12:00:00.000Z')
  assert.equal(normalized.windowStart.toISOString(), '2026-07-20T10:30:00.000Z')
  assert.equal(normalized.pageSize, 1000)
  assert.equal(normalized.msgLimit, 100)
  assert.equal(normalized.downloadMedia, false)
})

test('historical message cursor helpers accept wrapped and raw WhatsApp shapes', () => {
  assert.equal(_messageId({ id: { _serialized: 'wa-1' } }), 'wa-1')
  assert.equal(_messageId({ id: { $1: 'wa-2' } }), 'wa-2')
  assert.equal(_messageTimestamp({ timestamp: 1_700_000_000 }).toISOString(), '2023-11-14T22:13:20.000Z')
  assert.equal(_messageTimestamp({ timestamp: 'invalid' }), null)
})

test('message persistence reports saved, duplicate, and database failure separately', async () => {
  const message = {
    id: { _serialized: 'false_120363000000000000@g.us_A', remote: '120363000000000000@g.us' },
    from: '120363000000000000@g.us',
    type: 'chat',
    timestamp: 1_700_000_000,
  }
  assert.equal(await _saveMessage(message, 'test-client', { query: async () => ({ rowCount: 1 }) }), 'saved')
  assert.equal(await _saveMessage(message, 'test-client', { query: async () => ({ rowCount: 0 }) }), 'duplicate')
  await assert.rejects(
    _saveMessage(message, 'test-client', { query: async () => { throw Object.assign(new Error('DB unavailable'), { code: '08006' }) } }),
    error => error.code === 'SYNC_DB_WRITE_FAILED' && error.dbCode === '08006',
  )
})

test('an empty group window still records page coverage and advances its group watermark', async () => {
  const calls = []
  const run = {
    id: 7,
    trigger: 'reconnect',
    status: 'running',
    started_at: '2026-07-20T10:00:00.000Z',
    window_start: '2026-07-20T10:00:00.000Z',
    window_end: '2026-07-20T12:00:00.000Z',
    lookback_days: 1,
    msg_limit: 100,
    page_size: 25,
    total_chats: 1,
    completed_chats: 0,
    saved_count: 0,
    duplicate_count: 0,
    failed_count: 0,
    chat_offset: 0,
    chat_batch_size: null,
  }
  const lease = {
    run,
    completedPages: async () => new Map(),
    markPageRunning: async input => calls.push(['page-running', input]),
    completePage: async (chatId, pageNumber, counts) => calls.push(['page-complete', { chatId, pageNumber, counts }]),
    completeChat: async input => {
      calls.push(['chat-complete', input])
      lease.run = { ...run, completed_chats: 1 }
    },
  }
  const chat = {
    id: { _serialized: '120363000000000000@g.us' },
    isGroup: true,
    fetchMessages: async () => [],
  }
  const result = await _syncChat(chat, run, 'test-client', {
    msgLimit: 100,
    pageSize: 25,
    downloadMedia: false,
    lease,
  })
  assert.deepEqual(result, { saved: 0, duplicates: 0, interrupted: false })
  assert.equal(calls[0][1].pageNumber, 0)
  assert.deepEqual(calls[1][1].counts, { fetched: 0, saved: 0, duplicates: 0 })
  assert.equal(calls[2][1].isGroup, true)
  assert.equal(calls[2][1].highWatermarkTs, null)
})

test('resume replays a shifted page instead of trusting its old page number', async () => {
  const calls = []
  const run = {
    id: 8,
    trigger: 'reconnect',
    status: 'running',
    started_at: '2026-07-20T10:00:00.000Z',
    window_start: '2026-07-20T10:00:00.000Z',
    window_end: '2026-07-20T12:00:00.000Z',
    lookback_days: 1,
    msg_limit: 100,
    page_size: 25,
    total_chats: 1,
    completed_chats: 0,
    saved_count: 0,
    duplicate_count: 0,
    failed_count: 0,
    chat_offset: 0,
    chat_batch_size: null,
  }
  const lease = {
    run,
    completedPages: async () => new Map([[0, { cursorWaMsgId: 'old-cursor', fetchedCount: 2 }]]),
    markPageRunning: async input => calls.push(input),
    completePage: async () => {},
    completeChat: async () => {},
  }
  const messages = [
    { id: { _serialized: 'new-1', remote: '123@c.us' }, from: '123@c.us', timestamp: Date.parse('2026-07-20T10:30:00Z') / 1000 },
    { id: { _serialized: 'new-2', remote: '123@c.us' }, from: '123@c.us', timestamp: Date.parse('2026-07-20T10:31:00Z') / 1000 },
  ]
  const result = await _syncChat({
    id: { _serialized: '123@c.us' },
    fetchMessages: async () => messages,
  }, run, 'test-client', {
    msgLimit: 100,
    pageSize: 25,
    downloadMedia: false,
    lease,
    messageStore: { query: async () => ({ rowCount: 0 }) },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cursorWaMsgId, 'new-2')
  assert.equal(result.duplicates, 2)
})

test('historical sync is configurable for one-shot 90 day backfills', () => {
  assert.match(syncSource, /async function startHistoricalSync\(client, clientId, runId = null, options = \{\}\)/)
  assert.match(syncSource, /_boundedNumber\(options\.days, DEFAULT_LOOKBACK_DAYS/)
  assert.match(syncSource, /_boundedNumber\(options\.msgLimit, DEFAULT_MSG_LIMIT/)
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

test('connect and reconnect run a bounded overlap while preserving optional full startup sync', () => {
  assert.match(appSource, /WHATSAPP_AUTO_SYNC_ON_READY === '1'/)
  assert.match(appSource, /resumeHistoricalSyncOnReconnect/)
  assert.match(appSource, /WHATSAPP_RECONNECT_OVERLAP_MINUTES \|\| 120/)
  assert.match(syncSource, /overlapMinutes: options\.overlapMinutes \?\? DEFAULT_OVERLAP_MINUTES/)
})

test('historical sync reports getChats failures instead of silent zero-row success', () => {
  assert.match(syncSource, /bulk getChats failed; loading chats individually/)
  assert.match(syncSource, /_loadChatsIndividually\(client\)/)
  assert.match(syncSource, /could not load chats after bulk and individual attempts, aborting/)
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
  assert.match(syncSource, /coverageIncomplete = true/)
})

test('manual historical sync supports resumable chat batches', () => {
  assert.match(syncSource, /chatOffset: _boundedNumber\(options\.chatOffset/)
  assert.match(syncSource, /chatBatchSize: options\.chatBatchSize/)
  assert.match(syncSource, /syncable\.slice\(chatOffset, batchEnd\)/)
  assert.match(syncSource, /totalAvailableChats/)
  assert.match(appSource, /req\.body\?\.chatOffset/)
  assert.match(appSource, /req\.body\?\.chatBatchSize/)
})

test('historical sync exposes status and rejects concurrent runs', () => {
  assert.match(syncSource, /const syncState = \{/)
  assert.match(syncRepoSource, /historical sync already running/)
  assert.match(syncRepoSource, /pg_try_advisory_lock\(hashtext\(\$1\)\)/)
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

test('historical sync persists fixed-window chat/page checkpoints and group watermarks', () => {
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS whatsapp_sync_runs/)
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS whatsapp_sync_checkpoints/)
  assert.match(schemaSource, /checkpoint_kind\s+TEXT NOT NULL CHECK \(checkpoint_kind IN \('chat','page'\)\)/)
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS whatsapp_sync_watermarks/)
  assert.match(schemaSource, /is_group\s+BOOLEAN NOT NULL DEFAULT FALSE/)
  assert.match(syncRepoSource, /page_number, window_start, window_end/)
  assert.match(syncRepoSource, /last_completed_window_start/)
  assert.match(syncRepoSource, /last_completed_window_end/)
  assert.match(syncSource, /completedPages\(chatId\)/)
  assert.match(syncSource, /pageSize/)
})

test('DB failures are fatal and are never counted as duplicates', () => {
  assert.match(syncSource, /return res\.rowCount > 0 \? 'saved' : 'duplicate'/)
  assert.match(syncSource, /databaseError\.code = 'SYNC_DB_WRITE_FAILED'/)
  assert.match(syncSource, /throw databaseError/)
  assert.doesNotMatch(syncSource, /DB error:[\s\S]{0,120}return 'skipped'/)
  assert.match(schemaSource, /duplicate_count\s+INTEGER NOT NULL DEFAULT 0/)
  assert.match(schemaSource, /failed_count\s+INTEGER NOT NULL DEFAULT 0/)
})

test('an interrupted run resumes the same fixed window and completed pages', () => {
  assert.match(syncRepoSource, /status IN \('running','failed','interrupted'\)/)
  assert.match(syncRepoSource, /attempt = attempt \+ 1/)
  assert.match(syncRepoSource, /WHERE run_id = \$1 AND chat_id = \$2[\s\S]*status = 'completed'/)
  assert.match(syncSource, /const prior = completedPages\.get\(pageNumber\)/)
  assert.match(syncSource, /prior\.cursorWaMsgId === currentCursor/)
  assert.match(syncSource, /SYNC_SOURCE_WINDOW_INCOMPLETE/)
  assert.match(syncSource, /timestamp <= windowEnd/)
})

test('live, historical, webhook, and media paths share canonical conversation identity', () => {
  for (const source of [postgresStoreSource, syncSource, appSource, mediaDownloaderSource]) {
    assert.match(source, /canonicalWhatsAppChatId/)
  }
  assert.match(postgresStoreSource, /isGroupWhatsAppChatId/)
  assert.doesNotMatch(postgresStoreSource, /data\?\.from \?\? data\?\.id\?\._serialized/)
  assert.doesNotMatch(syncSource, /msg\.id\?\.remote \?\? msg\.from \?\? msg\.to/)
})

test('manual historical sync can disable media downloads to avoid a storm', () => {
  assert.match(syncSource, /downloadMedia: options\.downloadMedia !== false/)
  assert.match(appSource, /const downloadMedia = Boolean\(req\.body\?\.downloadMedia\)/)
  assert.match(appSource, /downloadMedia,\n\s+chatOffset,\n\s+chatBatchSize,/)
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
  assert.match(appSource, /requestHistoricalSyncStop\(`shutdown:/)
  assert.match(appSource, /await waitForHistoricalSync\(\)/)
  assert.match(appSource, /process\.once\('SIGINT'/)
  assert.match(appSource, /process\.once\('SIGTERM'/)
  assert.match(appSource, /await cleanupStaleSessionLock\(\)/)
  assert.match(appSource, /await stopMediaAnalysisWorker\(\)/)
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
  assert.match(schemaSource, /analysis_lease_owner TEXT/)
  assert.match(schemaSource, /analysis_lease_expires_at TIMESTAMPTZ/)
  assert.match(mediaAnalyzerSource, /async function extractPdfText\(buffer\)/)
  assert.match(mediaAnalyzerSource, /Describe this WhatsApp image for semantic retrieval/)
  assert.match(mediaAnalyzerSource, /analysis_attempts < \$4/)
  assert.match(mediaAnalyzerSource, /FOR UPDATE SKIP LOCKED/)
  assert.match(mediaAnalyzerSource, /async function extractPdfDocument/)
  assert.match(mediaAnalyzerSource, /getScreenshot/)
  assert.match(mediaAnalyzerSource, /media_pdf_ocr/)
  assert.match(mediaAnalyzerSource, /async function summarizePdfText/)
  assert.match(mediaAnalyzerSource, /media_pdf_chunk_summary/)
  assert.match(mediaAnalyzerSource, /media_pdf_summary_reduce/)
  assert.match(mediaAnalyzerSource, /startMediaAnalysisWorker/)
  assert.match(mediaAnalyzerSource, /analysis_status = 'skipped'/)
  assert.match(mediaAnalyzerSource, /async function generateWithVisionFallback/)
  assert.match(mediaAnalyzerSource, /llmClient\.create\('whatsapp'/)
  assert.match(mediaAnalyzerSource, /required_capability: imageInputs\.length \? 'vision' : null/)
  assert.doesNotMatch(mediaAnalyzerSource, /require\('\.\.\/\.\.\/\.\.\/shared\/ai-client'\)/)
  assert.match(mediaAnalyzerSource, /paused because all configured providers are quota-limited/)
})

test('media downloads are bounded and derived text enters semantic search separately', () => {
  assert.match(mediaDownloaderSource, /content_sha256, analysis_status\)\s*\n\s*VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, 'pending'\)/)
  assert.match(syncSource, /await downloadAndStore\(msg\)/)
  assert.match(indexerSource, /async function indexWhatsAppMedia\(embeddingModel\)/)
  assert.match(indexerSource, /indexSource\('whatsapp_media'/)
  assert.match(mediaDownloaderSource, /async function recoverMissingMedia\(client/)
  assert.match(mediaDownloaderSource, /await client\.getMessageById\(row\.wa_msg_id\)/)
  assert.match(appSource, /app\.post\('\/api\/media\/recovery\/run'/)
})
