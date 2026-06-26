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
        console.error('[sync] could not load chats after 3 attempts, aborting');
        return;
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

    console.log(`[sync] ${chats.length} chats found (${syncable.length} syncable, ${skippedTypes} skipped — broadcast/status/channels)`);
    syncState.totalChats = syncable.length;
    if (telemetry && runId) telemetry.progress(runId, 'chats_scanned', { completed: syncable.length, total: syncable.length });

    // Persist chat names for group name resolution
    for (const chat of syncable) {
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

    for (const chat of syncable) {
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
    const inWindow = messages.filter(m => new Date(m.timestamp * 1000) >= cutoff);

    let saved = 0;
    let skipped = 0;

    for (const msg of inWindow) {
        const result = await _saveMessage(msg, clientId);
        if (result === 'saved')   saved++;
        else                      skipped++;
    }

    if (downloadMedia) {
        // Background media download for messages with media (fire-and-forget)
        const { downloadAndStore } = require('./mediaDownloader');
        for (const msg of inWindow) {
            if (msg.hasMedia) {
                downloadAndStore(msg).catch(() => {});
            }
        }
    }

    return { saved, skipped };
}

async function _saveMessage(msg, clientId) {
    const waId = msg.id?._serialized ?? null;

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
                new Date(msg.timestamp * 1000),
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
