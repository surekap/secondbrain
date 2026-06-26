'use strict';

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });
const fs = require('fs');
const express = require('express');
const { Client, Events, LocalAuth } = require('whatsapp-web.js');
const PostgresStore = require('./lib/PostgresStore');
const dispatcher = require('./lib/dispatcher');
const { startHistoricalSync, getHistoricalSyncStatus } = require('./lib/sync');
const pool = require('./lib/db');
const { cleanupOrphanedRuns, killDuplicateProcesses } = require('../../shared/cleanup');

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/subscribers', subscribersRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/status', statusRouter);

app.get('/api/sync/historical/status', (req, res) => {
    res.json(getHistoricalSyncStatus());
});

app.post('/api/sync/historical', (req, res) => {
    const days = Math.max(1, Math.min(Number(req.body?.days || 90), 365));
    const msgLimit = Math.max(100, Math.min(Number(req.body?.msgLimit || 10000), 50000));
    const chatDelayMs = Math.max(0, Math.min(Number(req.body?.chatDelayMs ?? 300), 10000));
    const downloadMedia = Boolean(req.body?.downloadMedia);
    try {
        const status = startHistoricalSync(client, process.env.CLIENT_ID, _runId, { days, msgLimit, chatDelayMs, downloadMedia });
        res.status(202).json({ ok: true, status });
    } catch (err) {
        if (err.code === 'SYNC_RUNNING') return res.status(409).json({ ok: false, error: err.message, status: getHistoricalSyncStatus() });
        res.status(500).json({ ok: false, error: err.message });
    }
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── WhatsApp client ───────────────────────────────────────────────────────────
const store = new PostgresStore(process.env.CLIENT_ID);

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

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: process.env.CLIENT_ID,
        dataPath: path.resolve(__dirname, '..', '.wwebjs_auth'),
    }),
    puppeteer: {
        executablePath,
        headless: true,
        protocolTimeout: 600_000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
    },
});

// Keep statusRouter informed of WA state changes
client.on(Events.AUTHENTICATED,      () => { console.log('[wa] authenticated'); setWaState('AUTHENTICATED'); });
client.on(Events.AUTH_FAILURE,       (msg) => { console.log('[wa] auth failure:', msg); setWaState('AUTH_FAILURE'); });
client.on(Events.READY, async () => {
    console.log('[wa] ready');
    setWaState('CONNECTED');
    if (telemetry) _runId = await telemetry.startRun({ agentId: 'whatsapp', workflowName: 'message_bridge' });
    if (process.env.WHATSAPP_AUTO_SYNC_ON_READY === '1') {
        startHistoricalSync(client, process.env.CLIENT_ID, _runId);
    } else {
        console.log('[sync] startup historical sync skipped; use POST /api/sync/historical for manual backfills');
    }
});
client.on(Events.DISCONNECTED, async (reason) => {
    console.log('[wa] disconnected:', reason);
    setWaState('DISCONNECTED');
    if (telemetry && _runId) { await telemetry.endRun(_runId, { status: 'completed' }); _runId = null; }
});
client.on('qr', qr => {
    // Emit raw QR data on a single line so the UI can render it as a scannable image
    process.stdout.write('[WA_QR]' + qr + '\n');
    setWaState('AWAITING_QR');
});
client.on(Events.REMOTE_SESSION_SAVED, () => console.log('[wa] session saved to store'));

// Handle all WhatsApp events
Object.keys(Events).forEach(eventKey => {
    const eventName = Events[eventKey];
    client.on(eventName, async (data) => {
        try {
            const result = await store.event(eventName, data);
            const messageId = result?.rows?.[0]?.id ?? null;

            // Persist chat name if available on live message events
            if ((eventName === 'message' || eventName === 'message_create') && data.chatName && data.from) {
                const chatId = data.id?.remote || data.from;
                const isGroup = chatId?.endsWith('@g.us') || false;
                // Fire-and-forget: use setImmediate to avoid concurrent query warning
                setImmediate(async () => {
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
            if ((eventName === 'message' || eventName === 'message_create') && data.hasMedia) {
                const { downloadAndStore } = require('./lib/mediaDownloader');
                downloadAndStore(data).catch(() => {});
            }

            if (eventName === Events.MESSAGE_RECEIVED && messageId) {
                // Skip messages older than 5 minutes (replays on reconnect)
                const messageTime = new Date((data.timestamp ?? 0) * 1000);
                if (Date.now() - messageTime > 5 * 60 * 1000) return;

                dispatcher.dispatch({
                    id:        messageId,
                    client_id: process.env.CLIENT_ID,
                    event:     eventName,
                    chat_id:   data.from ?? null,
                    group_id:  data.isGroup ? (data.id?._serialized ?? null) : null,
                    data,
                    ts:        new Date().toISOString(),
                });
            }
        } catch (err) {
            console.error('[app] event handler error:', err.message);
        }
    });
});

// ── Boot sequence ─────────────────────────────────────────────────────────────
(async () => {
    try {
        killDuplicateProcesses();
        await cleanupOrphanedRuns(pool, 'whatsapp');
        await runMigrations();
        app.listen(PORT, () => console.log(`[http] listening on http://localhost:${PORT}/admin/`));
        client.initialize();
        console.log('[wa] initializing…');
    } catch (err) {
        console.error('[boot] fatal error:', err);
        process.exit(1);
    }
})();
