'use strict';

const express    = require('express');
const { spawn }  = require('child_process');
const { randomUUID } = require('crypto');
const fs         = require('fs');
const path       = require('path');
const dotenv     = require('dotenv');
const { Pool }   = require('pg');
const Anthropic  = require('@anthropic-ai/sdk');
const indexer    = require('./services/indexer');
const { embed, toSql, getEmbeddingConfig } = require('./services/embedder');
const { getProviderDefinitions, DEFAULT_OLLAMA_BASE_URL } = require('../agents/shared/model-catalog');
const { listOllamaModelOptions } = require('../agents/shared/ollama');
const { getAvailableModels } = require('../agents/shared/model-fetcher');
const { createObserveRouter } = require('../observe/routes');
const observeAlerts = require('../observe/alerts');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const ENV_PATH  = path.resolve(__dirname, '../../.env.local');
const PIDS_DIR  = path.resolve(__dirname, '../../.agent-pids');
const LOGS_DIR  = path.resolve(__dirname, '../../.agent-logs');
dotenv.config({ path: ENV_PATH });

// Ensure runtime directories exist
for (const dir of [PIDS_DIR, LOGS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Database (optional — used for stats) ─────────────────────────────────────

let db = null;
try {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
} catch (e) {
  console.warn('[ui] DB pool creation failed:', e.message);
}

const intelligenceRefreshState = {
  current: null,
  last: null,
  history: [],
};

function createIntelligenceRefreshRun(trigger = 'api') {
  return {
    id: randomUUID(),
    trigger,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
    error: null,
    result: null,
    logs: [],
  };
}

function appendIntelligenceRefreshLog(run, level, message, meta = null) {
  if (!run) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: String(message || ''),
    ...(meta ? { meta } : {}),
  };
  run.logs.push(entry);
  if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500);
  const line = `[intelligence-refresh:${run.id}] ${entry.message}`;
  if (level === 'error') console.error(line, meta || '');
  else if (level === 'warn') console.warn(line, meta || '');
  else console.log(line, meta || '');
}

function finishIntelligenceRefreshRun(run, status, result = null, error = null) {
  if (!run) return;
  run.status = status;
  run.finished_at = new Date().toISOString();
  run.duration_ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  run.result = result;
  run.error = error ? String(error.message || error) : null;
  intelligenceRefreshState.last = run;
  intelligenceRefreshState.history.unshift(run);
  intelligenceRefreshState.history = intelligenceRefreshState.history.slice(0, 10);
  if (intelligenceRefreshState.current?.id === run.id) intelligenceRefreshState.current = null;
}

// ── Schema + Config Migration ──────────────────────────────────────────────────

async function runSystemSchema() {
  if (!db) return;

  // Order matters: agent schemas first, then system (which creates per-agent config
  // tables conditionally), then search (pgvector — may not be installed).
  const schemas = [
    { file: '../agents/email/sql/schema.sql',          required: true  },
    { file: '../agents/limitless/sql/schema.sql',      required: true  },
    { file: '../agents/projects/sql/schema.sql',       required: true  },
    { file: '../agents/relationships/sql/schema.sql',  required: true  },
    { file: '../agents/ai/sql/schema.sql',             required: true  },
    { file: '../agents/research/sql/schema.sql',       required: true  },
    { file: '../agents/intelligence/sql/schema.sql',   required: true  },
    { file: '../agents/apple-contacts/sql/schema.sql', required: true  },
    { file: '../agents/whatsapp/src/db/schema.sql',    required: true  },
    { file: '../agents/shared/sql/system-schema.sql',  required: true  },
    { file: '../agents/shared/sql/telemetry-schema.sql', required: true },
    { file: './sql/search_schema.sql',                 required: false }, // needs pgvector
  ];

  for (const { file, required } of schemas) {
    const sql = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    try {
      await db.query(sql);
    } catch (err) {
      if (required) throw err;
      console.warn(`[server] optional schema skipped (${path.basename(file)}): ${err.message}`);
    }
  }

  console.log('[server] all schemas initialized');
}

async function migrateEnvToDb() {
  if (!db) return;
  const { setConfig, getConfig } = require('../agents/shared/config');

  let migrated = 0;

  async function seed(key, value) {
    if (await getConfig(key) == null) {
      await setConfig(key, value);
      migrated++;
    }
  }

  // ── API keys: only seed if present in environment ──────────────────────────
  const apiKeys = [
    'LIMITLESS_API_KEY', 'TAVILY_API_KEY', 'PEOPLEDATALABS_API_KEY',
    'SERPAPI_API_KEY', 'NOTION_TOKEN', 'TODOIST_API_KEY', 'PERPLEXITY_API_KEY',
    'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  ];
  for (const envKey of apiKeys) {
    if (process.env[envKey]) await seed(`system.${envKey}`, process.env[envKey]);
  }

  // ── Gmail accounts: build from numbered env pairs ──────────────────────────
  const accounts = [];
  for (let i = 1; ; i++) {
    const email = process.env[`GMAIL_EMAIL_${i}`];
    const pass  = process.env[`GMAIL_APP_PASSWORD_${i}`];
    if (!email) break;
    accounts.push({ email, app_password: pass || '' });
  }
  if (accounts.length > 0) await seed('email.gmail_accounts', accounts);

  // ── Non-secret defaults: always seed on fresh install ──────────────────────
  await seed('system.EMBEDDING_MODEL', 'gemini-embedding-2-preview');
  await seed('system.EMBEDDING_PROVIDER', 'gemini');
  await seed('system.OLLAMA_BASE_URL', DEFAULT_OLLAMA_BASE_URL);

  await seed('email.BATCH_SIZE',  '50');
  await seed('email.MAILBOX',     'INBOX');

  const ltFetchDays = process.env.FETCH_DAYS ? Number(process.env.FETCH_DAYS) : 1;
  await seed('limitless.FETCH_DAYS',              ltFetchDays);
  await seed('limitless.FETCH_INTERVAL_CRON',     '*/5 * * * *');
  await seed('limitless.PROCESS_INTERVAL_CRON',   '*/1 * * * *');
  await seed('limitless.PROCESSING_BATCH_SIZE',   '15');

  // WhatsApp — CLIENT_ID has no sensible default; leave blank for user to fill
  await seed('system.WHATSAPP_CLIENT_ID', '');

  if (migrated > 0) {
    console.log(`[server] seeded ${migrated} config keys to DB`);
  }
}

// ── Chromium setup (idempotent) ───────────────────────────────────────────────

async function ensurePuppeteerChrome() {
  try {
    const puppeteer = require('puppeteer');
    const execPath = puppeteer.executablePath();
    if (fs.existsSync(execPath)) return; // already installed
    console.log('[server] Downloading Chromium for WhatsApp bridge (one-time, ~200 MB)…');
    const { execSync } = require('child_process');
    execSync('npm run setup --workspace=packages/agents/whatsapp', {
      stdio: 'inherit',
      cwd:   path.resolve(__dirname, '../..'),
    });
    console.log('[server] Chromium ready');
  } catch (err) {
    console.warn('[server] Chromium setup skipped:', err.message);
  }
}

// ── Agent definitions ─────────────────────────────────────────────────────────

const AGENTS = {
  email: {
    id:          'email',
    name:        'Email Agent',
    description: 'Syncs Gmail inboxes into Postgres via IMAP',
    entrypoint:  path.resolve(__dirname, '../agents/email/index.js'),
  },
  limitless: {
    id:          'limitless',
    name:        'Limitless Agent',
    description: 'Fetches and processes Limitless.ai lifelogs',
    entrypoint:  path.resolve(__dirname, '../agents/limitless/index.js'),
  },
  relationships: {
    id:          'relationships',
    name:        'Relationships Agent',
    description: 'Analyzes emails, WhatsApp, and Limitless to build contact profiles',
    entrypoint:  path.resolve(__dirname, '../agents/relationships/index.js'),
  },
  projects: {
    id:          'projects',
    name:        'Projects Agent',
    description: 'Groups communications into projects and tracks their progress',
    entrypoint:  path.resolve(__dirname, '../agents/projects/index.js'),
  },
  research: {
    id:          'research',
    name:        'Research Agent',
    description: 'Enriches contact profiles via Tavily, OpenAI, PeopleDataLabs, SerpAPI',
    entrypoint:  path.resolve(__dirname, '../agents/research/index.js'),
  },
  openai: {
    id:          'openai',
    name:        'OpenAI Importer',
    description: 'Imports ChatGPT conversation history from a data export file',
    entrypoint:  path.resolve(__dirname, '../agents/ai/openai.js'),
  },
  gemini: {
    id:          'gemini',
    name:        'Gemini Importer',
    description: 'Imports Google Gemini conversation history from a Google Takeout export',
    entrypoint:  path.resolve(__dirname, '../agents/ai/gemini.js'),
  },
  whatsapp: {
    id:          'whatsapp',
    name:        'WhatsApp Connector',
    description: 'Bridges WhatsApp Web to Postgres — saves messages and fans out to webhook subscribers',
    entrypoint:  path.resolve(__dirname, '../agents/whatsapp/src/app.js'),
  },
  'apple-contacts': {
    id:              'apple-contacts',
    name:            'Apple Contacts',
    description:     'Syncs Apple Contacts into the relationships database. VCF upload available on all platforms.',
    entrypoint:      path.resolve(__dirname, '../agents/apple-contacts/index.js'),
    nativeAvailable: process.platform === 'darwin',
  },
};

// ── Process registry ──────────────────────────────────────────────────────────

const procs = {};   // agentId → { proc, pid, startTime, stoppedAt, exitCode, logStream, recovered }
const logs  = {};   // agentId → [{ ts, stream, text }]

Object.keys(AGENTS).forEach(id => { logs[id] = []; });

const MAX_LOG_LINES = 500;

function pidFile(id) { return path.join(PIDS_DIR, `${id}.pid`); }
function logFile(id) { return path.join(LOGS_DIR, `${id}.log`); }

function appendLog(agentId, stream, data) {
  const lines = data.toString().split('\n').filter(l => l.length > 0);
  const entry = procs[agentId];
  for (const text of lines) {
    const record = { ts: new Date().toISOString(), stream, text };
    logs[agentId].push(record);
    if (logs[agentId].length > MAX_LOG_LINES) logs[agentId].shift();
    // Write to log file
    if (entry?.logStream) {
      entry.logStream.write(JSON.stringify(record) + '\n');
    }
  }
}

// Read persisted log lines from disk (for recovered agents)
function readLogFile(id) {
  const fpath = logFile(id);
  if (!fs.existsSync(fpath)) return [];
  try {
    return fs.readFileSync(fpath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
      .slice(-MAX_LOG_LINES);
  } catch { return []; }
}

// Open an append-mode log stream for an agent
function openLogStream(id) {
  try {
    return fs.createWriteStream(logFile(id), { flags: 'a' });
  } catch { return null; }
}

// Check if a PID is alive without sending a real signal
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Scan `ps` output for a node process running a given script path
// Returns the PID or null
function findProcessByScript(scriptPath) {
  try {
    const { execSync } = require('child_process');
    // ps ax: PID STAT CMD...   (works on macOS and Linux)
    const out = execSync('ps ax -o pid,command', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    // Also check relative path (agents started via `npm run X` use relative paths)
    const relPath = path.relative(process.cwd(), scriptPath);
    for (const line of out.split('\n')) {
      if (line.includes(scriptPath) || line.includes(relPath)) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!isNaN(pid)) return pid;
      }
    }
  } catch {}
  return null;
}

// On startup: detect agents that were started by a previous server instance
// or started externally (e.g. npm run start:email)
function recoverAgents() {
  for (const [id, def] of Object.entries(AGENTS)) {
    // 1. Try PID file first
    const pf = pidFile(id);
    let pid = null;
    if (fs.existsSync(pf)) {
      try {
        const stored = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
        if (!isNaN(stored) && isPidAlive(stored)) pid = stored;
        else fs.unlinkSync(pf);
      } catch {}
    }

    // 2. Fall back to scanning ps for the agent entrypoint
    if (!pid) pid = findProcessByScript(def.entrypoint);

    if (!pid) continue;

    procs[id] = { proc: null, pid, startTime: null, stoppedAt: null, exitCode: null,
                  logStream: null, recovered: true };
    // Write a PID file so future restarts also find it
    try { fs.writeFileSync(pidFile(id), String(pid)); } catch {}
    // Load any historical log lines from file
    logs[id] = readLogFile(id);
    appendLog(id, 'system', `[${def.name}] recovered (pid ${pid})`);
    console.log(`[ui] Recovered ${id} agent (pid ${pid})`);
  }
}

// ── .env.local helpers ────────────────────────────────────────────────────────

function readEnv() {
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const result  = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let   val = line.slice(eq + 1).trim();
    // Strip trailing inline comment (two+ spaces then #)
    val = val.replace(/\s{2,}#.*$/, '').trim();
    result[key] = val;
  }
  return result;
}

/**
 * Write back only the provided key→value pairs, preserving everything else.
 * Pass null/undefined to delete a key. Keys not in the file get appended.
 */
function writeEnv(updates) {
  const content  = fs.readFileSync(ENV_PATH, 'utf8');
  const touched  = new Set();

  const lines = content.split('\n').map(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return raw;
    const eq = line.indexOf('=');
    if (eq === -1) return raw;
    const key = line.slice(0, eq).trim();
    if (!(key in updates)) return raw;
    touched.add(key);
    const val = updates[key];
    return (val == null || val === '') ? null : `${key}=${val}`;
  }).filter(l => l !== null);

  for (const [key, val] of Object.entries(updates)) {
    if (!touched.has(key) && val != null && val !== '') {
      lines.push(`${key}=${val}`);
    }
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

// ── Agent process management ──────────────────────────────────────────────────

const waQr = {}; // agentId → { data: string, ts: Date } — latest WhatsApp QR

async function startAgent(id) {
  if (procs[id]?.proc || procs[id]?.recovered) return { error: 'Already running' };
  const def = AGENTS[id];
  if (!def) return { error: 'Unknown agent' };

  // Reload env so the spawned process gets latest config
  dotenv.config({ path: ENV_PATH, override: true });

  // For the WhatsApp agent, inject CLIENT_ID from system.config
  let extraEnv = {};
  if (id === 'whatsapp') {
    const { getConfig } = require('../agents/shared/config');
    const clientId = await getConfig('system.WHATSAPP_CLIENT_ID');
    if (!clientId) return { error: 'WhatsApp CLIENT_ID is not configured. Set it in the Config tab first.' };
    extraEnv.CLIENT_ID = clientId;
    delete waQr[id];
  }

  const proc = spawn(process.execPath, [def.entrypoint], {
    env:   { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  // Rotate log file on fresh start
  const lf = logFile(id);
  try { if (fs.existsSync(lf)) fs.unlinkSync(lf); } catch {}
  const ls = openLogStream(id);

  procs[id] = { proc, pid: proc.pid, startTime: new Date(), stoppedAt: null,
                exitCode: null, logStream: ls, recovered: false };
  logs[id]  = [];

  // Write PID file
  try { fs.writeFileSync(pidFile(id), String(proc.pid)); } catch {}

  appendLog(id, 'system', `[${def.name}] started (pid ${proc.pid})`);

  // Put agents in their own process group so restarting the UI/API server does
  // not SIGINT/SIGTERM long-running analysis jobs. Recovery on the next server
  // boot uses the PID file above and a ps scan fallback.
  proc.unref();

  proc.stdout.on('data', d => {
    const text = d.toString();
    // Capture WhatsApp QR codes emitted as [WA_QR]<data>
    const qrMatch = text.match(/\[WA_QR\]([^\n]+)/);
    if (qrMatch) {
      waQr[id] = { data: qrMatch[1].trim(), ts: new Date() };
    }
    // Clear QR once authenticated
    if (text.includes('[wa] ready') || text.includes('[wa] authenticated')) {
      delete waQr[id];
    }
    appendLog(id, 'stdout', d);
  });
  proc.stderr.on('data', d => appendLog(id, 'stderr', d));

  proc.on('exit', code => {
    appendLog(id, 'system', `[${def.name}] process exited (code ${code ?? '?'})`);
    delete waQr[id];
    if (procs[id]) {
      procs[id].exitCode  = code;
      procs[id].proc      = null;
      procs[id].stoppedAt = new Date();
      procs[id].recovered = false;
      try { procs[id].logStream?.end(); } catch {}
      procs[id].logStream = null;
    }
    // Remove PID file
    try { fs.unlinkSync(pidFile(id)); } catch {}
  });

  return { pid: proc.pid };
}

function stopAgent(id) {
  const entry = procs[id];
  if (!entry) return { error: 'Not running' };
  if (entry.recovered) {
    // Kill the external process
    try {
      process.kill(entry.pid, 'SIGINT');
      appendLog(id, 'system', `[${AGENTS[id].name}] SIGINT sent to pid ${entry.pid}`);
      procs[id].recovered = false;
      procs[id].stoppedAt = new Date();
      try { fs.unlinkSync(pidFile(id)); } catch {}
      return { ok: true };
    } catch (e) {
      return { error: `Could not signal process: ${e.message}` };
    }
  }
  if (!entry.proc) return { error: 'Not running' };
  entry.proc.kill('SIGINT');
  return { ok: true };
}

function agentStatus(id) {
  const entry = procs[id];
  if (!entry) return 'idle';
  // Recovered (external) process: re-verify it's still alive
  if (entry.recovered) {
    if (isPidAlive(entry.pid)) return 'running';
    // Process died without us knowing
    procs[id].recovered = false;
    procs[id].stoppedAt = new Date();
    try { fs.unlinkSync(pidFile(id)); } catch {}
    return 'stopped';
  }
  if (entry.proc)              return 'running';
  if (entry.exitCode === 0)    return 'stopped';
  if (entry.exitCode !== null) return 'error';
  return 'idle';
}

// ── DB stats ──────────────────────────────────────────────────────────────────

async function emailStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                                    AS total,
        COUNT(*) FILTER (WHERE e.created_at > NOW() - INTERVAL '24h') AS today,
        MAX(a.last_synced_at)                                       AS last_sync
      FROM email.emails e
      JOIN email.accounts a ON a.id = e.account_id
    `);
    return rows[0];
  } catch { return null; }
}

async function limitlessStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                                      AS total,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24h')  AS today,
        MAX(created_at)                                               AS last_fetch,
        COUNT(*) FILTER (WHERE processed = FALSE)                     AS pending
      FROM limitless.lifelogs
    `);
    return rows[0];
  } catch { return null; }
}

async function projectsStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                          AS total_projects,
        COUNT(*) FILTER (WHERE status = 'active')        AS active_projects,
        COUNT(*) FILTER (WHERE status = 'stalled')       AS stalled_projects
      FROM projects.projects
      WHERE is_archived = FALSE
    `);
    const { rows: runRows } = await db.query(`
      SELECT started_at AS last_analysis_at, status AS analysis_status
      FROM projects.analysis_runs
      ORDER BY started_at DESC LIMIT 1
    `);
    return {
      ...rows[0],
      ...(runRows[0] || { last_analysis_at: null, analysis_status: 'never' }),
    };
  } catch { return null; }
}

async function relationshipsStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE NOT is_noise)                                              AS total_contacts,
        COUNT(*) FILTER (WHERE relationship_strength = 'strong'  AND NOT is_noise)       AS strong_contacts,
        COUNT(*) FILTER (WHERE relationship_strength = 'moderate' AND NOT is_noise)      AS moderate_contacts
      FROM relationships.contacts
    `);
    const { rows: insightRows } = await db.query(`
      SELECT
        COUNT(*)                                                                          AS total_insights,
        COUNT(*) FILTER (WHERE NOT is_actioned AND NOT is_dismissed)                     AS pending_insights
      FROM relationships.insights
    `);
    const { rows: runRows } = await db.query(`
      SELECT started_at AS last_analysis_at, status AS analysis_status
      FROM relationships.analysis_runs
      ORDER BY started_at DESC LIMIT 1
    `);
    return {
      ...rows[0],
      ...insightRows[0],
      ...(runRows[0] || { last_analysis_at: null, analysis_status: 'never' }),
    };
  } catch { return null; }
}

async function researchStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(DISTINCT contact_id) AS enriched_contacts,
        MAX(researched_at) AS last_research_at,
        COUNT(*) FILTER (WHERE researched_at > NOW() - INTERVAL '24 hours') AS researched_today
      FROM relationships.contact_research
    `);
    return rows[0];
  } catch { return null; }
}

async function aiStats(provider) {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                                    AS total_conversations,
        SUM(message_count)                                          AS total_messages,
        MAX(imported_at)                                            AS last_import
      FROM ai.conversations
      WHERE provider = $1
    `, [provider]);
    const { rows: syncRows } = await db.query(`
      SELECT started_at, status, conversations_imported, messages_imported
      FROM ai.sync_log
      WHERE provider = $1
      ORDER BY started_at DESC LIMIT 1
    `, [provider]);
    return { ...rows[0], ...(syncRows[0] || {}) };
  } catch { return null; }
}

async function whatsappStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                                 AS total_messages,
        COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24h')    AS today,
        MAX(ts)                                                  AS last_message_at
      FROM public.messages
    `);
    return rows[0];
  } catch { return null; }
}

async function appleContactsStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE apple_contact_id IS NOT NULL)                               AS total_synced,
        COUNT(*) FILTER (WHERE apple_contact_id IS NOT NULL AND first_interaction_at IS NULL) AS no_comms,
        MAX(updated_at) FILTER (WHERE apple_contact_id IS NOT NULL)                        AS last_sync_at
      FROM relationships.contacts
    `);
    return rows[0];
  } catch { return null; }
}

// ── Config helpers ────────────────────────────────────────────────────────────

/**
 * Extract the numbered GMAIL_EMAIL_N / GMAIL_APP_PASSWORD_N pairs from env.
 * Returns [{ email, app_password }] — at least one (possibly empty) entry.
 */
function readGmailAccounts(env) {
  const accounts = [];
  let i = 1;
  while (env[`GMAIL_EMAIL_${i}`] !== undefined || i === 1) {
    const email    = env[`GMAIL_EMAIL_${i}`]        || '';
    const password = env[`GMAIL_APP_PASSWORD_${i}`] || '';
    if (!email && !password && i > 1) break;
    accounts.push({ email, app_password: password });
    i++;
    if (i > 10) break; // safety cap
  }
  return accounts;
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/api/observe', createObserveRouter(db));

// ── Media serving ─────────────────────────────────────────────────────────────
app.get('/api/media/wa/:msgId', async (req, res) => {
  try {
    const msgId = decodeURIComponent(req.params.msgId)
    const { rows } = await db.query(
      'SELECT file_path, mime_type FROM public.media_files WHERE wa_msg_id = $1',
      [msgId]
    )
    if (!rows.length) return res.status(404).json({ error: 'not found' })
    const { file_path, mime_type } = rows[0]
    const fs = require('fs')
    if (!fs.existsSync(file_path)) return res.status(404).json({ error: 'file not found on disk' })
    res.setHeader('Content-Type', mime_type || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(file_path)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/agents
app.get('/api/agents', async (req, res) => {
  const [eStats, lStats, rStats, pStats, oaiStats, gemStats, rsStats, waStats, acStats] = await Promise.all([
    emailStats(), limitlessStats(), relationshipsStats(), projectsStats(),
    aiStats('openai'), aiStats('gemini'), researchStats(), whatsappStats(), appleContactsStats(),
  ]);
  const result = {};

  for (const [id, def] of Object.entries(AGENTS)) {
    const entry  = procs[id] || {};
    const status = agentStatus(id);
    result[id] = {
      id,
      name:        def.name,
      description: def.description,
      status,
      pid:         entry.pid || null,
      startTime:   entry.startTime  || null,
      stoppedAt:   entry.stoppedAt  || null,
      exitCode:    entry.exitCode   ?? null,
      stats:          id === 'email'          ? eStats
                    : id === 'limitless'      ? lStats
                    : id === 'relationships'  ? rStats
                    : id === 'projects'       ? pStats
                    : id === 'openai'         ? oaiStats
                    : id === 'gemini'         ? gemStats
                    : id === 'research'       ? rsStats
                    : id === 'whatsapp'       ? waStats
                    : id === 'apple-contacts' ? acStats
                    : null,
      nativeAvailable: def.nativeAvailable ?? null,
    };
  }

  res.json(result);
});

// GET /api/agents/:id/logs
app.get('/api/agents/:id/logs', (req, res) => {
  const { id }   = req.params;
  const since    = req.query.since ? new Date(req.query.since) : null;
  if (!logs[id]) return res.status(404).json({ error: 'Unknown agent' });

  // For recovered agents, merge file logs into memory buffer if not already done
  if (procs[id]?.recovered && logs[id].length === 0) {
    logs[id] = readLogFile(id);
  }

  const buf      = logs[id];
  const filtered = since ? buf.filter(l => new Date(l.ts) > since) : buf;
  res.json({ logs: filtered });
});

// POST /api/agents/:id/start
app.post('/api/agents/:id/start', async (req, res) => {
  const result = await startAgent(req.params.id);
  if (result?.error) return res.status(400).json(result);
  res.json(result || { ok: true });
});

// GET /api/agents/:id/qr  — latest WhatsApp QR code data (null if not waiting)
app.get('/api/agents/:id/qr', (req, res) => {
  const qr = waQr[req.params.id];
  res.json({ qr: qr?.data || null, ts: qr?.ts || null });
});

// POST /api/agents/:id/stop
app.post('/api/agents/:id/stop', (req, res) => {
  const result = stopAgent(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// POST /api/agents/:id/import  — one-shot file import for openai/gemini
// POST /api/agents/apple-contacts/import  — accepts raw .vcf text
app.post('/api/agents/apple-contacts/import', express.text({ type: ['text/vcard', 'text/x-vcard', 'text/plain'], limit: '10mb' }), async (req, res) => {
  try {
    const vcfText = req.body;
    if (!vcfText || typeof vcfText !== 'string') {
      return res.status(400).json({ error: 'Request body must be a .vcf text file' });
    }
    const { parseVcf }     = require('../agents/apple-contacts/services/vcfParser');
    const { syncContacts } = require('../agents/apple-contacts/services/syncer');
    const contacts = parseVcf(vcfText);
    if (!contacts.length) {
      return res.status(400).json({ error: 'No valid vCard records found in the uploaded file' });
    }
    const result = await syncContacts(contacts);
    res.json(result);
  } catch (err) {
    console.error('[apple-contacts import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/import', express.json({ limit: '200mb' }), async (req, res) => {
  const { id } = req.params;
  if (!['openai', 'gemini'].includes(id)) {
    return res.status(400).json({ error: 'import only supported for openai and gemini agents' });
  }
  try {
    const service = require(`../agents/ai/services/${id}`);
    const result = await service.importConversationsFromData(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config — secrets are redacted; POST /api/config accepts new values
app.get('/api/config', (req, res) => {
  const env = readEnv();
  const redact = v => v ? '[REDACTED]' : '';
  const rawAccounts = readGmailAccounts(env);
  const safeAccounts = rawAccounts.map(a => ({
    email:        a.email,
    app_password: redact(a.app_password),
  }));
  res.json({
    email: {
      gmail_accounts: safeAccounts,
      BATCH_SIZE:     env.BATCH_SIZE  || '50',
      MAILBOX:        env.MAILBOX     || 'INBOX',
    },
    limitless: {
      LIMITLESS_API_KEY:        redact(env.LIMITLESS_API_KEY),
      FETCH_INTERVAL_CRON:      env.FETCH_INTERVAL_CRON      || '*/5 * * * *',
      PROCESS_INTERVAL_CRON:    env.PROCESS_INTERVAL_CRON    || '*/1 * * * *',
      FETCH_DAYS:               env.FETCH_DAYS               || '1',
      PROCESSING_BATCH_SIZE:    env.PROCESSING_BATCH_SIZE    || '15',
      AI_PROVIDER:           env.AI_PROVIDER           || 'anthropic',
      ANTHROPIC_API_KEY:     redact(env.ANTHROPIC_API_KEY),
      OPENAI_API_KEY:        redact(env.OPENAI_API_KEY),
      AI_ANTHROPIC_MODEL:    env.AI_ANTHROPIC_MODEL    || '',
      AI_OPENAI_MODEL:       env.AI_OPENAI_MODEL       || '',
      AI_CLAUDE_CLI_MODEL:   env.AI_CLAUDE_CLI_MODEL   || '',
    },
    OPENAI_EXPORT_PATH:           env.OPENAI_EXPORT_PATH           || '',
    GEMINI_EXPORT_PATH:           env.GEMINI_EXPORT_PATH           || '',
    AI_WATCH_INTERVAL_MINUTES:    env.AI_WATCH_INTERVAL_MINUTES    || '',
  });
});

// GET /api/system/config  — read keys from system.config (secrets redacted)
app.get('/api/system/config', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const SECRET_PATTERN = /key|token|password|secret/i;
    const { rows } = await db.query(`SELECT key, value FROM system.config ORDER BY key`);
    const config = {};
    for (const r of rows) {
      config[r.key] = SECRET_PATTERN.test(r.key)
        ? (r.value ? '[REDACTED]' : '')
        : r.value;
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/system/config  — write keys to system.config
app.put('/api/system/config', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'body must be object' });
  }
  try {
    const { setConfig } = require('../agents/shared/config');
    for (const [key, value] of Object.entries(updates)) {
      await setConfig(`system.${key}`, value);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config  { agent, updates }
app.post('/api/config', (req, res) => {
  const { agent, updates } = req.body;
  if (!agent || !updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
    const envUpdates = {};

    if (agent === 'email') {
      // Flatten gmail_accounts array back to numbered env vars
      if (Array.isArray(updates.gmail_accounts)) {
        // First clear any extras beyond new count (up to 10)
        for (let i = updates.gmail_accounts.length + 1; i <= 10; i++) {
          envUpdates[`GMAIL_EMAIL_${i}`]        = null;
          envUpdates[`GMAIL_APP_PASSWORD_${i}`] = null;
        }
        updates.gmail_accounts.forEach((acc, idx) => {
          const n = idx + 1;
          envUpdates[`GMAIL_EMAIL_${n}`]        = acc.email        || null;
          envUpdates[`GMAIL_APP_PASSWORD_${n}`] = acc.app_password || null;
        });
      }
      if (updates.BATCH_SIZE  != null) envUpdates.BATCH_SIZE  = updates.BATCH_SIZE;
      if (updates.MAILBOX     != null) envUpdates.MAILBOX     = updates.MAILBOX;
    }

    if (agent === 'limitless') {
      const keys = ['LIMITLESS_API_KEY', 'FETCH_INTERVAL_CRON', 'PROCESS_INTERVAL_CRON',
                    'FETCH_DAYS', 'PROCESSING_BATCH_SIZE', 'AI_PROVIDER',
                    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
                    'AI_ANTHROPIC_MODEL', 'AI_OPENAI_MODEL', 'AI_CLAUDE_CLI_MODEL'];
      for (const k of keys) {
        if (updates[k] != null) envUpdates[k] = updates[k];
      }
    }

    if (agent === 'openai') {
      if (updates.OPENAI_EXPORT_PATH        != null) envUpdates.OPENAI_EXPORT_PATH        = updates.OPENAI_EXPORT_PATH;
      if (updates.AI_WATCH_INTERVAL_MINUTES != null) envUpdates.AI_WATCH_INTERVAL_MINUTES = updates.AI_WATCH_INTERVAL_MINUTES;
    }

    if (agent === 'gemini') {
      if (updates.GEMINI_EXPORT_PATH        != null) envUpdates.GEMINI_EXPORT_PATH        = updates.GEMINI_EXPORT_PATH;
      if (updates.AI_WATCH_INTERVAL_MINUTES != null) envUpdates.AI_WATCH_INTERVAL_MINUTES = updates.AI_WATCH_INTERVAL_MINUTES;
    }

    writeEnv(envUpdates);
    dotenv.config({ path: ENV_PATH, override: true });

    res.json({ ok: true, needsRestart: !!procs[agent]?.proc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Relationships API ─────────────────────────────────────────────────────────

// GET /api/relationships/contacts
app.get('/api/relationships/contacts', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { search, type } = req.query;
    const conditions = ['NOT is_noise'];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(display_name ILIKE $${params.length} OR company ILIKE $${params.length} OR summary ILIKE $${params.length})`);
    }
    if (type) {
      params.push(type);
      conditions.push(`relationship_type = $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT id, display_name, company, job_title, relationship_type,
             relationship_strength, summary, tags, last_interaction_at, first_interaction_at,
             avatar_data
      FROM relationships.contacts
      ${where}
      ORDER BY last_interaction_at DESC NULLS LAST
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/relationships/contacts/:id
app.get('/api/relationships/contacts/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows: contacts } = await db.query(
      'SELECT * FROM relationships.contacts WHERE id = $1',
      [req.params.id]
    );
    if (!contacts.length) return res.status(404).json({ error: 'Not found' });

    const { rows: comms } = await db.query(`
      SELECT id, source, direction, content_snippet, subject,
             chat_id, is_group, group_name, is_read, is_replied, occurred_at, metadata
      FROM relationships.communications
      WHERE contact_id = $1
      ORDER BY occurred_at DESC
      LIMIT 50
    `, [req.params.id]);

    res.json({ ...contacts[0], communications: comms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/relationships/insights
app.get('/api/relationships/insights', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { type, priority } = req.query;
    const actioned  = req.query.actioned  === 'true';
    const dismissed = req.query.dismissed === 'true';

    const conditions = [];
    const params = [];

    if (!actioned)  { conditions.push('NOT is_actioned'); }
    if (!dismissed) { conditions.push('NOT is_dismissed'); }
    if (type) {
      const types = type.split(',').map(t => t.trim()).filter(Boolean)
      if (types.length === 1) {
        params.push(types[0])
        conditions.push(`insight_type = $${params.length}`)
      } else {
        params.push(types)
        conditions.push(`insight_type = ANY($${params.length})`)
      }
    }
    if (priority) { params.push(priority); conditions.push(`priority = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT i.id, i.contact_id, c.display_name AS contact_name,
             i.insight_type, i.title, i.description,
             i.priority, i.source_refs, i.is_actioned, i.is_dismissed, i.created_at
      FROM relationships.insights i
      LEFT JOIN relationships.contacts c ON c.id = i.contact_id
      ${where}
      ORDER BY
        CASE i.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        i.created_at DESC
      LIMIT 100
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/relationships/insights/:id/action
app.post('/api/relationships/insights/:id/action', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    await db.query(
      'UPDATE relationships.insights SET is_actioned = true, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/relationships/insights/:id/dismiss
app.post('/api/relationships/insights/:id/dismiss', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    await db.query(
      'UPDATE relationships.insights SET is_dismissed = true, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function parsePositiveIntQuery(value, fallback, max) {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(String(value))) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null
  return Math.min(parsed, max)
}

// GET /api/intelligence/graph/summary — entity graph readiness summary
app.get('/api/intelligence/graph/summary', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM intelligence.organizations) AS organizations,
        (SELECT COUNT(*)::int FROM intelligence.entity_aliases) AS entity_aliases,
        (SELECT COUNT(*)::int FROM intelligence.contact_organizations) AS contact_organizations,
        (SELECT COUNT(*)::int FROM intelligence.topics) AS topics,
        (SELECT COUNT(*)::int FROM intelligence.object_topics) AS object_topics,
        (SELECT COUNT(*)::int FROM relationships.contacts WHERE relationship_tier IS NOT NULL) AS tiered_contacts,
        (SELECT COUNT(*)::int FROM relationships.contacts WHERE next_suggested_touch_at IS NOT NULL) AS contacts_with_next_touch
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/contact-tiers/summary — audit relationship tiering quality
app.get('/api/intelligence/contact-tiers/summary', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows: byTier } = await db.query(`
      SELECT COALESCE(relationship_tier, 'unknown') AS relationship_tier,
             COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE next_suggested_touch_at IS NOT NULL)::int AS with_next_touch,
             COUNT(*) FILTER (WHERE next_suggested_touch_at < NOW())::int AS overdue,
             ROUND(AVG(strategic_importance_score)::numeric, 2) AS avg_strategic_importance_score
      FROM relationships.contacts
      GROUP BY COALESCE(relationship_tier, 'unknown')
      ORDER BY CASE COALESCE(relationship_tier, 'unknown')
        WHEN 'tier_1' THEN 1 WHEN 'tier_2' THEN 2 WHEN 'tier_3' THEN 3 WHEN 'unknown' THEN 4 WHEN 'noise' THEN 5 ELSE 6 END
    `);
    const { rows: topTier1 } = await db.query(`
      SELECT id, display_name, company, job_title, relationship_type, relationship_strength,
             relationship_tier, strategic_importance_score, preferred_cadence_days,
             dormant_threshold_days, last_interaction_at, next_suggested_touch_at,
             CASE WHEN next_suggested_touch_at < NOW() THEN EXTRACT(DAYS FROM NOW() - next_suggested_touch_at)::int ELSE 0 END AS days_overdue,
             COALESCE((SELECT ARRAY_AGG(key) FROM JSONB_OBJECT_KEYS(COALESCE(manual_overrides, '{}'::jsonb)) AS key), '{}') AS manual_override_fields
      FROM relationships.contacts
      WHERE relationship_tier = 'tier_1'
      ORDER BY strategic_importance_score DESC NULLS LAST, last_interaction_at DESC NULLS LAST
      LIMIT 25
    `);
    const { rows: overdue } = await db.query(`
      SELECT id, display_name, company, job_title, relationship_type, relationship_strength,
             relationship_tier, strategic_importance_score, preferred_cadence_days,
             dormant_threshold_days, last_interaction_at, next_suggested_touch_at,
             EXTRACT(DAYS FROM NOW() - next_suggested_touch_at)::int AS days_overdue,
             COALESCE((SELECT ARRAY_AGG(key) FROM JSONB_OBJECT_KEYS(COALESCE(manual_overrides, '{}'::jsonb)) AS key), '{}') AS manual_override_fields
      FROM relationships.contacts
      WHERE next_suggested_touch_at < NOW()
        AND relationship_tier IN ('tier_1','tier_2')
      ORDER BY relationship_tier ASC, days_overdue DESC, strategic_importance_score DESC NULLS LAST
      LIMIT 25
    `);
    res.json({ by_tier: byTier, top_tier_1: topTier1, overdue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/contact-tiers — inspect contacts by tier/overdue state
app.get('/api/intelligence/contact-tiers', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 50, 200);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const params = [];
    const conditions = [];
    const tier = String(req.query.tier || '').trim();
    if (tier && tier !== 'all') {
      params.push(tier);
      conditions.push(`relationship_tier = $${params.length}`);
    }
    if (String(req.query.overdue || '').toLowerCase() === 'true') {
      conditions.push(`next_suggested_touch_at < NOW()`);
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim().toLowerCase()}%`);
      conditions.push(`(LOWER(display_name) LIKE $${params.length} OR LOWER(COALESCE(company, '')) LIKE $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await db.query(`
      SELECT id, display_name, company, job_title, relationship_type, relationship_strength,
             relationship_tier, strategic_importance_score, preferred_cadence_days,
             dormant_threshold_days, intro_sensitivity, last_interaction_at, next_suggested_touch_at,
             CASE WHEN next_suggested_touch_at < NOW() THEN EXTRACT(DAYS FROM NOW() - next_suggested_touch_at)::int ELSE 0 END AS days_overdue,
             COALESCE((SELECT ARRAY_AGG(key) FROM JSONB_OBJECT_KEYS(COALESCE(manual_overrides, '{}'::jsonb)) AS key), '{}') AS manual_override_fields
      FROM relationships.contacts
      ${where}
      ORDER BY
        CASE relationship_tier WHEN 'tier_1' THEN 1 WHEN 'tier_2' THEN 2 WHEN 'tier_3' THEN 3 WHEN 'unknown' THEN 4 WHEN 'noise' THEN 5 ELSE 6 END,
        COALESCE(next_suggested_touch_at, 'infinity'::timestamptz) ASC,
        strategic_importance_score DESC NULLS LAST,
        last_interaction_at DESC NULLS LAST
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/organizations — organization/entity graph surface
app.get('/api/intelligence/organizations', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 50, 200);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const params = [];
    const conditions = [];
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim().toLowerCase()}%`);
      conditions.push(`(LOWER(o.name) LIKE $${params.length} OR LOWER(COALESCE(o.domain, '')) LIKE $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await db.query(`
      SELECT o.*,
             COALESCE(co.contact_count, 0)::int AS contact_count,
             COALESCE(co.key_contacts, '[]'::json) AS key_contacts
      FROM intelligence.organizations o
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS contact_count,
               JSON_AGG(JSON_BUILD_OBJECT('id', c.id, 'name', c.display_name, 'role', x.role) ORDER BY c.display_name) FILTER (WHERE c.id IS NOT NULL) AS key_contacts
        FROM intelligence.contact_organizations x
        LEFT JOIN relationships.contacts c ON c.id = x.contact_id
        WHERE x.organization_id = o.id
      ) co ON true
      ${where}
      ORDER BY o.strategic_importance_score DESC NULLS LAST, contact_count DESC, o.name ASC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/topics — global topic ontology surface
app.get('/api/intelligence/topics', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 50, 200);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const params = [];
    const conditions = [];
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim().toLowerCase()}%`);
      conditions.push(`LOWER(t.name) LIKE $${params.length}`);
    }
    if (req.query.type) {
      params.push(req.query.type);
      conditions.push(`t.topic_type = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await db.query(`
      SELECT t.*,
             COALESCE(ot.link_count, 0)::int AS link_count
      FROM intelligence.topics t
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS link_count
        FROM intelligence.object_topics ot
        WHERE ot.topic_id = t.id
      ) ot ON true
      ${where}
      ORDER BY t.strategic_weight DESC NULLS LAST, link_count DESC, t.name ASC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/signals/summary — weak signal readiness counts
app.get('/api/intelligence/signals/summary', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows: scalarRows } = await db.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE occurred_at >= NOW() - INTERVAL '7 days')::int AS last_7d,
        COUNT(*) FILTER (WHERE confidence >= 0.70)::int AS high_confidence,
        COUNT(DISTINCT signal_type)::int AS signal_types,
        COUNT(DISTINCT contact_id) FILTER (WHERE contact_id IS NOT NULL)::int AS linked_contacts,
        COUNT(DISTINCT project_id) FILTER (WHERE project_id IS NOT NULL)::int AS linked_projects
      FROM intelligence.signals
    `);
    const { rows: typeRows } = await db.query(`
      SELECT signal_type, COUNT(*)::int AS count
      FROM intelligence.signals
      GROUP BY signal_type
      ORDER BY count DESC, signal_type ASC
    `);
    res.json({ ...scalarRows[0], by_type: typeRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/signals/recent — inspect recent weak signals without promoting them
app.get('/api/intelligence/signals/recent', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 25, 100);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const params = [];
    const conditions = [];
    if (req.query.type) {
      params.push(req.query.type);
      conditions.push(`s.signal_type = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const { rows } = await db.query(`
      SELECT s.id, s.signal_type, s.title, s.description, s.occurred_at,
             s.confidence, s.strength, s.source_table, s.source_id, s.source_ref,
             s.contact_id, c.display_name AS contact_name,
             s.project_id, p.name AS project_name,
             s.created_at, s.updated_at
      FROM intelligence.signals s
      LEFT JOIN relationships.contacts c ON c.id = s.contact_id
      LEFT JOIN projects.projects p ON p.id = s.project_id
      ${where}
      ORDER BY COALESCE(s.occurred_at, s.updated_at, s.created_at) DESC NULLS LAST, s.id DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/opportunities — first-class opportunity ledger
app.get('/api/intelligence/opportunities', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 50, 200);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const status = req.query.status || 'open';
    const params = [];
    const conditions = [];

    if (status !== 'all') {
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }
    if (req.query.type) {
      params.push(req.query.type);
      conditions.push(`o.opportunity_type = $${params.length}`);
    }
    if (req.query.contact_id) {
      const contactId = parsePositiveIntQuery(req.query.contact_id, null, Number.MAX_SAFE_INTEGER);
      if (contactId === null) return res.status(400).json({ error: 'Invalid contact_id' });
      params.push(contactId);
      conditions.push(`EXISTS (
        SELECT 1 FROM intelligence.opportunity_contacts oc
        WHERE oc.opportunity_id = o.id AND oc.contact_id = $${params.length}
      )`);
    }
    if (req.query.project_id) {
      const projectId = parsePositiveIntQuery(req.query.project_id, null, Number.MAX_SAFE_INTEGER);
      if (projectId === null) return res.status(400).json({ error: 'Invalid project_id' });
      params.push(projectId);
      conditions.push(`EXISTS (
        SELECT 1 FROM intelligence.opportunity_projects op
        WHERE op.opportunity_id = o.id AND op.project_id = $${params.length}
      )`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);

    const { rows } = await db.query(`
      SELECT o.*,
             c.display_name AS primary_contact_name,
             p.name AS primary_project_name,
             COALESCE(ev.evidence_count, 0)::int AS evidence_count,
             ev.first_occurred_at AS source_first_seen_at,
             ev.last_occurred_at AS source_last_seen_at,
             GREATEST(0,
               COALESCE(o.expected_value_score, CASE o.priority WHEN 'high' THEN 80 WHEN 'low' THEN 30 ELSE 55 END)
               + CASE WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) >= NOW() - INTERVAL '3 days' THEN 8
                      WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) >= NOW() - INTERVAL '7 days' THEN 4
                      ELSE 0 END
               + CASE WHEN o.confidence >= 0.80 THEN 5 WHEN o.confidence <= 0.40 THEN -8 ELSE 0 END
               + CASE WHEN COALESCE(ev.evidence_count, 0) >= 3 THEN 4 WHEN COALESCE(ev.evidence_count, 0) = 2 THEN 1 ELSE 0 END
               - CASE WHEN LOWER(o.title) LIKE 're-engage %' THEN 25 ELSE 0 END
               - CASE WHEN COALESCE(ev.evidence_count, 0) = 0 THEN 30 WHEN COALESCE(ev.evidence_count, 0) = 1 THEN 12 ELSE 0 END
               - CASE WHEN COALESCE(ev.evidence_count, 0) = 1 AND COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '14 days' THEN 15 ELSE 0 END
               - CASE WHEN o.opportunity_type = 'group_opportunity' AND COALESCE(ev.evidence_count, 0) < 2 THEN 16 ELSE 0 END
               - CASE WHEN o.opportunity_type = 'group_opportunity' AND o.primary_contact_id IS NULL AND o.primary_project_id IS NULL THEN 8 ELSE 0 END
               - CASE WHEN NULLIF(TRIM(COALESCE(o.recommended_next_action, '')), '') IS NULL THEN 8 ELSE 0 END
               - CASE WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '90 days' THEN 40
                      WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '30 days' THEN 25
                      WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '14 days' THEN 8
                      ELSE 0 END
               - CASE WHEN o.opportunity_type = 'risk' AND COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '14 days' THEN 12 ELSE 0 END
             )::numeric(8,2) AS attention_score,
             ARRAY_REMOVE(ARRAY[
               CASE WHEN COALESCE(ev.evidence_count, 0) = 0 THEN 'no_evidence' END,
               CASE WHEN COALESCE(ev.evidence_count, 0) = 1 THEN 'single_evidence' END,
               CASE WHEN COALESCE(ev.evidence_count, 0) = 1 AND COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '14 days' THEN 'old_single_evidence' END,
               CASE WHEN o.opportunity_type = 'group_opportunity' AND COALESCE(ev.evidence_count, 0) < 2 THEN 'group_single_evidence' END,
               CASE WHEN o.opportunity_type = 'group_opportunity' AND o.primary_contact_id IS NULL AND o.primary_project_id IS NULL THEN 'unlinked_group_opportunity' END,
               CASE WHEN LOWER(o.title) LIKE 're-engage %' THEN 'generic_reengage' END,
               CASE WHEN NULLIF(TRIM(COALESCE(o.recommended_next_action, '')), '') IS NULL THEN 'missing_next_action' END,
               CASE WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '90 days' THEN 'very_stale'
                    WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '30 days' THEN 'stale'
                    WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '14 days' THEN 'aging' END,
               CASE WHEN o.opportunity_type = 'risk' AND COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) < NOW() - INTERVAL '14 days' THEN 'archival_risk' END,
               CASE WHEN COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) >= NOW() - INTERVAL '3 days' THEN 'recent_source' END
             ], NULL)::text[] AS quality_flags
      FROM intelligence.opportunities o
      LEFT JOIN relationships.contacts c ON c.id = o.primary_contact_id
      LEFT JOIN projects.projects p ON p.id = o.primary_project_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS evidence_count,
               MIN(e.occurred_at) FILTER (WHERE e.occurred_at IS NOT NULL) AS first_occurred_at,
               MAX(e.occurred_at) FILTER (WHERE e.occurred_at IS NOT NULL) AS last_occurred_at
        FROM intelligence.opportunity_evidence e
        WHERE e.opportunity_id = o.id
      ) ev ON true
      ${where}
      ORDER BY
        attention_score DESC NULLS LAST,
        o.expected_value_score DESC NULLS LAST,
        CASE o.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) DESC NULLS LAST,
        o.created_at DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/attention — highest-value open attention items
app.get('/api/intelligence/attention', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 10, 50);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const { rows } = await db.query(`
      SELECT *
      FROM intelligence.attention_queue
      LIMIT $1
    `, [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/things-to-ignore — low expected-value items that should not consume attention
app.get('/api/intelligence/things-to-ignore', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit = parsePositiveIntQuery(req.query.limit, 10, 50);
    if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
    const { rows } = await db.query(`
      SELECT id, item_type, title, description, recommended_next_action, priority,
             opportunity_type, attention_score, quality_flags, source_last_seen_at, last_seen_at,
             CASE
               WHEN 'low_value_admin' = ANY(quality_flags) THEN 'Operational/admin; delegate or ignore unless escalated.'
               WHEN 'generic_next_action' = ANY(quality_flags) THEN 'Action is too generic; needs stronger evidence or a concrete owner.'
               WHEN 'single_evidence' = ANY(quality_flags) THEN 'Only one evidence item; monitor quietly until corroborated.'
               WHEN 'missing_why_now' = ANY(quality_flags) THEN 'No timing case; not worth interrupting yet.'
               ELSE 'Below attention threshold.'
             END AS ignore_reason
      FROM intelligence.attention_queue
      WHERE attention_score < 50
         OR 'low_value_admin' = ANY(quality_flags)
         OR 'generic_next_action' = ANY(quality_flags)
         OR ('single_evidence' = ANY(quality_flags) AND 'recent_source' != ALL(quality_flags))
      ORDER BY
        CASE WHEN 'low_value_admin' = ANY(quality_flags) THEN 0 ELSE 1 END,
        attention_score ASC NULLS FIRST,
        COALESCE(source_last_seen_at, last_seen_at) DESC NULLS LAST
      LIMIT $1
    `, [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/intelligence/opportunities/:id — lifecycle/status/feedback updates
app.patch('/api/intelligence/opportunities/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const allowed = ['status','priority','recommended_next_action','snoozed_until','expires_at','feedback','feedback_note'];
  const updates = {};
  for (const key of allowed) if (key in req.body) updates[key] = req.body[key];
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const validStatuses = new Set(['open','snoozed','actioned','dismissed','expired']);
  const validPriorities = new Set(['high','medium','low']);
  const validFeedback = new Set(['useful','not_useful','false_positive','too_late','too_low_value']);
  if (updates.status && !validStatuses.has(updates.status)) return res.status(400).json({ error: 'Invalid status' });
  if (updates.priority && !validPriorities.has(updates.priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (updates.feedback && !validFeedback.has(updates.feedback)) return res.status(400).json({ error: 'Invalid feedback' });

  const setClauses = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${idx++}`);
    values.push(value);
  }
  if (updates.status === 'actioned') setClauses.push('actioned_at = NOW()');
  if (updates.status === 'dismissed') setClauses.push('dismissed_at = NOW()');
  setClauses.push('updated_at = NOW()');
  values.push(id);

  try {
    const { rows } = await db.query(`
      UPDATE intelligence.opportunities
      SET ${setClauses.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `, values);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/intelligence/opportunities/:id/feedback — append feedback event
app.post('/api/intelligence/opportunities/:id/feedback', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const feedback = req.body?.feedback;
  const note = req.body?.note || null;
  const validFeedback = new Set(['useful','not_useful','false_positive','too_late','too_low_value']);
  if (!feedback) return res.status(400).json({ error: 'feedback is required' });
  if (!validFeedback.has(feedback)) return res.status(400).json({ error: 'Invalid feedback' });

  try {
    const { rows } = await db.query(`
      INSERT INTO intelligence.opportunity_feedback_events (opportunity_id, feedback, note)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [id, feedback, note]);
    await db.query(`
      UPDATE intelligence.opportunities
      SET feedback = $2, feedback_note = COALESCE($3, feedback_note), updated_at = NOW()
      WHERE id = $1
    `, [id, feedback, note]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/intelligence/refresh/status — inspect latest on-demand intelligence refresh
app.get('/api/intelligence/refresh/status', (req, res) => {
  res.json({
    current: intelligenceRefreshState.current,
    last: intelligenceRefreshState.last,
    history: intelligenceRefreshState.history,
  });
});

// POST /api/intelligence/refresh — trigger intelligence pipeline on-demand
app.post('/api/intelligence/refresh', async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database unavailable' });
    if (intelligenceRefreshState.current) {
      return res.status(409).json({
        status: 'already_running',
        run_id: intelligenceRefreshState.current.id,
        current: intelligenceRefreshState.current,
      });
    }

    const { runIntelligenceServices } = require('../agents/intelligence/index.js');
    const run = createIntelligenceRefreshRun(req.body?.trigger || 'api');
    intelligenceRefreshState.current = run;
    appendIntelligenceRefreshLog(run, 'info', 'Refresh queued');

    // Run in background, but expose all logs/status through /api/intelligence/refresh/status.
    setImmediate(async () => {
      try {
        appendIntelligenceRefreshLog(run, 'info', 'Refresh started');
        const result = await runIntelligenceServices(db, {
          log: (level, message, meta) => appendIntelligenceRefreshLog(run, level, message, meta),
        });
        appendIntelligenceRefreshLog(run, 'info', 'Refresh completed', result);
        finishIntelligenceRefreshRun(run, 'completed', result);
      } catch (error) {
        appendIntelligenceRefreshLog(run, 'error', 'Refresh failed', { error: error.message, stack: error.stack });
        finishIntelligenceRefreshRun(run, 'failed', null, error);
      }
    });

    res.json({
      status: 'queued',
      run_id: run.id,
      status_url: '/api/intelligence/refresh/status',
      message: 'Intelligence pipeline queued for execution'
    });
  } catch (error) {
    console.error('[API] Intelligence refresh error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/relationships/stats
app.get('/api/relationships/stats', async (req, res) => {
  const stats = await relationshipsStats();
  if (!stats) return res.status(503).json({ error: 'Database unavailable or schema not initialized' });
  res.json(stats);
});

// GET /api/relationships/run — trigger manual analysis
app.get('/api/relationships/run', (req, res) => {
  const entry = procs['relationships'];
  if (!entry?.proc) {
    return res.status(400).json({ error: 'Relationships agent is not running. Start it first.' });
  }
  res.json({ ok: true, message: 'Analysis runs on the agent\'s schedule. Restart the agent to trigger immediately.' });
});

// PATCH /api/relationships/contacts/:id — update contact fields manually
// Automatically records which fields were manually set so agents won't overwrite them.
// Body may include _clearOverrides: ['field1', 'field2'] to hand those fields back to agents.
app.patch('/api/relationships/contacts/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const allowed = ['display_name','company','job_title','my_role','relationship_type',
                   'relationship_strength','summary','tags','is_noise'];
  const updates = {};
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key];
  }

  const clearOverrides = Array.isArray(req.body._clearOverrides) ? req.body._clearOverrides : [];

  if (!Object.keys(updates).length && !clearOverrides.length) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  // Sync normalized_name whenever display_name changes
  if ('display_name' in updates) {
    updates.normalized_name = (updates.display_name || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  // Build SET clause
  const setClauses = [];
  const values     = [];
  let   idx        = 1;
  for (const [k, v] of Object.entries(updates)) {
    setClauses.push(`${k} = $${idx++}`);
    values.push(v);
  }

  // Record manual overrides for every explicitly-set allowed field
  const overrideFields = Object.keys(updates).filter(k => allowed.includes(k));
  if (overrideFields.length > 0) {
    const now = new Date().toISOString();
    const overrideEntries = {};
    for (const field of overrideFields) {
      overrideEntries[field] = { value: updates[field], set_at: now };
    }
    setClauses.push(`manual_overrides = manual_overrides || $${idx++}`);
    values.push(JSON.stringify(overrideEntries));
  }

  // Remove overrides for fields the caller wants to hand back to agents
  for (const field of clearOverrides) {
    setClauses.push(`manual_overrides = manual_overrides - $${idx++}`);
    values.push(field);
  }

  setClauses.push('updated_at = NOW()');
  values.push(id);

  try {
    const { rows } = await db.query(
      `UPDATE relationships.contacts SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/relationships/contacts/:id/reanalyze — re-run Claude analysis for one contact
app.post('/api/relationships/contacts/:id/reanalyze', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    // Fetch the contact
    const { rows: contactRows } = await db.query('SELECT * FROM relationships.contacts WHERE id = $1', [id]);
    if (!contactRows.length) return res.status(404).json({ error: 'Not found' });
    const contact = contactRows[0];

    // Pull recent messages from WhatsApp and email
    const waJid = (contact.wa_jids || [])[0];
    let messages = [];
    if (waJid) {
      const { rows: msgs } = await db.query(`
        SELECT (data->'id'->>'fromMe')::boolean AS from_me,
               data->>'body' AS body, ts,
               data->'_data'->>'notifyName' AS notify_name
        FROM public.messages
        WHERE chat_id = $1
          AND event IN ('message','message_create','message_historical')
          AND data->>'body' IS NOT NULL AND data->>'body' != ''
        ORDER BY ts DESC LIMIT 25
      `, [waJid]);
      messages = msgs;
    }

    // Pull recent emails if linked
    let emailSnippets = [];
    if ((contact.emails || []).length) {
      const { rows: emails } = await db.query(`
        SELECT subject, date, body_text, attachments FROM email.emails
        WHERE from_address ILIKE $1
        ORDER BY date DESC LIMIT 10
      `, [`%${contact.emails[0]}%`]);
      emailSnippets = emails;
    }

    // Build prompt
    const displayName = contact.display_name || 'Unknown';
    const phone = (contact.wa_jids || [])[0]?.replace('@c.us','') || '';
    const msgSample = messages.slice(0,20).map(m =>
      `[${m.from_me ? 'Me' : displayName}] (${m.ts ? new Date(m.ts).toLocaleDateString() : ''}): ${(m.body||'').slice(0,200)}`
    ).join('\n');
    const emailSample = emailSnippets.slice(0,5).map(e => {
      let line = `Subject: ${e.subject || '(none)'} | ${(e.body_text||'').slice(0,150)}`;
      // Include any extracted attachment text
      const attachments = Array.isArray(e.attachments) ? e.attachments : (e.attachments ? JSON.parse(e.attachments) : []);
      const attachTexts = attachments.filter(a => a.extracted_text).map(a => `[Attachment: ${a.filename || 'file'}] ${a.extracted_text.slice(0,200)}`);
      if (attachTexts.length) line += '\n' + attachTexts.join('\n');
      return line;
    }).join('\n');

    // Build override context so Claude treats manually-confirmed facts as ground truth
    const overrides = contact.manual_overrides || {};
    const overrideKeys = Object.keys(overrides);
    const overrideContext = overrideKeys.length > 0
      ? `\nUser-confirmed facts (treat as ground truth, do not contradict):\n${overrideKeys.map(k => `- ${k}: ${JSON.stringify(overrides[k].value)}`).join('\n')}\n`
      : '';

    const prompt = `You are analyzing a contact from the perspective of the account owner.
Describe who THIS CONTACT IS to the account owner — their role, not the reverse.

Examples of correct perspective:
- Account owner's dentist → relationship_type: "service_provider", my_role: "patient"
- Account owner's investor → relationship_type: "professional_contact", my_role: "founder"
- Account owner's employee → relationship_type: "colleague", my_role: "manager"

Contact: ${displayName}${phone ? ` (+${phone})` : ''}
Existing company: ${contact.company || 'unknown'}
Existing role: ${contact.job_title || 'unknown'}
${overrideContext}
${msgSample ? `Recent WhatsApp messages (newest first):\n${msgSample}` : ''}
${emailSample ? `\nRecent emails:\n${emailSample}` : ''}

Return ONLY valid JSON:
{
  "company": null or "company name",
  "job_title": null or "their role",
  "my_role": null or "account owner's role relative to this contact (e.g. patient, client, mentee)",
  "relationship_type": "family|friend|colleague|client|vendor|service_provider|professional_contact|unknown",
  "relationship_strength": "strong|moderate|weak|noise",
  "summary": "2-3 sentence description of who this person is TO the account owner",
  "tags": ["tag1", "tag2"],
  "is_noise": false
}`;

    const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response  = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0]?.text || '{}';
    const clean = raw.replace(/^```(?:json)?\n?/m,'').replace(/\n?```$/m,'').trim();
    const result = JSON.parse(clean);

    // Persist my_role if returned
    if (result.my_role !== undefined) {
      await db.query(
        `UPDATE relationships.contacts SET my_role = $1, updated_at = NOW() WHERE id = $2`,
        [result.my_role || null, id]
      )
    }

    res.json({
      company:               result.company               ?? null,
      job_title:             result.job_title             ?? null,
      my_role:               result.my_role               ?? null,
      relationship_type:     result.relationship_type     || 'unknown',
      relationship_strength: result.relationship_strength || 'weak',
      summary:               result.summary               || '',
      tags:                  Array.isArray(result.tags) ? result.tags : [],
      is_noise:              Boolean(result.is_noise),
      // Inform the client which fields are locked by manual overrides
      locked_fields:         overrideKeys,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/relationships/contacts/:id/research — trigger on-demand research
app.post('/api/relationships/contacts/:id/research', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const { rows } = await db.query(
    `SELECT id FROM relationships.contacts WHERE id = $1`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  const researchPath = path.resolve(__dirname, '../agents/research/index.js');
  const child = spawn(process.execPath, [researchPath], {
    env: { ...process.env, RESEARCH_CONTACT_ID: String(id) },
    detached: false,
    stdio: 'ignore',
  });
  child.unref();

  res.json({ status: 'queued', contact_id: id });
});

// GET /api/relationships/contacts/:id/research — fetch research results
app.get('/api/relationships/contacts/:id/research', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows: contactRows } = await db.query(
      `SELECT research_summary FROM relationships.contacts WHERE id = $1`,
      [id]
    );
    const { rows: research } = await db.query(`
      SELECT source, query, summary, result_json, researched_name, researched_at
      FROM relationships.contact_research
      WHERE contact_id = $1
      ORDER BY researched_at DESC
    `, [id]);

    res.json({
      research_summary: contactRows[0]?.research_summary || null,
      providers: research,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/relationships/contacts/:id/opportunities — per-contact opportunities
app.get('/api/relationships/contacts/:id/opportunities', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  try {
    const { rows } = await db.query(`
      SELECT i.id, i.insight_type, i.title, i.description,
             i.priority, i.contact_ids, i.is_actioned, i.is_dismissed, i.created_at
      FROM relationships.insights i
      WHERE NOT i.is_actioned AND NOT i.is_dismissed
        AND (
          i.contact_id = $1
          OR i.contact_ids @> ARRAY[$1]::bigint[]
        )
        AND i.insight_type IN ('opportunity', 'cross_source_opportunity', 'project_match')
      ORDER BY
        CASE i.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        i.created_at DESC
      LIMIT 50
    `, [id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Groups API ────────────────────────────────────────────────────────────────

// GET /api/relationships/groups
app.get('/api/relationships/groups', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const type = req.query.type;
    const role = req.query.role;
    const params = [];
    const conditions = ['is_noise = FALSE'];
    if (type) { params.push(type); conditions.push(`group_type = $${params.length}`); }
    if (role) { params.push(role); conditions.push(`my_role = $${params.length}`); }

    const { rows } = await db.query(`
      SELECT id, wa_chat_id, name, group_type, my_role, ai_summary,
             key_topics, communication_advice, notable_contacts, opportunities,
             msg_count, my_msg_count, last_activity_at, analyzed_at, is_noise
      FROM relationships.groups
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE group_type
          WHEN 'board_peers' THEN 1 WHEN 'management' THEN 2
          WHEN 'employees'   THEN 3 WHEN 'community'  THEN 4
          ELSE 5 END,
        last_activity_at DESC NULLS LAST
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/relationships/groups/:id/messages
app.get('/api/relationships/groups/:id/messages', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  try {
    const { rows: group } = await db.query(
      'SELECT wa_chat_id FROM relationships.groups WHERE id = $1', [req.params.id]
    );
    if (!group.length) return res.status(404).json({ error: 'Not found' });

    const { rows } = await db.query(`
      SELECT
        (data->'id'->>'fromMe')::boolean   AS from_me,
        data->>'body'                       AS body,
        msg_type,
        data->'_data'->>'notifyName'        AS notify_name,
        data->'id'->>'participant'          AS participant,
        ts
      FROM public.messages
      WHERE chat_id = $1
        AND event IN ('message','message_create','message_historical')
        AND data->>'body' IS NOT NULL
        AND data->>'body' != ''
      ORDER BY ts DESC
      LIMIT 60
    `, [group[0].wa_chat_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Projects API ──────────────────────────────────────────────────────────────

// GET /api/projects
app.get('/api/projects', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { status, health } = req.query;
    const archived = req.query.archived === 'true';

    const conditions = [`is_archived = ${archived}`];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (health) {
      params.push(health);
      conditions.push(`health = $${params.length}`);
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    const { rows } = await db.query(`
      SELECT
        p.*,
        (SELECT COUNT(*) FROM projects.project_insights pi
         WHERE pi.project_id = p.id AND pi.is_resolved = FALSE) AS open_insights
      FROM projects.projects p
      ${where}
      ORDER BY
        CASE p.health WHEN 'blocked' THEN 1 WHEN 'at_risk' THEN 2 WHEN 'on_track' THEN 3 ELSE 4 END,
        p.last_activity_at DESC NULLS LAST
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/projects/run — trigger new analysis
app.get('/api/projects/run', (req, res) => {
  const entry = procs['projects'];
  if (!entry?.proc) {
    return res.status(400).json({ error: 'Projects agent is not running. Start it first.' });
  }
  res.json({ ok: true, message: 'Analysis runs on the agent\'s schedule. Restart the agent to trigger immediately.' });
});

// GET /api/projects/stats
app.get('/api/projects/stats', async (req, res) => {
  const stats = await projectsStats();
  if (!stats) return res.status(503).json({ error: 'Database unavailable or schema not initialized' });
  res.json(stats);
});

// GET /api/projects/:id
app.get('/api/projects/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows: projects } = await db.query(
      'SELECT * FROM projects.projects WHERE id = $1',
      [req.params.id]
    );
    if (!projects.length) return res.status(404).json({ error: 'Not found' });

    const { rows: comms } = await db.query(`
      SELECT id, source, source_id, content_snippet, subject, occurred_at, relevance_score
      FROM projects.project_communications
      WHERE project_id = $1
      ORDER BY occurred_at DESC NULLS LAST
      LIMIT 50
    `, [req.params.id]);

    const { rows: insights } = await db.query(`
      SELECT id, insight_type, content, priority, is_resolved, created_at
      FROM projects.project_insights
      WHERE project_id = $1
      ORDER BY is_resolved ASC,
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
    `, [req.params.id]);

    res.json({ ...projects[0], communications: comms, insights });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/projects/:id
// Automatically records which fields were manually set so agents won't overwrite them.
// Body may include _clearOverrides: ['field1', 'field2'] to hand those fields back to agents.
app.patch('/api/projects/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB unavailable' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const allowed = ['name','description','status','health','priority','next_action','tags','is_archived'];
  const updates = {};
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key];
  }

  const clearOverrides = Array.isArray(req.body._clearOverrides) ? req.body._clearOverrides : [];

  if (!Object.keys(updates).length && !clearOverrides.length) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const setClauses = [];
  const values     = [];
  let   idx        = 1;
  for (const [k, v] of Object.entries(updates)) {
    setClauses.push(`${k} = $${idx++}`);
    values.push(v);
  }

  // Record manual overrides for every explicitly-set allowed field
  const overrideFields = Object.keys(updates).filter(k => allowed.includes(k));
  if (overrideFields.length > 0) {
    const now = new Date().toISOString();
    const overrideEntries = {};
    for (const field of overrideFields) {
      overrideEntries[field] = { value: updates[field], set_at: now };
    }
    setClauses.push(`manual_overrides = manual_overrides || $${idx++}`);
    values.push(JSON.stringify(overrideEntries));
  }

  // Remove overrides for fields the caller wants to hand back to agents
  for (const field of clearOverrides) {
    setClauses.push(`manual_overrides = manual_overrides - $${idx++}`);
    values.push(field);
  }

  setClauses.push('updated_at = NOW()');
  values.push(id);

  try {
    const { rows } = await db.query(
      `UPDATE projects.projects SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/projects/:id/communications
app.get('/api/projects/:id/communications', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const limit  = parseInt(req.query.limit, 10) || 50;
    const source = req.query.source;
    const params = [req.params.id];
    let sourceClause = '';
    if (source) {
      params.push(source);
      sourceClause = `AND source = $${params.length}`;
    }
    const { rows } = await db.query(`
      SELECT id, source, source_id, content_snippet, subject, occurred_at, relevance_score
      FROM projects.project_communications
      WHERE project_id = $1 ${sourceClause}
      ORDER BY occurred_at DESC NULLS LAST
      LIMIT ${limit}
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/projects/insights/:id/resolve
app.post('/api/projects/insights/:id/resolve', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    await db.query(
      'UPDATE projects.project_insights SET is_resolved = TRUE, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/projects/activity/recent — recent comms across all projects
app.get('/api/projects/activity/recent', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await db.query(`
      SELECT
        pc.id, pc.source, pc.content_snippet, pc.subject, pc.occurred_at,
        p.id AS project_id, p.name AS project_name, p.health AS project_health
      FROM projects.project_communications pc
      JOIN projects.projects p ON p.id = pc.project_id
      WHERE p.is_archived = FALSE
      ORDER BY pc.occurred_at DESC NULLS LAST
      LIMIT 20
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/projects/insights/open — high-priority open insights across all projects
app.get('/api/projects/insights/open', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await db.query(`
      SELECT
        pi.id, pi.insight_type, pi.content, pi.priority, pi.created_at,
        p.id AS project_id, p.name AS project_name
      FROM projects.project_insights pi
      JOIN projects.projects p ON p.id = pi.project_id
      WHERE pi.is_resolved = FALSE
        AND p.is_archived  = FALSE
      ORDER BY
        CASE pi.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        pi.created_at DESC
      LIMIT 30
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Docs / Manual API ─────────────────────────────────────────────────────────

const DOCS_DIR   = path.resolve(__dirname, '../../docs/manual');
const MEDIA_DIR  = path.resolve(__dirname, '../../docs/infographics');

function docTitle(filename, content) {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return filename
    .replace(/\.md$/, '')
    .replace(/^\d+-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

// GET /api/docs  — list all docs in order
app.get('/api/docs', (req, res) => {
  try {
    const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')).sort();
    const docs = files.map(f => {
      const content = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8');
      return { slug: f.replace(/\.md$/, ''), filename: f, title: docTitle(f, content) };
    });
    res.json(docs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/docs/media/:filename  — serve infographic images and videos
app.get('/api/docs/media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // prevent traversal
  const fp = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// GET /api/docs/:slug  — markdown content
app.get('/api/docs/:slug', (req, res) => {
  const filename = req.params.slug + '.md';
  const fp = path.join(DOCS_DIR, filename);
  if (!fp.startsWith(DOCS_DIR)) return res.status(400).end(); // traversal guard
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const content = fs.readFileSync(fp, 'utf8');
  res.json({ slug: req.params.slug, title: docTitle(filename, content), content });
});

// ── Search API ────────────────────────────────────────────────────────────────

// GET /api/search?q=...&limit=20&sources=email,whatsapp,...
app.get('/api/search', async (req, res) => {
  const q       = (req.query.q || '').trim();
  const limit   = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const sources = req.query.sources ? req.query.sources.split(',') : null;

  if (q.length < 2) return res.json({ results: [] });
  if (!db)          return res.status(503).json({ error: 'No database' });

  try {
    const { model: embeddingModel } = await getEmbeddingConfig();
    const vec = await embed(q, 'RETRIEVAL_QUERY');

    let sourceClause = '';
    const params = [embeddingModel, toSql(vec), limit];
    if (sources?.length) {
      params.push(sources);
      sourceClause = `AND source = ANY($${params.length})`;
    }

    const { rows } = await db.query(`
      SELECT
        source,
        source_id,
        content,
        metadata,
        1 - (embedding <=> $2::public.vector) AS similarity
      FROM search.embeddings
      WHERE embedding_model = $1
        AND 1 - (embedding <=> $2::public.vector) > 0.25
      ${sourceClause}
      ORDER BY embedding <=> $2::public.vector
      LIMIT $3
    `, params);

    res.json({ results: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/system/model-catalog', async (req, res) => {
  const providerType = String(req.query.provider_type || '').trim() || null;
  const capability = String(req.query.capability || '').trim() || null;
  const explicitBaseUrl = String(req.query.base_url || '').trim();

  try {
    const { getConfig } = require('../agents/shared/config');
    const providers = await getProviderDefinitions(capability);

    // Handle Ollama provider (live discovery against the local server)
    if (providerType === 'ollama') {
      const baseUrl = explicitBaseUrl || await getConfig('system.OLLAMA_BASE_URL') || DEFAULT_OLLAMA_BASE_URL;
      try {
        const models = await listOllamaModelOptions({ baseUrl, capability });
        return res.json({ providers, models, base_url: baseUrl });
      } catch (error) {
        return res.json({ providers, models: [], base_url: baseUrl, error: error.message });
      }
    }

    // No specific provider requested — caller only wants the provider list.
    if (!providerType) {
      return res.json({ providers, models: [] });
    }

    // Anthropic, OpenAI, and Gemini (embeddings) use their native API key;
    // every other provider (gemini chat, kimi, jina, OpenRouter-discovered
    // providers) needs no app-specific key lookup here.
    const apiKeyConfigByProvider = {
      anthropic: 'system.ANTHROPIC_API_KEY',
      openai: 'system.OPENAI_API_KEY',
      gemini: 'system.GEMINI_API_KEY',
    };
    const apiKeyConfig = apiKeyConfigByProvider[providerType];
    const apiKey = apiKeyConfig ? await getConfig(apiKeyConfig) : null;

    const models = await getAvailableModels({ providerType, apiKey, capability });
    res.json({ providers, models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/search/reindex  — trigger an immediate indexer pass
app.post('/api/search/reindex', async (req, res) => {
  try {
    // fire-and-forget
    indexer.runOnce().catch(e => console.warn('[reindex]', e.message));
    res.json({ ok: true, message: 'Reindex started' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/search/stats — indexed counts, pending queue, and indexer status
app.get('/api/search/stats', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { getConfig } = require('../agents/shared/config')
    const embeddingModel = await getConfig('system.EMBEDDING_MODEL') || 'gemini-embedding-2-preview'
    const pending = await indexer.getPendingCounts(embeddingModel)
    res.json({ sources: pending, indexer: indexer.getStatus(), batchPerRun: indexer.BATCH_PER_RUN });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /api/system — LLM Providers ──────────────────────────────────────────────

app.get('/api/system/providers', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await db.query(`
      SELECT p.*,
        COALESCE(SUM(u.cost_usd) FILTER (WHERE u.created_at >= date_trunc('month', NOW())), 0) AS cost_mtd,
        MAX(u.created_at) AS last_used_at,
        (SELECT u2.error FROM system.llm_usage u2
         WHERE u2.provider_id = p.id AND u2.error IS NOT NULL
         ORDER BY u2.created_at DESC LIMIT 1) AS last_usage_error
      FROM system.llm_providers p
      LEFT JOIN system.llm_usage u ON u.provider_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/providers', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { name, provider_type, api_key, base_url, model } = req.body;
  if (!name || !provider_type) return res.status(400).json({ error: 'name and provider_type required' });
  const normalizedBaseUrl = provider_type === 'ollama'
    ? (base_url || DEFAULT_OLLAMA_BASE_URL)
    : (base_url || null);
  try {
    const { rows } = await db.query(
      `INSERT INTO system.llm_providers (name, provider_type, api_key, base_url, model)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, provider_type, api_key || null, normalizedBaseUrl, model || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/system/providers/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { name, api_key, base_url, model, is_enabled } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE system.llm_providers
       SET name = COALESCE($2, name),
           api_key = COALESCE($3, api_key),
           base_url = COALESCE($4, base_url),
           model = COALESCE($5, model),
           is_enabled = COALESCE($6, is_enabled)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name || null, api_key || null, base_url || null, model || null, is_enabled != null ? is_enabled : null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not found' });
    const { invalidatePriorityCache } = require('../agents/shared/llm');
    invalidatePriorityCache();
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/system/providers/:id', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    await db.query('DELETE FROM system.llm_providers WHERE id = $1', [req.params.id]);
    const { invalidatePriorityCache } = require('../agents/shared/llm');
    invalidatePriorityCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/providers/:id/reset-credits', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    await db.query(
      `UPDATE system.llm_providers
       SET has_credits = true, last_error = NULL, last_error_at = NULL
       WHERE id = $1`,
      [req.params.id]
    );
    const { invalidatePriorityCache } = require('../agents/shared/llm');
    invalidatePriorityCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/system — Agent LLM Priority ─────────────────────────────────────────

app.get('/api/system/agents/:id/llm', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const { rows } = await db.query(`
      SELECT alp.priority, p.id, p.name, p.provider_type, p.model,
             p.is_enabled, p.has_credits, p.last_error
      FROM system.agent_llm_priority alp
      JOIN system.llm_providers p ON p.id = alp.provider_id
      WHERE alp.agent_id = $1
      ORDER BY alp.priority
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/system/agents/:id/llm', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const agentId = req.params.id;
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'body must be array' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM system.agent_llm_priority WHERE agent_id = $1', [agentId]);
    for (const { provider_id, priority } of list) {
      await client.query(
        'INSERT INTO system.agent_llm_priority (agent_id, provider_id, priority) VALUES ($1, $2, $3)',
        [agentId, provider_id, priority]
      );
    }
    await client.query('COMMIT');
    const { invalidatePriorityCache } = require('../agents/shared/llm');
    invalidatePriorityCache(agentId);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── /api/system — Agent Config ────────────────────────────────────────────────

app.get('/api/system/agents/:id/config', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const agentId = req.params.id;
  const schema = ['email', 'limitless', 'projects', 'relationships'].includes(agentId) ? agentId : 'system';
  try {
    const { rows } = await db.query(`SELECT key, value FROM ${schema}.config ORDER BY key`);
    const config = {};
    for (const r of rows) config[r.key] = r.value;
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/system/agents/:id/config', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const agentId = req.params.id;
  const schema = ['email', 'limitless', 'projects', 'relationships'].includes(agentId) ? agentId : 'system';
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'body must be object' });
  }
  try {
    const { setConfig } = require('../agents/shared/config');
    for (const [key, value] of Object.entries(updates)) {
      await setConfig(`${schema}.${key}`, value);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/system — Usage Stats ─────────────────────────────────────────────────

app.get('/api/system/usage', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { group_by = 'provider', since } = req.query;
  const params = since ? [since] : [];
  const sinceClause = since ? 'AND u.created_at >= $1' : '';

  try {
    let sql;
    if (group_by === 'agent') {
      sql = `SELECT agent_id, COUNT(*) AS calls,
               SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
               SUM(cost_usd) AS cost_usd
             FROM system.llm_usage u WHERE 1=1 ${sinceClause}
             GROUP BY agent_id ORDER BY cost_usd DESC NULLS LAST`;
    } else if (group_by === 'day') {
      sql = `SELECT date_trunc('day', created_at) AS day, COUNT(*) AS calls,
               SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
               SUM(cost_usd) AS cost_usd
             FROM system.llm_usage u WHERE 1=1 ${sinceClause}
             GROUP BY 1 ORDER BY 1 DESC`;
    } else {
      sql = `SELECT p.id, p.name, p.provider_type, COUNT(u.id) AS calls,
               SUM(u.tokens_in) AS tokens_in, SUM(u.tokens_out) AS tokens_out,
               SUM(u.cost_usd) AS cost_usd
             FROM system.llm_providers p
             LEFT JOIN system.llm_usage u ON u.provider_id = p.id ${since ? 'AND u.created_at >= $1' : ''}
             GROUP BY p.id ORDER BY cost_usd DESC NULLS LAST`;
    }
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

// Detect agents that survived a server restart
recoverAgents();

async function startServer() {
  if (db) {
    try {
      await runSystemSchema();
      await migrateEnvToDb();
    } catch (err) {
      console.error('[server] startup migration failed:', err.message);
    }
  }

  // Download Chromium for the WhatsApp bridge if not already present (idempotent)
  await ensurePuppeteerChrome();

  const PORT = process.env.UI_PORT || 4001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  secondbrain UI → http://localhost:${PORT}\n`);
    if (db) {
      indexer.start(db);
      observeAlerts.start(db);
    }
  });
}

startServer();

function shutdown() {
  try { observeAlerts.stop(); } catch {}
  try { indexer.stop?.(); } catch {}
  try { db?.end?.(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
