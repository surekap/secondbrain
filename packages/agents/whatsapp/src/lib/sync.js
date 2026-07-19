'use strict';

const pool = require('./db');

let telemetry = null;
try { telemetry = require('@secondbrain/telemetry'); } catch (_) {}

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_MSG_LIMIT     = 2000;  // per chat — fetchMessages auto-loads earlier pages
const DEFAULT_CHAT_DELAY_MS = 300;   // brief pause between chats to avoid rate-limiting

const syncState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    days: null,
    msgLimit: null,
    totalChats: 0,
    completedChats: 0,
    totalSaved: 0,
    totalSkipped: 0,
    chatOffset: 0,
    chatBatchSize: null,
    totalAvailableChats: 0,
    errors: [],
};

function getHistoricalSyncStatus() {
    return { ...syncState, errors: syncState.errors.slice(-20) };
}

/**
 * Fire-and-forget: fetch all messages from the last LOOKBACK_DAYS days
 * across every chat/group and save them to the messages table.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} clientId
 */
function startHistoricalSync(client, clientId, runId = null, options = {}) {
    if (syncState.running) {
        const err = new Error('historical sync already running');
        err.code = 'SYNC_RUNNING';
        throw err;
    }
    syncState.running = true;
    syncState.startedAt = new Date().toISOString();
    syncState.finishedAt = null;
    syncState.days = Number(options.days || DEFAULT_LOOKBACK_DAYS);
    syncState.msgLimit = Number(options.msgLimit || DEFAULT_MSG_LIMIT);
    syncState.totalChats = 0;
    syncState.completedChats = 0;
    syncState.totalSaved = 0;
    syncState.totalSkipped = 0;
    syncState.chatOffset = Math.max(0, Number(options.chatOffset || 0));
    syncState.chatBatchSize = options.chatBatchSize ? Math.max(1, Number(options.chatBatchSize)) : null;
    syncState.totalAvailableChats = 0;
    syncState.errors = [];

    setImmediate(async () => {
        try {
            await _runSync(client, clientId, runId, options);
        } catch (err) {
            console.error('[sync] fatal error:', err.message);
            syncState.errors.push({ chat: null, error: err.message, ts: new Date().toISOString() });
        } finally {
            syncState.running = false;
            syncState.finishedAt = new Date().toISOString();
        }
    });
    return getHistoricalSyncStatus();
}

async function _runSync(client, clientId, runId, options = {}) {
    const lookbackDays = Math.max(1, Math.min(Number(options.days || DEFAULT_LOOKBACK_DAYS), 365));
    const msgLimit = Math.max(100, Math.min(Number(options.msgLimit || DEFAULT_MSG_LIMIT), 50000));
    const chatDelayMs = Math.max(0, Math.min(Number(options.chatDelayMs ?? DEFAULT_CHAT_DELAY_MS), 10000));
    const downloadMedia = options.downloadMedia !== false;
    const chatOffset = Math.max(0, Number(options.chatOffset || 0));
    const chatBatchSize = options.chatBatchSize ? Math.max(1, Math.min(Number(options.chatBatchSize), 5000)) : null;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);

    console.log(`[sync] starting — last ${lookbackDays} days (since ${cutoff.toISOString()}), limit ${msgLimit}/chat, media=${downloadMedia}`);

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
    });
    const skippedTypes = chats.length - syncable.length;
    const batchEnd = chatBatchSize ? Math.min(syncable.length, chatOffset + chatBatchSize) : syncable.length;
    const batch = syncable.slice(chatOffset, batchEnd);

    console.log(`[sync] ${chats.length} chats found (${syncable.length} syncable, ${skippedTypes} skipped — broadcast/status/channels); processing ${batch.length} chats at offset ${chatOffset}${chatBatchSize ? `, batchSize ${chatBatchSize}` : ''}`);
    syncState.totalAvailableChats = syncable.length;
    syncState.totalChats = batch.length;
    syncState.chatOffset = chatOffset;
    syncState.chatBatchSize = chatBatchSize;
    if (telemetry && runId) telemetry.progress(runId, 'chats_scanned', { completed: batch.length, total: batch.length });

    // Persist chat names for group name resolution
    for (const chat of batch) {
        const name = chat.name || null;
        const chatId = chat.id._serialized;
        const isGroup = chat.isGroup || false;
        if (name) {
            await pool.query(
                `INSERT INTO chat_metadata (chat_id, name, is_group, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (chat_id) DO UPDATE SET name = EXCLUDED.name, is_group = EXCLUDED.is_group, updated_at = NOW()`,
                [chatId, name, isGroup]
            ).catch(() => {}) // non-fatal
        }
    }

    let totalSaved = 0;
    let totalSkipped = 0;

    for (const chat of batch) {
        const name = chat.name || chat.id._serialized;
        try {
            const { saved, skipped } = await _syncChat(chat, cutoff, clientId, { msgLimit, downloadMedia });
            if (saved > 0 || skipped > 0) {
                console.log(`[sync]   ${name}: +${saved} saved, ${skipped} already existed`);
            }
            totalSaved   += saved;
            totalSkipped += skipped;
            syncState.completedChats += 1;
            syncState.totalSaved = totalSaved;
            syncState.totalSkipped = totalSkipped;
            if (telemetry && runId) telemetry.progress(runId, 'messages_synced', { completed: totalSaved });
        } catch (err) {
            syncState.completedChats += 1;
            syncState.errors.push({ chat: name, error: err.message, ts: new Date().toISOString() });
            console.error(`[sync]   ${name}: error — ${err.message}`);
        }
        // Small delay to avoid hammering WhatsApp
        await new Promise(r => setTimeout(r, chatDelayMs));
    }

    console.log(`[sync] done — ${totalSaved} saved, ${totalSkipped} already existed`);
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
        while (limit > 0 && messages.length < limit) {
            try {
                const earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
                if (!earlier?.length) break;
                messages = [...earlier.filter(msgFilter), ...messages];
            } catch (_) {
                break;
            }
        }
        messages.sort((a, b) => (a.t > b.t ? 1 : -1));
        if (limit > 0 && messages.length > limit) messages = messages.slice(messages.length - limit);
        return messages.map(message => {
            const data = window.WWebJS.getMessageModel(message);
            // Current WhatsApp Web exposes the Unix timestamp as `t`; the
            // whatsapp-web.js Message wrapper normally renames it to timestamp.
            // Raw fallbacks must do that normalization themselves.
            if (data.timestamp == null) data.timestamp = data.t ?? message.t;
            if (data.id && data.id._serialized == null) {
                data.id._serialized = data.id.$1 ?? message.id?._serialized ?? message.id?.$1;
            }
            return data;
        });
    }, chatId, msgLimit);
}

async function _fetchChatMessages(chat, msgLimit) {
    try {
        // fetchMessages with a high limit normally calls loadEarlierMsgs internally.
        return await chat.fetchMessages({ limit: msgLimit });
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
        return raw || [];
    }
}

async function _syncChat(chat, cutoff, clientId, { msgLimit, downloadMedia }) {
    const messages = await _fetchChatMessages(chat, msgLimit);

    // Messages come back sorted oldest-first. Filter to our window.
    const inWindow = messages.filter(m => {
        const timestamp = Number(m.timestamp ?? m.t);
        return Number.isFinite(timestamp) && new Date(timestamp * 1000) >= cutoff;
    });

    let saved = 0;
    let skipped = 0;

    for (const msg of inWindow) {
        const result = await _saveMessage(msg, clientId);
        if (result === 'saved')   saved++;
        else                      skipped++;
    }

    if (downloadMedia) {
        // Keep media recovery bounded. The analyzer runs separately in small,
        // resumable batches after each file is safely persisted.
        const { downloadAndStore } = require('./mediaDownloader');
        for (const msg of inWindow) {
            if (msg.hasMedia) {
                await downloadAndStore(msg);
            }
        }
    }

    return { saved, skipped };
}

async function _saveMessage(msg, clientId) {
    const waId = msg.id?._serialized ?? msg.id?.$1 ?? null;

    // For group messages, the chat ID is msg.id.remote (the group JID).
    // For DMs, it's msg.from (for incoming) or msg.to (for outgoing).
    const chatId  = msg.id?.remote ?? msg.from ?? msg.to ?? null;
    const groupId = (msg.isGroup || String(chatId || '').endsWith('@g.us')) ? chatId : null;

    let jsonData;
    try {
        jsonData = JSON.stringify(msg._data ?? msg ?? null);
    } catch (_) {
        jsonData = JSON.stringify({ _error: 'could not serialize' });
    }

    try {
        const res = await pool.query(
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

        // RETURNING id is empty when ON CONFLICT DO NOTHING fires
        return res.rowCount > 0 ? 'saved' : 'skipped';
    } catch (err) {
        console.error('[sync] DB error:', err.message);
        return 'skipped';
    }
}

module.exports = { startHistoricalSync, getHistoricalSyncStatus };
