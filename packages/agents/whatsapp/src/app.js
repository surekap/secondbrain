'use strict';

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });
const fs = require('fs');
const { execFileSync } = require('child_process');
const express = require('express');
const { Client, Events, LocalAuth } = require('whatsapp-web.js');
const PostgresStore = require('./lib/PostgresStore');
const {
    canonicalWhatsAppChatId,
    isGroupWhatsAppChatId,
} = require('../../shared/whatsapp-chat');
const dispatcher = require('./lib/dispatcher');
const {
    getHistoricalSyncStatus,
    requestHistoricalSyncStop,
    resumeHistoricalSyncOnReconnect,
    startHistoricalSync,
    waitForHistoricalSync,
} = require('./lib/sync');
const { recoverMissingMedia, getMediaRecoveryStatus } = require('./lib/mediaDownloader');
const pool = require('./lib/db');
const {
    processPendingMedia,
    getMediaAnalysisStatus,
    getMediaAnalysisCounts,
    resumeMediaAnalysis,
    startMediaAnalysisWorker,
    stopMediaAnalysisWorker,
} = require('./lib/mediaAnalyzer');
const { cleanupOrphanedRuns, killDuplicateProcesses } = require('../../shared/cleanup');
const { requireSameOrigin } = require('../../shared/http-security');

let telemetry = null;
try { telemetry = require('@secondbrain/telemetry'); } catch (_) {}
if (telemetry) telemetry.init('whatsapp');

let _runId = null;

if (!process.env.CLIENT_ID) {
    console.error('[boot] CLIENT_ID env var is required');
    process.exit(1);
}

const subscribersRouter = require('./api/subscribersRouter');
const messagesRouter = require('./api/messagesRouter');
const statusRouter = require('./api/statusRouter');
const { setWaState } = statusRouter;

// ── Database migration ────────────────────────────────────────────────────────
async function runMigrations() {
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
        console.warn('[db] schema.sql not found, skipping migration');
        return;
    }
    const sql = fs.readFileSync(schemaPath, 'utf8');
    try {
        await pool.query(sql);
        console.log('[db] schema applied');
    } catch (err) {
        console.error('[db] migration error:', err.message);
        throw err;
    }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(requireSameOrigin());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/subscribers', subscribersRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/status', statusRouter);

app.get('/api/media/analysis/status', async (req, res) => {
    try {
        res.json({ ...getMediaAnalysisStatus(), counts: await getMediaAnalysisCounts() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/media/analysis/run', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 5), 50));
    resumeMediaAnalysis();
    setImmediate(() => { processPendingMedia(limit).catch(err => console.warn('[media-analysis] manual run failed:', err.message)); });
    res.status(202).json({ ok: true, limit, status: getMediaAnalysisStatus() });
});

app.get('/api/media/recovery/status', (req, res) => {
    res.json(getMediaRecoveryStatus());
});

app.post('/api/media/recovery/run', (req, res) => {
    const days = Math.max(1, Math.min(Number(req.body?.days || 90), 365));
    const limit = Math.max(1, Math.min(Number(req.body?.limit || 500), 2000));
    setImmediate(() => { recoverMissingMedia(client, { days, limit }).catch(err => console.warn('[media] targeted recovery failed:', err.message)); });
    res.status(202).json({ ok: true, days, limit, status: getMediaRecoveryStatus() });
});

app.get('/api/sync/historical/status', async (req, res) => {
    try {
        res.json(await getHistoricalSyncStatus(process.env.CLIENT_ID));
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/sync/historical', async (req, res) => {
    const days = Math.max(1, Math.min(Number(req.body?.days || 90), 365));
    const msgLimit = Math.max(100, Math.min(Number(req.body?.msgLimit || 10000), 50000));
    const pageSize = Math.max(25, Math.min(Number(req.body?.pageSize || 250), 1000));
    const chatDelayMs = Math.max(0, Math.min(Number(req.body?.chatDelayMs ?? 300), 10000));
    const downloadMedia = Boolean(req.body?.downloadMedia);
    const chatOffset = Math.max(0, Number(req.body?.chatOffset || 0));
    const chatBatchSize = req.body?.chatBatchSize ? Math.max(1, Math.min(Number(req.body.chatBatchSize), 5000)) : null;
    const resume = req.body?.resume !== false;
    try {
        const status = await startHistoricalSync(client, process.env.CLIENT_ID, _runId, {
            days,
            msgLimit,
            pageSize,
            chatDelayMs,
            downloadMedia,
            chatOffset,
            chatBatchSize,
            resume,
            trigger: 'manual',
        });
        res.status(202).json({ ok: true, status });
    } catch (err) {
        if (err.code === 'SYNC_RUNNING') {
            const status = await getHistoricalSyncStatus(process.env.CLIENT_ID).catch(() => null);
            return res.status(409).json({ ok: false, error: err.message, status });
        }
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Pairing codes let a remote operator relink the connector from the same phone
// that is running WhatsApp, without needing a second screen to scan a QR code.
app.post('/api/pairing-code', async (req, res) => {
    const phoneNumber = String(req.body?.phoneNumber || '').replace(/\D/g, '');
    if (phoneNumber.length < 8 || phoneNumber.length > 15) {
        return res.status(400).json({ ok: false, error: 'phoneNumber must contain 8-15 digits including country code' });
    }
    try {
        const code = await client.requestPairingCode(phoneNumber);
        setWaState('AWAITING_PAIRING_CODE');
        res.json({ ok: true, code });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.WHATSAPP_BIND_HOST || '127.0.0.1';

// ── WhatsApp client ───────────────────────────────────────────────────────────
const store = new PostgresStore(process.env.CLIENT_ID);

const authDataPath = path.resolve(__dirname, '..', '.wwebjs_auth');
const sessionProfilePath = path.join(authDataPath, `session-${process.env.CLIENT_ID}`);

function isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function cleanupStaleSessionLock() {
    const lockPath = path.join(sessionProfilePath, 'SingletonLock');
    // existsSync follows symlinks and returns false for Chrome's intentionally
    // dangling SingletonLock target. lstat detects the lock entry itself.
    try { fs.lstatSync(lockPath); } catch (_) { return; }

    let chromePid = null;
    try {
        const target = fs.readlinkSync(lockPath);
        chromePid = Number(target.match(/-(\d+)$/)?.[1] || 0) || null;
    } catch (_) {}

    if (chromePid && isPidAlive(chromePid)) {
        let command = '';
        try { command = execFileSync('ps', ['-p', String(chromePid), '-o', 'command='], { encoding: 'utf8' }); } catch (_) {}
        if (!command.includes(`--user-data-dir=${sessionProfilePath}`)) {
            throw new Error(`session profile is locked by unexpected pid ${chromePid}`);
        }
        console.warn(`[wa] terminating orphaned session Chrome (pid ${chromePid})`);
        process.kill(chromePid, 'SIGTERM');
        for (let attempt = 0; attempt < 20 && isPidAlive(chromePid); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (isPidAlive(chromePid)) process.kill(chromePid, 'SIGKILL');
    }

    for (const filename of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
        try { fs.unlinkSync(path.join(sessionProfilePath, filename)); } catch (_) {}
    }
}

// Get Chrome executable path with fallbacks
let executablePath;
try {
    if (process.env.CHROME_PATH) {
        // User provided path
        executablePath = process.env.CHROME_PATH;
        console.log('[wa] using CHROME_PATH:', executablePath);
    } else {
        // Try puppeteer's bundled Chrome
        const puppeteerPath = require('puppeteer').executablePath();
        if (fs.existsSync(puppeteerPath)) {
            executablePath = puppeteerPath;
            console.log('[wa] using puppeteer Chrome');
        } else {
            // Try system Chrome installations
            const possiblePaths = [
                '/opt/homebrew/bin/chromium',
                '/usr/local/bin/chromium',
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
            ];
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    executablePath = p;
                    console.log('[wa] found system Chrome:', p);
                    break;
                }
            }
            if (!executablePath) {
                throw new Error(
                    'Chrome/Chromium not found. Options:\n' +
                    '1. Install: brew install chromium\n' +
                    '2. Or set: export CHROME_PATH=/path/to/chrome\n' +
                    '3. Or run: npm run whatsapp:setup'
                );
            }
        }
    }
} catch (err) {
    console.error('[wa] failed to find Chrome:', err.message);
    process.exit(1);
}

// Use system Chrome explicitly — the puppeteer bundled Chrome (131) is incompatible
// with wwebjs's internal puppeteer-core. System Chrome 149 works but wwebjs spoofs
// a Chrome/101 user-agent by default, causing WhatsApp to hang at AUTHENTICATED.
// Override both the executable path and user-agent to stay consistent with 149.
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const resolvedExec = fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : executablePath;
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36';

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: process.env.CLIENT_ID,
        dataPath: authDataPath,
    }),
    userAgent: CHROME_UA,
    puppeteer: {
        executablePath: resolvedExec,
        headless: true,
        protocolTimeout: 600_000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            `--user-agent=${CHROME_UA}`,
        ],
    },
});

let shuttingDown = false;
async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[boot] shutting down (${reason})`);
    try { await stopMediaAnalysisWorker(); } catch (err) { console.warn('[media-analysis] shutdown drain failed:', err.message); }
    requestHistoricalSyncStop(`shutdown: ${reason}`);
    try { await waitForHistoricalSync(); } catch (err) { console.warn('[sync] shutdown wait failed:', err.message); }
    try { await client.destroy(); } catch (err) { console.warn('[wa] browser cleanup failed:', err.message); }
    try { await pool.end(); } catch (_) {}
    process.exit(exitCode);
}

process.once('SIGINT', () => { shutdown('SIGINT'); });
process.once('SIGTERM', () => { shutdown('SIGTERM'); });
process.once('uncaughtException', err => {
    console.error('[boot] uncaught exception:', err);
    shutdown('uncaught exception', 1);
});
process.once('unhandledRejection', err => {
    console.error('[boot] unhandled rejection:', err);
    shutdown('unhandled rejection', 1);
});

// Keep statusRouter informed of WA state changes. Newer WhatsApp Web builds can
// reach a connected socket without whatsapp-web.js emitting READY, so verify the
// underlying state after authentication as a compatibility fallback.
let connectedHandled = false;
let connectedOnce = false;
async function markConnected(source) {
    if (connectedHandled) return;
    connectedHandled = true;
    console.log(`[wa] ready (${source})`);
    setWaState('CONNECTED');
    if (telemetry) _runId = await telemetry.startRun({ agentId: 'whatsapp', workflowName: 'message_bridge' });
    const isReconnect = connectedOnce;
    connectedOnce = true;
    try {
        if (!isReconnect && process.env.WHATSAPP_AUTO_SYNC_ON_READY === '1') {
            await startHistoricalSync(client, process.env.CLIENT_ID, _runId, { trigger: 'startup', resume: true });
        } else if (process.env.WHATSAPP_RECONNECT_SYNC_DISABLED !== '1') {
            const overlapMinutes = Math.max(15, Math.min(Number(process.env.WHATSAPP_RECONNECT_OVERLAP_MINUTES || 120), 10080));
            await resumeHistoricalSyncOnReconnect(client, process.env.CLIENT_ID, _runId, { overlapMinutes });
        } else {
            console.log('[sync] reconnect overlap sync disabled; use POST /api/sync/historical for manual backfills');
        }
    } catch (err) {
        if (err.code !== 'SYNC_RUNNING') console.warn('[sync] reconnect resume failed:', err.message);
    }
}

async function waitForConnectedState() {
    for (let attempt = 0; attempt < 60 && !connectedHandled; attempt++) {
        try {
            if (await client.getState() === 'CONNECTED') {
                await markConnected('socket state');
                return;
            }
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

client.on(Events.AUTHENTICATED, () => {
    console.log('[wa] authenticated');
    setWaState('AUTHENTICATED');
    setImmediate(() => { waitForConnectedState().catch(err => console.warn('[wa] readiness check failed:', err.message)); });
});
client.on(Events.AUTH_FAILURE,       (msg) => { console.log('[wa] auth failure:', msg); setWaState('AUTH_FAILURE'); });
client.on(Events.READY, () => { markConnected('ready event').catch(err => console.error('[wa] ready handler failed:', err.message)); });
client.on(Events.DISCONNECTED, async (reason) => {
    console.log('[wa] disconnected:', reason);
    connectedHandled = false;
    setWaState('DISCONNECTED');
    requestHistoricalSyncStop(`WhatsApp disconnected: ${reason}`);
    await waitForHistoricalSync().catch(err => console.warn('[sync] disconnect checkpoint failed:', err.message));
    if (telemetry && _runId) { await telemetry.endRun(_runId, { status: 'completed' }); _runId = null; }
});
client.on('qr', qr => {
    // Emit raw QR data on a single line so the UI can render it as a scannable image
    process.stdout.write('[WA_QR]' + qr + '\n');
    setWaState('AWAITING_QR');
});
client.on(Events.REMOTE_SESSION_SAVED, () => console.log('[wa] session saved to store'));

// Handle all WhatsApp events
for (const eventName of new Set(Object.values(Events))) {
    client.on(eventName, async (data) => {
        try {
            const result = await store.event(eventName, data);
            const messageId = result?.rows?.[0]?.id ?? null;

            // Persist chat name if available on live message events
            if ((eventName === 'message' || eventName === 'message_create') && data.chatName) {
                const chatId = canonicalWhatsAppChatId(data, {
                    selfJid: process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID,
                });
                const isGroup = isGroupWhatsAppChatId(chatId);
                // Fire-and-forget: use setImmediate to avoid concurrent query warning
                if (chatId) setImmediate(async () => {
                    try {
                        await pool.query(
                            `INSERT INTO chat_metadata (chat_id, name, is_group, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (chat_id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
                            [chatId, data.chatName, isGroup]
                        );
                    } catch (err) {
                        console.debug('[app] chat_metadata insert failed:', err.message);
                    }
                });
            }

            // Download media for new messages (fire-and-forget)
            if ((eventName === 'message' || eventName === 'message_create') &&
                data.hasMedia && data.id?._serialized && typeof data.downloadMedia === 'function') {
                const { downloadAndStore } = require('./lib/mediaDownloader');
                downloadAndStore(data).catch(() => {});
            }

            if (eventName === Events.MESSAGE_RECEIVED && messageId) {
                // Skip messages older than 5 minutes (replays on reconnect)
                const messageTime = new Date((data.timestamp ?? 0) * 1000);
                if (Date.now() - messageTime > 5 * 60 * 1000) return;

                const chatId = canonicalWhatsAppChatId(data, {
                    selfJid: process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID,
                });
                dispatcher.dispatch({
                    id:        messageId,
                    client_id: process.env.CLIENT_ID,
                    event:     eventName,
                    chat_id:   chatId,
                    group_id:  isGroupWhatsAppChatId(chatId) ? chatId : null,
                    data,
                    ts:        new Date().toISOString(),
                });
            }
        } catch (err) {
            console.error('[app] event handler error:', err.message);
        }
    });
}

// ── Boot sequence ─────────────────────────────────────────────────────────────
(async () => {
    try {
        killDuplicateProcesses();
        await cleanupOrphanedRuns(pool, 'whatsapp');
        await runMigrations();
        await cleanupStaleSessionLock();
        startMediaAnalysisWorker();
        app.listen(PORT, HOST, () => console.log(`[http] listening on http://${HOST}:${PORT}/admin/`));
        client.initialize().catch(err => {
            console.error('[wa] initialization failed:', err);
            shutdown('initialization failure', 1);
        });
        console.log('[wa] initializing…');
    } catch (err) {
        console.error('[boot] fatal error:', err);
        process.exit(1);
    }
})();
