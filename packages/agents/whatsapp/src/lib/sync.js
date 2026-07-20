'use strict';

const pool = require('./db');
const {
  canonicalWhatsAppChatId,
  isGroupWhatsAppChatId,
} = require('../../../shared/whatsapp-chat');

let telemetry = null;
try { telemetry = require('@secondbrain/telemetry'); } catch (_) {}
const {
    claimDurableSyncRun,
    latestDurableSyncRun,
    runningError,
} = require('./historicalSyncRepo');

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_MSG_LIMIT     = 2000;  // per chat — fetchMessages auto-loads earlier pages
const DEFAULT_CHAT_DELAY_MS = 300;   // brief pause between chats to avoid rate-limiting
const DEFAULT_PAGE_SIZE     = 250;
const DEFAULT_OVERLAP_MINUTES = 120;

let activeSyncPromise = null;
let startReserved = false;
let stopReason = null;

const syncState = {
    running: false,
    runId: null,
    trigger: null,
    status: null,
    startedAt: null,
    finishedAt: null,
    days: null,
    msgLimit: null,
    pageSize: null,
    windowStart: null,
    windowEnd: null,
    totalChats: 0,
    completedChats: 0,
    totalSaved: 0,
    totalDuplicates: 0,
    totalFailed: 0,
    totalSkipped: 0,
    chatOffset: 0,
    chatBatchSize: null,
    totalAvailableChats: 0,
    errors: [],
};

function _publicState(durableRun = null) {
    return { ...syncState, errors: syncState.errors.slice(-20), durableRun };
}

async function getHistoricalSyncStatus(clientId = process.env.CLIENT_ID) {
    return _publicState(await latestDurableSyncRun(pool, clientId));
}

function _boundedNumber(value, fallback, min, max) {
    const parsed = Number(value ?? fallback);
    return Math.max(min, Math.min(Number.isFinite(parsed) ? parsed : fallback, max));
}

function _normalizeOptions(options = {}) {
    const windowEnd = options.windowEnd ? new Date(options.windowEnd) : new Date();
    if (Number.isNaN(windowEnd.getTime())) throw new Error('invalid historical sync windowEnd');
    const overlapMinutes = _boundedNumber(options.overlapMinutes, 0, 0, 7 * 24 * 60);
    const lookbackDays = _boundedNumber(options.days, DEFAULT_LOOKBACK_DAYS, 1, 365);
    const explicitStart = options.windowStart ? new Date(options.windowStart) : null;
    if (explicitStart && Number.isNaN(explicitStart.getTime())) throw new Error('invalid historical sync windowStart');
    const windowStart = explicitStart || new Date(windowEnd.getTime() - (
        overlapMinutes > 0 ? overlapMinutes * 60 * 1000 : lookbackDays * 24 * 60 * 60 * 1000
    ));
    if (windowStart > windowEnd) throw new Error('historical sync windowStart must not be after windowEnd');
    return {
        trigger: String(options.trigger || 'manual').slice(0, 40),
        resume: options.resume !== false,
        lookbackDays,
        overlapMinutes,
        windowStart,
        windowEnd,
        msgLimit: _boundedNumber(options.msgLimit, DEFAULT_MSG_LIMIT, 100, 50000),
        pageSize: _boundedNumber(options.pageSize, DEFAULT_PAGE_SIZE, 25, 1000),
        chatDelayMs: _boundedNumber(options.chatDelayMs, DEFAULT_CHAT_DELAY_MS, 0, 10000),
        chatOffset: _boundedNumber(options.chatOffset, 0, 0, Number.MAX_SAFE_INTEGER),
        chatBatchSize: options.chatBatchSize
            ? _boundedNumber(options.chatBatchSize, 1, 1, 5000)
            : null,
        downloadMedia: options.downloadMedia !== false,
    };
}

function _setStateFromRun(run) {
    syncState.runId = Number(run.id);
    syncState.trigger = run.trigger;
    syncState.status = run.status;
    syncState.startedAt = new Date(run.started_at).toISOString();
    syncState.finishedAt = null;
    syncState.days = Number(run.lookback_days);
    syncState.msgLimit = Number(run.msg_limit);
    syncState.pageSize = Number(run.page_size);
    syncState.windowStart = new Date(run.window_start).toISOString();
    syncState.windowEnd = new Date(run.window_end).toISOString();
    syncState.totalChats = Number(run.total_chats || 0);
    syncState.completedChats = Number(run.completed_chats || 0);
    syncState.totalSaved = Number(run.saved_count || 0);
    syncState.totalDuplicates = Number(run.duplicate_count || 0);
    syncState.totalFailed = Number(run.failed_count || 0);
    syncState.totalSkipped = syncState.totalDuplicates;
    syncState.chatOffset = Number(run.chat_offset || 0);
    syncState.chatBatchSize = run.chat_batch_size == null ? null : Number(run.chat_batch_size);
}

function _recordError(chat, kind, error) {
    syncState.errors.push({
        chat,
        kind,
        error: String(error?.message || error),
        ts: new Date().toISOString(),
    });
}

function _isDatabaseError(error) {
    return error?.code === 'SYNC_DB_WRITE_FAILED'
        || Boolean(error?.severity)
        || /^[0-9A-Z]{5}$/.test(String(error?.code || ''));
}

/**
 * Claim a DB-backed run and start it in the background. The returned status is
 * only an acknowledgement; await waitForHistoricalSync during shutdown/tests.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} clientId
 */
async function startHistoricalSync(client, clientId, runId = null, options = {}) {
    if (startReserved || syncState.running || activeSyncPromise) throw runningError();
    startReserved = true;
    syncState.running = true;
    syncState.status = 'starting';
    syncState.errors = [];
    stopReason = null;
    try {
        const normalized = _normalizeOptions(options);
        const lease = await claimDurableSyncRun(pool, clientId, normalized);
        _setStateFromRun(lease.run);
        activeSyncPromise = _runManagedSync(lease, client, clientId, runId, normalized);
        activeSyncPromise.catch(() => {});
        return _publicState(lease.run);
    } catch (error) {
        syncState.running = false;
        syncState.status = 'failed';
        syncState.finishedAt = new Date().toISOString();
        throw error;
    } finally {
        startReserved = false;
    }
}

function requestHistoricalSyncStop(reason = 'stop requested') {
    if (!activeSyncPromise) return false;
    stopReason = String(reason).slice(0, 500);
    return true;
}

async function waitForHistoricalSync() {
    if (activeSyncPromise) await activeSyncPromise;
}

async function resumeHistoricalSyncOnReconnect(client, clientId, runId = null, options = {}) {
    await waitForHistoricalSync();
    return startHistoricalSync(client, clientId, runId, {
        ...options,
        trigger: 'reconnect',
        resume: true,
        overlapMinutes: options.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES,
        downloadMedia: options.downloadMedia === true,
    });
}

async function _runManagedSync(lease, client, clientId, telemetryRunId, options) {
    let finalStatus = 'completed';
    let finalError = null;
    try {
        await _runSync(client, clientId, telemetryRunId, lease, options);
        if (stopReason) finalStatus = 'interrupted';
    } catch (error) {
        finalStatus = stopReason ? 'interrupted' : 'failed';
        finalError = error;
        const kind = _isDatabaseError(error) ? 'database' : 'sync';
        _recordError(null, kind, error);
        console.error('[sync] fatal error:', error.message);
    } finally {
        try {
            const run = await lease.finish(finalStatus, finalError?.message || stopReason);
            _setStateFromRun(run);
        } catch (error) {
            finalStatus = 'failed';
            _recordError(null, 'database', new Error(`could not finalize durable sync run: ${error.message}`));
        }
        await lease.release().catch(error => console.error('[sync] could not release DB lock:', error.message));
        syncState.running = false;
        syncState.status = finalStatus;
        syncState.finishedAt = new Date().toISOString();
        activeSyncPromise = null;
        stopReason = null;
    }
}

async function _runSync(client, clientId, runId, lease, options) {
    const durableRun = lease.run;
    const cutoff = new Date(durableRun.window_start);
    const windowEnd = new Date(durableRun.window_end);
    const msgLimit = Number(durableRun.msg_limit);
    const pageSize = Number(durableRun.page_size);
    const chatDelayMs = options.chatDelayMs;
    const downloadMedia = durableRun.download_media === true;
    const chatOffset = Number(durableRun.chat_offset || 0);
    const chatBatchSize = durableRun.chat_batch_size == null ? null : Number(durableRun.chat_batch_size);

    console.log(`[sync] starting durable run ${durableRun.id} — ${cutoff.toISOString()} to ${windowEnd.toISOString()}, limit ${msgLimit}/chat, pageSize=${pageSize}, media=${downloadMedia}`);

    let chats;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            chats = await client.getChats();
            break;
        } catch (err) {
            console.error(`[sync] getChats attempt ${attempt}/3 failed: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 15000 * attempt));
        }
    }
    if (!chats) {
        console.warn('[sync] bulk getChats failed; loading chats individually');
        chats = await _loadChatsIndividually(client);
        if (!chats.length) {
            const message = 'could not load chats after bulk and individual attempts, aborting';
            console.error(`[sync] ${message}`);
            syncState.errors.push({ chat: null, error: message, ts: new Date().toISOString() });
            throw new Error(message);
        }
    }

    // Filter out chat types that don't support fetchMessages:
    // broadcast lists, the status feed, and WhatsApp Channels (newsletters)
    const syncable = chats.filter(c => {
        const id = c.id._serialized;
        if (c.isBroadcast)          return false;  // broadcast lists
        if (id === 'status@broadcast') return false; // status feed
        if (id.endsWith('@newsletter')) return false; // WA Channels
        return true;
    }).sort((left, right) => String(left.id._serialized).localeCompare(String(right.id._serialized)));
    const skippedTypes = chats.length - syncable.length;
    const manifests = await lease.manifests();
    let batch;
    if (manifests.length) {
        const chatById = new Map(syncable.map(chat => [chat.id._serialized, chat]));
        batch = manifests.map(manifest => ({
            chat: chatById.get(manifest.chat_id) || null,
            chatId: manifest.chat_id,
            isGroup: manifest.is_group,
            status: manifest.status,
        }));
    } else {
        const batchEnd = chatBatchSize ? Math.min(syncable.length, chatOffset + chatBatchSize) : syncable.length;
        batch = syncable.slice(chatOffset, batchEnd).map(chat => ({
            chat,
            chatId: chat.id._serialized,
            isGroup: Boolean(chat.isGroup || isGroupWhatsAppChatId(chat.id._serialized)),
            status: 'pending',
        }));
        await lease.seedManifests(batch);
        _setStateFromRun(lease.run);
    }

    console.log(`[sync] ${chats.length} chats found (${syncable.length} syncable, ${skippedTypes} skipped — broadcast/status/channels); processing ${batch.length} durable chat checkpoints`);
    syncState.totalAvailableChats = syncable.length;
    syncState.totalChats = batch.length;
    syncState.chatOffset = chatOffset;
    syncState.chatBatchSize = chatBatchSize;
    if (telemetry && runId) {
        try { await telemetry.progress(runId, 'chats_scanned', { completed: batch.length, total: batch.length }); }
        catch (error) { console.warn('[sync] telemetry progress failed:', error.message); }
    }

    // Persist chat names for group name resolution. This is sync state, so a DB
    // failure must fail the run instead of being counted as a duplicate.
    for (const item of batch) {
        const chat = item.chat;
        if (!chat) continue;
        const name = chat.name || null;
        const chatId = chat.id._serialized;
        const isGroup = chat.isGroup || false;
        if (name) {
            await lease.query(
                `INSERT INTO chat_metadata (chat_id, name, is_group, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (chat_id) DO UPDATE SET name = EXCLUDED.name, is_group = EXCLUDED.is_group, updated_at = NOW()`,
                [chatId, name, isGroup]
            );
        }
    }

    const chatErrors = [];
    for (const item of batch) {
        if (stopReason) break;
        if (item.status === 'completed') continue;
        const chat = item.chat;
        const name = chat?.name || item.chatId;
        try {
            if (!chat) throw new Error(`chat ${item.chatId} is not available in the connected WhatsApp session`);
            await lease.markChatRunning(item.chatId);
            const result = await _syncChat(chat, durableRun, clientId, {
                msgLimit,
                pageSize,
                downloadMedia,
                lease,
            });
            if (result.interrupted) break;
            if (result.saved > 0 || result.duplicates > 0) {
                console.log(`[sync]   ${name}: +${result.saved} saved, ${result.duplicates} duplicates`);
            }
            if (telemetry && runId) {
                try { await telemetry.progress(runId, 'messages_synced', { completed: syncState.totalSaved }); }
                catch (error) { console.warn('[sync] telemetry progress failed:', error.message); }
            }
        } catch (error) {
            try {
                await lease.markChatFailed(item.chatId, error);
                _setStateFromRun(lease.run);
            } catch (checkpointError) {
                throw checkpointError;
            }
            const kind = _isDatabaseError(error) ? 'database' : 'chat';
            _recordError(name, kind, error);
            chatErrors.push({ chat: name, error: error.message });
            console.error(`[sync]   ${name}: error — ${error.message}`);
            if (kind === 'database') throw error;
        }
        // Small delay to avoid hammering WhatsApp
        await new Promise(r => setTimeout(r, chatDelayMs));
    }

    if (stopReason) {
        console.log(`[sync] interrupted at checkpoint boundary: ${stopReason}`);
        return;
    }
    if (chatErrors.length) {
        const error = new Error(`${chatErrors.length} chat checkpoint(s) failed; run remains resumable`);
        error.code = 'SYNC_CHAT_FAILURE';
        throw error;
    }
    console.log(`[sync] done — ${syncState.totalSaved} saved, ${syncState.totalDuplicates} duplicates`);
}

async function _loadChatsIndividually(client) {
    const entries = await client.pupPage.evaluate(() => {
        const models = window.require('WAWebCollections').Chat.getModelsArray();
        return models.map(chat => {
            const id = chat.id?._serialized || String(chat.id || '');
            return {
                id,
                name: chat.formattedTitle || chat.name || null,
                isGroup: id.endsWith('@g.us'),
                isBroadcast: Boolean(chat.isBroadcast || id.endsWith('@broadcast')),
            };
        }).filter(chat => chat.id);
    });

    const chats = [];
    let rawFallbacks = 0;
    for (const entry of entries) {
        try {
            const chat = await client.getChatById(entry.id);
            if (chat) chats.push(chat);
        } catch (_) {
            rawFallbacks++;
            chats.push({
                id: { _serialized: entry.id },
                name: entry.name,
                isGroup: entry.isGroup,
                isBroadcast: entry.isBroadcast,
                client,
                fetchMessages: ({ limit }) => _fetchRawChatMessages(client, entry.id, limit),
            });
        }
    }
    console.log(`[sync] individual chat load recovered ${chats.length}/${entries.length} chats (${rawFallbacks} using raw fallback)`);
    return chats;
}

async function _fetchRawChatMessages(client, chatId, msgLimit) {
    return client.pupPage.evaluate(async (id, limit) => {
        const chatCollection = window.require('WAWebCollections').Chat;
        const chat = chatCollection.get(id) || await chatCollection.find(id);
        if (!chat) return [];
        const msgFilter = message => !message.isNotification;
        let messages = chat.msgs?.getModelsArray ? chat.msgs.getModelsArray().filter(msgFilter) : [];
        let coverageIncomplete = false;
        while (limit > 0 && messages.length < limit) {
            try {
                const earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
                if (!earlier?.length) break;
                messages = [...earlier.filter(msgFilter), ...messages];
            } catch (_) {
                coverageIncomplete = true;
                break;
            }
        }
        messages.sort((a, b) => (a.t > b.t ? 1 : -1));
        if (limit > 0 && messages.length > limit) messages = messages.slice(messages.length - limit);
        return { coverageIncomplete, messages: messages.map(message => {
            const data = window.WWebJS.getMessageModel(message);
            // Current WhatsApp Web exposes the Unix timestamp as `t`; the
            // whatsapp-web.js Message wrapper normally renames it to timestamp.
            // Raw fallbacks must do that normalization themselves.
            if (data.timestamp == null) data.timestamp = data.t ?? message.t;
            if (data.id && data.id._serialized == null) {
                data.id._serialized = data.id.$1 ?? message.id?._serialized ?? message.id?.$1;
            }
            return data;
        }) };
    }, chatId, msgLimit);
}

async function _fetchChatMessages(chat, msgLimit) {
    try {
        // fetchMessages with a high limit normally calls loadEarlierMsgs internally.
        const result = await chat.fetchMessages({ limit: msgLimit });
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.messages)) {
            if (result.coverageIncomplete) result.messages.coverageIncomplete = true;
            return result.messages;
        }
        return [];
    } catch (err) {
        if (!String(err.message || '').includes('waitForChatLoading')) throw err;
        // WhatsApp Web occasionally changes ConversationMsgs internals before
        // whatsapp-web.js catches up. Fall back to the currently-loaded message
        // models instead of failing the whole chat. This may be shallower than a
        // true scrollback fetch, but it preserves all locally available rows and
        // keeps the deduped backfill useful while the upstream path is broken.
        console.warn(`[sync]   ${chat.name || chat.id?._serialized}: fetchMessages failed (${err.message}); using loaded-message fallback`);
        const raw = await chat.client.pupPage.evaluate((chatId, limit) => {
            const msgFilter = (m) => !m.isNotification;
            const getChat = async () => {
                try { return await window.WWebJS.getChat(chatId, { getAsModel: false }); } catch (_) {}
                try { return window.Store.Chat.get(chatId) || await window.Store.Chat.find(chatId); } catch (_) {}
                return null;
            };
            return getChat().then(chatModel => {
                const models = chatModel?.msgs?.getModelsArray ? chatModel.msgs.getModelsArray() : [];
                let msgs = models.filter(msgFilter).sort((a, b) => (a.t > b.t ? 1 : -1));
                if (limit > 0 && msgs.length > limit) msgs = msgs.slice(msgs.length - limit);
                return msgs.map(m => window.WWebJS.getMessageModel(m));
            });
        }, chat.id._serialized, msgLimit);
        const messages = raw || [];
        messages.coverageIncomplete = true;
        return messages;
    }
}

function _messageTimestamp(message) {
    const seconds = Number(message.timestamp ?? message.t);
    return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function _messageId(message) {
    return message.id?._serialized ?? message.id?.$1 ?? null;
}

async function _syncChat(chat, durableRun, clientId, {
    msgLimit,
    pageSize,
    downloadMedia,
    lease,
    messageStore = pool,
}) {
    const messages = await _fetchChatMessages(chat, msgLimit);
    const cutoff = new Date(durableRun.window_start);
    const windowEnd = new Date(durableRun.window_end);
    const chatId = chat.id._serialized;
    const isGroup = Boolean(chat.isGroup || isGroupWhatsAppChatId(chatId));

    // A run's fixed upper bound makes page numbers stable when a reconnect adds
    // newer messages. Message ID breaks timestamp ties deterministically.
    const inWindow = messages.filter(m => {
        const timestamp = _messageTimestamp(m);
        return timestamp && timestamp >= cutoff && timestamp <= windowEnd;
    }).sort((left, right) => {
        const timeDifference = _messageTimestamp(left) - _messageTimestamp(right);
        return timeDifference || String(_messageId(left) || '').localeCompare(String(_messageId(right) || ''));
    });

    const pages = [];
    if (!inWindow.length) pages.push([]);
    for (let offset = 0; offset < inWindow.length; offset += pageSize) {
        pages.push(inWindow.slice(offset, offset + pageSize));
    }
    const completedPages = await lease.completedPages(chatId);
    const oldestFetchedTimestamp = messages
        .map(_messageTimestamp)
        .filter(Boolean)
        .sort((left, right) => left - right)[0] || null;
    const sourceWindowIncomplete = messages.coverageIncomplete === true
        || (messages.length >= msgLimit && (!oldestFetchedTimestamp || oldestFetchedTimestamp > cutoff));

    let saved = 0;
    let duplicates = 0;

    for (let pageNumber = 0; pageNumber < pages.length; pageNumber++) {
        const prior = completedPages.get(pageNumber);
        const currentCursor = _messageId(pages[pageNumber][pages[pageNumber].length - 1] || {});
        if (prior
            && prior.cursorWaMsgId === currentCursor
            && prior.fetchedCount === pages[pageNumber].length) continue;
        if (stopReason) return { saved, duplicates, interrupted: true };
        const page = pages[pageNumber];
        const first = page[0] || null;
        const last = page[page.length - 1] || null;
        await lease.markPageRunning({
            chatId,
            isGroup,
            pageNumber,
            pageStart: first ? _messageTimestamp(first) : null,
            pageEnd: last ? _messageTimestamp(last) : null,
            cursorWaMsgId: last ? _messageId(last) : null,
            fetchedCount: page.length,
        });

        let pageSaved = 0;
        let pageDuplicates = 0;
        try {
            for (const msg of page) {
                const result = await _saveMessage(msg, clientId, messageStore);
                if (result === 'saved') pageSaved++;
                if (result === 'duplicate') pageDuplicates++;
            }
        } catch (error) {
            await lease.markPageFailed(chatId, pageNumber, page.length, error);
            throw error;
        }

        if (downloadMedia) {
            // Raw message persistence is the checkpoint boundary. Media has its
            // own durable recovery state, so a media miss never rolls back raw.
            const { downloadAndStore } = require('./mediaDownloader');
            for (const msg of page) {
                if (msg.hasMedia) await downloadAndStore(msg);
            }
        }

        await lease.completePage(chatId, pageNumber, {
            fetched: page.length,
            saved: pageSaved,
            duplicates: pageDuplicates,
        });
        _setStateFromRun(lease.run);
        saved += pageSaved;
        duplicates += pageDuplicates;
    }

    if (sourceWindowIncomplete) {
        const error = new Error(`chat ${chatId} did not reach the fixed window start; increase msgLimit or retry after WhatsApp history loading recovers`);
        error.code = 'SYNC_SOURCE_WINDOW_INCOMPLETE';
        throw error;
    }

    const highWatermark = inWindow[inWindow.length - 1] || null;
    await lease.completeChat({
        chatId,
        isGroup,
        highWatermarkTs: highWatermark ? _messageTimestamp(highWatermark) : null,
        highWatermarkWaMsgId: highWatermark ? _messageId(highWatermark) : null,
    });
    _setStateFromRun(lease.run);
    return { saved, duplicates, interrupted: false };
}

async function _saveMessage(msg, clientId, queryable = pool) {
    const waId = msg.id?._serialized ?? msg.id?.$1 ?? null;

    const chatId = canonicalWhatsAppChatId(msg, {
        selfJid: process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID,
    });
    const groupId = isGroupWhatsAppChatId(chatId) ? chatId : null;

    let jsonData;
    try {
        jsonData = JSON.stringify(msg._data ?? msg ?? null);
    } catch (_) {
        jsonData = JSON.stringify({ _error: 'could not serialize' });
    }

    try {
        const res = await queryable.query(
            `INSERT INTO messages (client_id, event, data, chat_id, group_id, msg_type, wa_msg_id, ts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (wa_msg_id) WHERE wa_msg_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [
                clientId,
                'message_historical',
                jsonData,
                chatId,
                groupId,
                msg.type ?? null,
                waId,
                new Date(Number(msg.timestamp ?? msg.t) * 1000),
            ]
        );

        // RETURNING id is empty only for a genuine unique-ID duplicate.
        return res.rowCount > 0 ? 'saved' : 'duplicate';
    } catch (error) {
        const databaseError = new Error(`historical message DB write failed: ${error.message}`);
        databaseError.code = 'SYNC_DB_WRITE_FAILED';
        databaseError.dbCode = error.code || null;
        databaseError.cause = error;
        throw databaseError;
    }
}

module.exports = {
    getHistoricalSyncStatus,
    requestHistoricalSyncStop,
    resumeHistoricalSyncOnReconnect,
    startHistoricalSync,
    waitForHistoricalSync,
    _messageId,
    _messageTimestamp,
    _normalizeOptions,
    _saveMessage,
    _syncChat,
};
