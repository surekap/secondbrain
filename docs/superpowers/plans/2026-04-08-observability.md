# Observability System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trustworthy, loss-aware, causally-linked observability layer to the secondbrain multi-agent system so the operator can determine what is running, which model is being used, how much work is being done, how efficiently, and whether output quality justifies resource cost.

**Architecture:** `@secondbrain/telemetry` SDK instruments all LLM calls and agent progress. A `@secondbrain/telemetry-buffer` package buffers events in-memory and spills to disk on DB failure. A `packages/collector` process replays spilled events. A privileged `packages/sampler` process collects system metrics (CPU/GPU/power via `powermetrics`) and writes to Postgres. A `packages/observe` Express server (port 4002, unprivileged) serves a vanilla-JS dashboard with 5 views.

**Tech Stack:** Node.js 18+, Postgres (`@secondbrain/db`), `node:test` for unit tests, `plist` npm for powermetrics parsing, Express for observe server, vanilla HTML/CSS/JS for dashboard (no build step).

---

## File Map

### New Files

```
packages/telemetry/
  package.json
  index.js            Public API: startRun, endRun, startRequest, progress, recordQuality
  ids.js              generateId() → crypto.randomUUID()
  writer.js           DB write functions (writeBatch, writeSystemSample, updateCounters)
  sampling.js         Sampling policy: shouldStoreFull(event)
  test/sdk.test.js    node:test unit tests

packages/telemetry-buffer/
  package.json
  index.js            In-memory queue + disk spill + drain loop
  test/buffer.test.js

packages/collector/
  package.json
  index.js            Scans spill dir every 30s, replays NDJSON files to DB

packages/sampler/
  package.json
  index.js            Three polling loops (1s/5s/15s)
  powermetrics.js     Spawn/parse persistent powermetrics process
  process-stats.js    Parse `ps aux` for ollama + node processes
  ollama-ps.js        Parse `ollama ps` for loaded models

packages/observe/
  package.json
  server.js           Express API (port 4002) + static serving
  alerts.js           Alert rule evaluator (runs every 30s)
  public/
    index.html        Single-page dashboard shell (tabs, inline CSS)
    app.js            Vanilla JS: fetch API, render 5 views

packages/agents/shared/sql/
  telemetry-schema.sql   All telemetry.* tables + optional TimescaleDB setup
```

### Modified Files

```
package.json                              Add workspaces + scripts
packages/ui/server.js                     Add telemetry-schema.sql to runSystemSchema()
packages/agents/shared/llm.js            Wrap create() with telemetry startRequest/finish
packages/agents/relationships/index.js   Add startRun/progress/endRun
packages/agents/projects/index.js        Add startRun/progress/endRun
packages/agents/limitless/index.js       Add startRun/progress/endRun
packages/agents/email/index.js           Add startRun/progress/endRun
packages/ui/app/agents/page.jsx          Add "Open Observe →" link
```

---

## Phase 1 — Trustworthy Telemetry Foundation

---

### Task 1: Telemetry Database Schema

**Files:**
- Create: `packages/agents/shared/sql/telemetry-schema.sql`
- Modify: `packages/ui/server.js`

- [ ] **Step 1: Write the schema file**

```sql
-- packages/agents/shared/sql/telemetry-schema.sql
-- Idempotent — safe to run multiple times on startup.

CREATE SCHEMA IF NOT EXISTS telemetry;

-- ── Agent runs ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.agent_runs (
  run_id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_name     TEXT NOT NULL,
  workflow_name  TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','completed','failed','cancelled')),
  host_name      TEXT,
  pid            INT,
  config_version TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_time
  ON telemetry.agent_runs (agent_name, started_at DESC);

-- ── LLM requests ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.llm_requests (
  request_id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  trace_id               TEXT NOT NULL,
  run_id                 TEXT REFERENCES telemetry.agent_runs(run_id) ON DELETE SET NULL,
  agent_name             TEXT NOT NULL,
  workflow_name          TEXT,
  task_type              TEXT,
  model                  TEXT,
  provider_type          TEXT,
  prompt_template_version TEXT,
  started_at             TIMESTAMPTZ NOT NULL,
  ended_at               TIMESTAMPTZ,
  duration_ms            INT,
  prompt_tokens          INT,
  completion_tokens      INT,
  total_tokens           INT,
  input_chars            INT,
  output_chars           INT,
  success                BOOLEAN,
  error_type             TEXT,
  retry_count            INT NOT NULL DEFAULT 0,
  stream_mode            BOOLEAN NOT NULL DEFAULT false,
  prompt_hash            TEXT,
  output_hash            TEXT,
  prompt_preview         TEXT,
  output_preview         TEXT,
  full_trace_stored      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS llm_requests_agent_time
  ON telemetry.llm_requests (agent_name, started_at DESC);
CREATE INDEX IF NOT EXISTS llm_requests_model_time
  ON telemetry.llm_requests (model, started_at DESC);

-- ── Full trace samples ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.llm_request_samples (
  request_id   TEXT PRIMARY KEY REFERENCES telemetry.llm_requests(request_id) ON DELETE CASCADE,
  full_prompt  TEXT,
  full_output  TEXT,
  stored_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Work progress ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.work_progress (
  progress_id       BIGSERIAL PRIMARY KEY,
  run_id            TEXT REFERENCES telemetry.agent_runs(run_id) ON DELETE CASCADE,
  stage_name        TEXT NOT NULL,
  units_total       INT,
  units_completed   INT NOT NULL DEFAULT 0,
  units_failed      INT NOT NULL DEFAULT 0,
  units_skipped     INT NOT NULL DEFAULT 0,
  rate_units_per_min NUMERIC(10,3),
  eta_seconds       INT,
  last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, stage_name)
);

-- ── System samples ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.system_samples (
  sampled_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cpu_power_mw              INT,
  gpu_power_mw              INT,
  ane_power_mw              INT,
  gpu_active_residency_pct  NUMERIC(5,2),
  gpu_idle_residency_pct    NUMERIC(5,2),
  cpu_util_pct              NUMERIC(5,2),
  mem_used_mb               INT,
  swap_used_mb              INT,
  gpu_freq_mhz              INT,
  cpu_temp_c                NUMERIC(5,1),
  gpu_temp_c                NUMERIC(5,1),
  fan_rpm                   INT,
  thermal_state             TEXT
);
CREATE INDEX IF NOT EXISTS system_samples_time
  ON telemetry.system_samples (sampled_at DESC);

-- ── Model sessions ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.model_sessions (
  session_id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  model_name            TEXT NOT NULL,
  runner_pid            INT,
  port                  INT,
  loaded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at          TIMESTAMPTZ,
  unloaded_at           TIMESTAMPTZ,
  total_requests        INT NOT NULL DEFAULT 0,
  total_tokens          BIGINT NOT NULL DEFAULT 0,
  cumulative_duration_ms BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS model_sessions_model_loaded
  ON telemetry.model_sessions (model_name, loaded_at DESC);

-- ── Quality scores ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.quality_scores (
  quality_id       BIGSERIAL PRIMARY KEY,
  request_id       TEXT REFERENCES telemetry.llm_requests(request_id) ON DELETE CASCADE,
  evaluation_type  TEXT NOT NULL CHECK (evaluation_type IN ('structural','task','human')),
  score_numeric    NUMERIC(5,4),
  score_label      TEXT,
  evaluator        TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS quality_scores_request
  ON telemetry.quality_scores (request_id);

-- ── Alerts ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.alerts (
  alert_id    BIGSERIAL PRIMARY KEY,
  rule_name   TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  message     TEXT NOT NULL,
  context     JSONB,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alerts_fired
  ON telemetry.alerts (fired_at DESC);

-- ── Telemetry counters ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.counters (
  agent_name      TEXT NOT NULL,
  counter_name    TEXT NOT NULL,
  value           BIGINT NOT NULL DEFAULT 0,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_name, counter_name)
);

-- ── Work efficiency (derived, updated by collector) ───────────────────────────
CREATE TABLE IF NOT EXISTS telemetry.work_efficiency (
  run_id              TEXT REFERENCES telemetry.agent_runs(run_id) ON DELETE CASCADE,
  stage_name          TEXT NOT NULL,
  tokens_per_unit     NUMERIC(10,2),
  ms_per_unit         NUMERIC(10,2),
  requests_per_unit   NUMERIC(10,4),
  failures_per_unit   NUMERIC(10,4),
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, stage_name)
);

-- ── Optional: TimescaleDB hypertables ─────────────────────────────────────────
DO $$ BEGIN
  PERFORM create_hypertable(
    'telemetry.system_samples', 'sampled_at',
    if_not_exists => TRUE, migrate_data => TRUE
  );
EXCEPTION WHEN others THEN
  NULL; -- TimescaleDB not installed, skip silently
END $$;

DO $$ BEGIN
  PERFORM create_hypertable(
    'telemetry.llm_requests', 'started_at',
    if_not_exists => TRUE, migrate_data => TRUE
  );
EXCEPTION WHEN others THEN
  NULL;
END $$;
```

- [ ] **Step 2: Register schema in server.js migration list**

In `packages/ui/server.js`, find the `schemas` array in `runSystemSchema()` (around line 43) and add before the search schema entry:

```js
{ file: '../agents/shared/sql/telemetry-schema.sql', required: true  },
```

The full updated array should look like:
```js
const schemas = [
  { file: '../agents/email/sql/schema.sql',          required: true  },
  { file: '../agents/limitless/sql/schema.sql',      required: true  },
  { file: '../agents/projects/sql/schema.sql',       required: true  },
  { file: '../agents/relationships/sql/schema.sql',  required: true  },
  { file: '../agents/ai/sql/schema.sql',             required: true  },
  { file: '../agents/research/sql/schema.sql',       required: true  },
  { file: '../agents/apple-contacts/sql/schema.sql', required: true  },
  { file: '../agents/whatsapp/src/db/schema.sql',    required: true  },
  { file: '../agents/shared/sql/system-schema.sql',  required: true  },
  { file: '../agents/shared/sql/telemetry-schema.sql', required: true },
  { file: './sql/search_schema.sql',                 required: false },
];
```

- [ ] **Step 3: Verify schema runs against your Postgres instance**

```bash
cd /Users/prateeksureka/Sites/secondbrain
node -e "
require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const fs = require('fs');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = fs.readFileSync('packages/agents/shared/sql/telemetry-schema.sql', 'utf8');
db.query(sql).then(() => { console.log('OK'); db.end(); }).catch(e => { console.error(e.message); db.end(); });
"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add packages/agents/shared/sql/telemetry-schema.sql packages/ui/server.js
git commit -m "feat(telemetry): add telemetry schema (all tables, TimescaleDB-optional)"
```

---

### Task 2: Workspace Setup for New Packages

**Files:**
- Modify: `package.json` (root)
- Create: `packages/telemetry/package.json`
- Create: `packages/telemetry-buffer/package.json`
- Create: `packages/collector/package.json`
- Create: `packages/sampler/package.json`
- Create: `packages/observe/package.json`

- [ ] **Step 1: Update root package.json workspaces and scripts**

Replace the entire `workspaces` array and add scripts:

```json
{
  "name": "secondbrain",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "packages/db",
    "packages/agents/*",
    "packages/telemetry",
    "packages/telemetry-buffer",
    "packages/collector",
    "packages/sampler",
    "packages/observe",
    "packages/ui"
  ],
  "scripts": {
    "ui": "concurrently \"node packages/ui/server.js\" \"npm start --workspace=packages/ui\"",
    "ui:dev": "concurrently \"node packages/ui/server.js\" \"npm run dev --workspace=packages/ui\"",
    "limitless": "npm start --workspace=packages/agents/limitless",
    "limitless:fetch": "npm run fetch --workspace=packages/agents/limitless",
    "limitless:archive": "npm run archive --workspace=packages/agents/limitless",
    "email": "npm start --workspace=packages/agents/email",
    "email:fetch": "npm run fetch --workspace=packages/agents/email",
    "relationships": "npm start --workspace=packages/agents/relationships",
    "projects": "npm start --workspace=packages/agents/projects",
    "ai:claude": "npm start --workspace=packages/agents/ai",
    "ai:openai": "npm run openai --workspace=packages/agents/ai",
    "ai:gemini": "npm run gemini --workspace=packages/agents/ai",
    "research": "npm start --workspace=packages/agents/research",
    "whatsapp": "npm start --workspace=packages/agents/whatsapp",
    "whatsapp:setup": "npm run setup --workspace=packages/agents/whatsapp",
    "apple-contacts": "node packages/agents/apple-contacts/index.js",
    "init-db": "npm run init-db --workspace=packages/agents/limitless && npm run init-db --workspace=packages/agents/email && npm run init-db --workspace=packages/agents/ai && npm run init-db --workspace=packages/agents/research",
    "collector": "node packages/collector/index.js",
    "sampler": "sudo node packages/sampler/index.js",
    "observe": "node packages/observe/server.js"
  },
  "devDependencies": {
    "concurrently": "^9.2.1"
  },
  "dependencies": {
    "node-mac-contacts": "^1.7.2",
    "pdf-parse": "^2.4.5",
    "xlsx": "^0.18.5"
  }
}
```

- [ ] **Step 2: Create package.json for each new package**

`packages/telemetry/package.json`:
```json
{
  "name": "@secondbrain/telemetry",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "test": "node --test test/sdk.test.js"
  },
  "dependencies": {
    "@secondbrain/db": "*",
    "@secondbrain/telemetry-buffer": "*"
  }
}
```

`packages/telemetry-buffer/package.json`:
```json
{
  "name": "@secondbrain/telemetry-buffer",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "test": "node --test test/buffer.test.js"
  }
}
```

`packages/collector/package.json`:
```json
{
  "name": "@secondbrain/collector",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@secondbrain/db": "*"
  }
}
```

`packages/sampler/package.json`:
```json
{
  "name": "@secondbrain/sampler",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@secondbrain/db": "*",
    "plist": "^3.1.0"
  }
}
```

`packages/observe/package.json`:
```json
{
  "name": "@secondbrain/observe",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "@secondbrain/db": "*",
    "express": "^4.19.2",
    "dotenv": "^16.5.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

```bash
cd /Users/prateeksureka/Sites/secondbrain
npm install
```

Expected: no errors; `@secondbrain/telemetry`, `@secondbrain/telemetry-buffer`, `plist`, `express` all installed in workspace node_modules.

- [ ] **Step 4: Commit**

```bash
git add package.json packages/telemetry/package.json packages/telemetry-buffer/package.json packages/collector/package.json packages/sampler/package.json packages/observe/package.json package-lock.json
git commit -m "feat(telemetry): add workspace packages for telemetry, buffer, collector, sampler, observe"
```

---

### Task 3: Telemetry Buffer Package

**Files:**
- Create: `packages/telemetry-buffer/index.js`
- Create: `packages/telemetry-buffer/test/buffer.test.js`

- [ ] **Step 1: Write the failing test**

```js
// packages/telemetry-buffer/test/buffer.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { createBuffer } = require('../index')

test('enqueue increments emitted count', () => {
  const buf = createBuffer({ maxMemory: 100, spillDir: null, drainIntervalMs: 0 })
  buf.enqueue({ type: 'test', data: 1 })
  buf.enqueue({ type: 'test', data: 2 })
  assert.equal(buf.counts().emitted, 2)
  buf.stop()
})

test('drain calls writer with batched events', async () => {
  const buf = createBuffer({ maxMemory: 100, spillDir: null, drainIntervalMs: 0 })
  buf.enqueue({ type: 'a' })
  buf.enqueue({ type: 'b' })
  const written = []
  await buf.drain(async (events) => { written.push(...events) })
  assert.equal(written.length, 2)
  assert.equal(written[0].type, 'a')
  buf.stop()
})

test('drops events when maxMemory exceeded, increments dropped count', () => {
  const buf = createBuffer({ maxMemory: 2, spillDir: null, drainIntervalMs: 0 })
  buf.enqueue({ type: '1' })
  buf.enqueue({ type: '2' })
  buf.enqueue({ type: '3' }) // should drop
  assert.equal(buf.counts().emitted, 3)
  assert.equal(buf.counts().dropped, 1)
  buf.stop()
})

test('spills to disk on writer failure', async () => {
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbuf-'))
  const buf = createBuffer({ maxMemory: 100, spillDir, drainIntervalMs: 0 })
  buf.enqueue({ type: 'spill_me' })
  await buf.drain(async () => { throw new Error('DB down') })
  const files = fs.readdirSync(spillDir).filter(f => f.endsWith('.ndjson'))
  assert.ok(files.length > 0, 'should have spill file')
  const content = fs.readFileSync(path.join(spillDir, files[0]), 'utf8').trim()
  assert.ok(content.includes('spill_me'))
  fs.rmSync(spillDir, { recursive: true })
  buf.stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/prateeksureka/Sites/secondbrain
node --test packages/telemetry-buffer/test/buffer.test.js
```

Expected: `Error: Cannot find module '../index'`

- [ ] **Step 3: Implement the buffer**

```js
// packages/telemetry-buffer/index.js
'use strict'

const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DEFAULT_SPILL_DIR     = path.join(os.homedir(), '.secondbrain', 'telemetry-spill')
const DEFAULT_MAX_MEMORY    = 10_000
const DEFAULT_DRAIN_INTERVAL = 5_000  // ms

function createBuffer({
  maxMemory    = DEFAULT_MAX_MEMORY,
  spillDir     = DEFAULT_SPILL_DIR,
  drainIntervalMs = DEFAULT_DRAIN_INTERVAL,
  agentName    = 'unknown',
} = {}) {
  let queue    = []
  let emitted  = 0
  let dropped  = 0
  let written  = 0
  let failed   = 0
  let timer    = null

  if (spillDir) {
    fs.mkdirSync(spillDir, { recursive: true })
  }

  function enqueue(event) {
    emitted++
    if (queue.length >= maxMemory) {
      dropped++
      return
    }
    queue.push(event)
  }

  async function drain(writerFn) {
    if (queue.length === 0) return
    const batch = queue.splice(0, queue.length)
    try {
      await writerFn(batch)
      written += batch.length
    } catch (err) {
      failed += batch.length
      if (spillDir) {
        const filename = `${agentName}-${Date.now()}.ndjson`
        const filepath = path.join(spillDir, filename)
        const lines    = batch.map(e => JSON.stringify(e)).join('\n')
        try {
          fs.writeFileSync(filepath, lines + '\n', 'utf8')
        } catch (spillErr) {
          // Nothing we can do — at least we counted it
        }
      }
    }
  }

  function counts() {
    return { emitted, dropped, written, failed }
  }

  function start(writerFn) {
    if (drainIntervalMs <= 0) return
    timer = setInterval(() => drain(writerFn).catch(() => {}), drainIntervalMs)
    timer.unref()
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  return { enqueue, drain, counts, start, stop }
}

module.exports = { createBuffer, DEFAULT_SPILL_DIR }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test packages/telemetry-buffer/test/buffer.test.js
```

Expected: `✓ enqueue increments emitted count`, `✓ drain calls writer...`, `✓ drops events...`, `✓ spills to disk...` — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry-buffer/
git commit -m "feat(telemetry-buffer): in-memory queue with disk spill and backpressure"
```

---

### Task 4: Telemetry SDK

**Files:**
- Create: `packages/telemetry/ids.js`
- Create: `packages/telemetry/writer.js`
- Create: `packages/telemetry/sampling.js`
- Create: `packages/telemetry/index.js`
- Create: `packages/telemetry/test/sdk.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// packages/telemetry/test/sdk.test.js
'use strict'
const { test } = require('node:test')
const assert   = require('node:assert/strict')
const { generateId } = require('../ids')
const { shouldStoreFull } = require('../sampling')

test('generateId returns a non-empty string', () => {
  const id = generateId()
  assert.equal(typeof id, 'string')
  assert.ok(id.length > 0)
})

test('generateId returns unique values', () => {
  assert.notEqual(generateId(), generateId())
})

test('shouldStoreFull returns true for failed request', () => {
  assert.ok(shouldStoreFull({ success: false, retryCount: 0, sampleRate: 0 }))
})

test('shouldStoreFull returns true for retried request', () => {
  assert.ok(shouldStoreFull({ success: true, retryCount: 1, sampleRate: 0 }))
})

test('shouldStoreFull returns false at 0% sample rate for clean request', () => {
  // Deterministic: run 100 times, expect 0 samples at rate 0
  let count = 0
  for (let i = 0; i < 100; i++) {
    if (shouldStoreFull({ success: true, retryCount: 0, sampleRate: 0 })) count++
  }
  assert.equal(count, 0)
})

test('shouldStoreFull returns true for debug mode', () => {
  assert.ok(shouldStoreFull({ success: true, retryCount: 0, sampleRate: 0, debugMode: true }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test packages/telemetry/test/sdk.test.js
```

Expected: `Error: Cannot find module '../ids'`

- [ ] **Step 3: Implement ids.js**

```js
// packages/telemetry/ids.js
'use strict'
const { randomUUID } = require('crypto')
function generateId() { return randomUUID() }
module.exports = { generateId }
```

- [ ] **Step 4: Implement sampling.js**

```js
// packages/telemetry/sampling.js
'use strict'

/**
 * Decide whether to store full prompt/output for a request.
 * @param {object} opts
 * @param {boolean} opts.success
 * @param {number}  opts.retryCount
 * @param {number}  opts.sampleRate   0.0–1.0, default 0.02
 * @param {boolean} [opts.debugMode]  true if debug trace enabled for agent
 * @param {boolean} [opts.jsonFailed] true if output failed JSON parse
 * @param {number}  [opts.qualityScore] 0.0–1.0 if available
 * @param {number}  [opts.qualityThreshold] default 0.5
 */
function shouldStoreFull({
  success,
  retryCount,
  sampleRate      = 0.02,
  debugMode       = false,
  jsonFailed      = false,
  qualityScore    = null,
  qualityThreshold = 0.5,
}) {
  if (!success)                                        return true
  if (retryCount > 0)                                  return true
  if (debugMode)                                       return true
  if (jsonFailed)                                      return true
  if (qualityScore != null && qualityScore < qualityThreshold) return true
  if (sampleRate > 0 && Math.random() < sampleRate)    return true
  return false
}

module.exports = { shouldStoreFull }
```

- [ ] **Step 5: Implement writer.js**

```js
// packages/telemetry/writer.js
'use strict'
const db = require('@secondbrain/db')

async function writeBatch(events) {
  if (!events || events.length === 0) return

  const requests = events.filter(e => e._type === 'llm_request')
  const samples  = events.filter(e => e._type === 'llm_request_sample')
  const runs     = events.filter(e => e._type === 'agent_run_update')
  const progress = events.filter(e => e._type === 'work_progress')
  const quality  = events.filter(e => e._type === 'quality_score')

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    for (const r of requests) {
      await client.query(`
        INSERT INTO telemetry.llm_requests (
          request_id, trace_id, run_id, agent_name, workflow_name, task_type,
          model, provider_type, started_at, ended_at, duration_ms,
          prompt_tokens, completion_tokens, total_tokens,
          input_chars, output_chars, success, error_type, retry_count,
          stream_mode, prompt_hash, output_hash, prompt_preview, output_preview,
          full_trace_stored
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,$25
        ) ON CONFLICT (request_id) DO NOTHING
      `, [
        r.requestId, r.traceId, r.runId || null, r.agentName, r.workflowName || null,
        r.taskType || null, r.model || null, r.providerType || null,
        r.startedAt, r.endedAt || null, r.durationMs || null,
        r.promptTokens || null, r.completionTokens || null,
        (r.promptTokens || 0) + (r.completionTokens || 0) || null,
        r.inputChars || null, r.outputChars || null,
        r.success != null ? r.success : null, r.errorType || null,
        r.retryCount || 0, r.streamMode || false,
        r.promptHash || null, r.outputHash || null,
        r.promptPromptPreview || null, r.outputPreview || null,
        r.fullTraceStored || false,
      ])
    }

    for (const s of samples) {
      await client.query(`
        INSERT INTO telemetry.llm_request_samples (request_id, full_prompt, full_output)
        VALUES ($1, $2, $3) ON CONFLICT (request_id) DO NOTHING
      `, [s.requestId, s.fullPrompt || null, s.fullOutput || null])
    }

    for (const run of runs) {
      if (run.action === 'start') {
        await client.query(`
          INSERT INTO telemetry.agent_runs (run_id, agent_name, workflow_name, started_at, status, host_name, pid, config_version)
          VALUES ($1,$2,$3,$4,'running',$5,$6,$7) ON CONFLICT (run_id) DO NOTHING
        `, [run.runId, run.agentName, run.workflowName || null, run.startedAt, run.hostName || null, run.pid || null, run.configVersion || null])
      } else if (run.action === 'end') {
        await client.query(`
          UPDATE telemetry.agent_runs SET ended_at=$2, status=$3 WHERE run_id=$1
        `, [run.runId, run.endedAt, run.status || 'completed'])
      }
    }

    for (const p of progress) {
      await client.query(`
        INSERT INTO telemetry.work_progress (run_id, stage_name, units_total, units_completed, units_failed, units_skipped, rate_units_per_min, eta_seconds, last_updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (run_id, stage_name) DO UPDATE SET
          units_total    = EXCLUDED.units_total,
          units_completed = EXCLUDED.units_completed,
          units_failed   = EXCLUDED.units_failed,
          units_skipped  = EXCLUDED.units_skipped,
          rate_units_per_min = EXCLUDED.rate_units_per_min,
          eta_seconds    = EXCLUDED.eta_seconds,
          last_updated_at = NOW()
      `, [p.runId, p.stageName, p.total || null, p.completed || 0, p.failed || 0, p.skipped || 0, p.rate || null, p.eta || null])
    }

    for (const q of quality) {
      await client.query(`
        INSERT INTO telemetry.quality_scores (request_id, evaluation_type, score_numeric, score_label, evaluator, notes)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [q.requestId, q.evaluationType, q.scoreNumeric || null, q.scoreLabel || null, q.evaluator || null, q.notes || null])
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function updateCounters(agentName, counts) {
  try {
    for (const [name, value] of Object.entries(counts)) {
      await db.query(`
        INSERT INTO telemetry.counters (agent_name, counter_name, value, last_updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (agent_name, counter_name) DO UPDATE
          SET value = telemetry.counters.value + EXCLUDED.value,
              last_updated_at = NOW()
      `, [agentName, name, value])
    }
  } catch (err) {
    // Counter update failure is non-critical
  }
}

module.exports = { writeBatch, updateCounters }
```

- [ ] **Step 6: Implement index.js (the public SDK)**

```js
// packages/telemetry/index.js
'use strict'

const os       = require('os')
const crypto   = require('crypto')
const { generateId }     = require('./ids')
const { shouldStoreFull } = require('./sampling')
const writer   = require('./writer')
const { createBuffer, DEFAULT_SPILL_DIR } = require('@secondbrain/telemetry-buffer')

// One buffer per process (shared across all agents in a process)
let _buffer = null
let _agentName = 'unknown'

function _getBuffer() {
  if (!_buffer) {
    _buffer = createBuffer({ agentName: _agentName, spillDir: DEFAULT_SPILL_DIR })
    _buffer.start(writer.writeBatch)
  }
  return _buffer
}

function _hashPreview(text, maxLen = 500) {
  if (!text) return { hash: null, preview: null, chars: 0 }
  const str  = typeof text === 'string' ? text : JSON.stringify(text)
  const hash = crypto.createHash('sha256').update(str).digest('hex').slice(0, 16)
  return { hash, preview: str.slice(0, maxLen), chars: str.length }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register the agent name for this process. Call once at agent startup.
 * This sets the buffer's agent label for spill file naming.
 */
function init(agentName) {
  _agentName = agentName
  if (_buffer) _buffer.stop()
  _buffer = null  // will recreate with new name
}

/**
 * Record the start of an agent run.
 * Returns runId (a UUID string).
 */
async function startRun({ agentId, workflowName, pid, configVersion } = {}) {
  const runId = generateId()
  _getBuffer().enqueue({
    _type: 'agent_run_update',
    action: 'start',
    runId,
    agentName: agentId || _agentName,
    workflowName: workflowName || null,
    startedAt: new Date().toISOString(),
    hostName: os.hostname(),
    pid: pid || process.pid,
    configVersion: configVersion || null,
  })
  return runId
}

/**
 * Record the end of an agent run.
 */
async function endRun(runId, { status = 'completed' } = {}) {
  _getBuffer().enqueue({
    _type: 'agent_run_update',
    action: 'end',
    runId,
    endedAt: new Date().toISOString(),
    status,
  })
}

/**
 * Begin timing an LLM request.
 * Returns a request handle with a `finish()` method.
 */
function startRequest({
  agentId,
  runId       = null,
  taskType    = null,
  model       = null,
  providerType = null,
  prompt      = null,
  streamMode  = false,
  workflowName = null,
} = {}) {
  const requestId = generateId()
  const traceId   = generateId()
  const startedAt = new Date()
  const { hash: promptHash, preview: promptPreview, chars: inputChars } = _hashPreview(prompt)

  return {
    requestId,
    traceId,

    /**
     * Call after the LLM call completes (success or failure).
     */
    finish({
      tokensIn    = null,
      tokensOut   = null,
      success     = true,
      errorType   = null,
      retryCount  = 0,
      output      = null,
      debugMode   = false,
      jsonFailed  = false,
      qualityScore = null,
    } = {}) {
      const endedAt    = new Date()
      const durationMs = endedAt - startedAt
      const { hash: outputHash, preview: outputPreview, chars: outputChars } = _hashPreview(output)

      const storeFull = shouldStoreFull({ success, retryCount, debugMode, jsonFailed, qualityScore })

      const event = {
        _type: 'llm_request',
        requestId,
        traceId,
        runId,
        agentName: agentId || _agentName,
        workflowName,
        taskType,
        model,
        providerType,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
        promptTokens: tokensIn,
        completionTokens: tokensOut,
        inputChars,
        outputChars,
        success,
        errorType,
        retryCount,
        streamMode,
        promptHash,
        outputHash,
        promptPromptPreview: promptPreview,
        outputPreview,
        fullTraceStored: storeFull,
      }
      _getBuffer().enqueue(event)

      if (storeFull) {
        _getBuffer().enqueue({
          _type: 'llm_request_sample',
          requestId,
          fullPrompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
          fullOutput: typeof output === 'string' ? output : JSON.stringify(output),
        })
      }

      return { requestId, durationMs }
    },
  }
}

/**
 * Emit a work-progress update for a stage.
 */
function progress(runId, stageName, { completed = 0, total = null, failed = 0, skipped = 0 } = {}) {
  _getBuffer().enqueue({
    _type: 'work_progress',
    runId,
    stageName,
    completed,
    total,
    failed,
    skipped,
    // Rate and ETA calculated by the collector/observe server from history
  })
}

/**
 * Record a quality score for a request.
 */
function recordQuality({ requestId, evaluationType, scoreNumeric, scoreLabel, evaluator, notes } = {}) {
  _getBuffer().enqueue({
    _type: 'quality_score',
    requestId,
    evaluationType,
    scoreNumeric,
    scoreLabel,
    evaluator,
    notes,
  })
}

/**
 * Flush the in-memory buffer to DB immediately (useful at process shutdown).
 */
async function flush() {
  if (_buffer) await _buffer.drain(writer.writeBatch)
}

/**
 * Expose current buffer counters for health checks.
 */
function counters() {
  return _buffer ? _buffer.counts() : { emitted: 0, dropped: 0, written: 0, failed: 0 }
}

module.exports = { init, startRun, endRun, startRequest, progress, recordQuality, flush, counters }
```

- [ ] **Step 7: Run tests**

```bash
node --test packages/telemetry/test/sdk.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/telemetry/
git commit -m "feat(telemetry): SDK with startRun/endRun/startRequest/progress/recordQuality"
```

---

### Task 5: Instrument llm.js

**Files:**
- Modify: `packages/agents/shared/llm.js`

- [ ] **Step 1: Add telemetry import and wrap create()**

Open `packages/agents/shared/llm.js`. At the top, after the existing `require` lines, add:

```js
let telemetry = null
function getTelemetry() {
  if (!telemetry) {
    try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
  }
  return telemetry
}
```

(Lazy-require so telemetry failures never break agents.)

- [ ] **Step 2: Modify the create() function**

Find the `create` function (around line 407). Replace the `for (const prov of providers)` loop body:

```js
  for (const prov of providers) {
    const fn = CALL_FNS[prov.provider_type]
    if (!fn) continue

    console.log(`[llm:${agentId}] trying ${prov.name} (${prov.provider_type})`)
    const t   = getTelemetry()
    const req = t ? t.startRequest({
      agentId,
      taskType: options._taskType || null,
      model: prov.model,
      providerType: prov.provider_type,
      prompt: messages,
      workflowName: options._workflowName || null,
      runId: options._runId || null,
    }) : null

    try {
      const result = await fn(prov, { system, messages, tools, max_tokens })
      const cost   = calcCost(prov.provider_type, prov.model, result.tokensIn, result.tokensOut)
      await logUsage({ providerId: prov.id, agentId, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: cost })
      if (req) req.finish({
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        success: true,
        output: result.text,
      })
      return { text: result.text, tool_calls: result.tool_calls, stop_reason: result.stop_reason, provider: prov.name }
    } catch (err) {
      if (req) req.finish({ success: false, errorType: err.constructor?.name || 'Error' })
      console.warn(`[llm:${agentId}] ${prov.name} failed: ${err.message}`)
      if (isCreditError(err)) {
        await markCreditsFailed(prov.id, err.message)
        console.warn(`[llm:${agentId}] marked ${prov.name} credits exhausted, trying next`)
      }
      await logUsage({ providerId: prov.id, agentId, error: err.message })
      errors.push(`${prov.name}: ${err.message}`)
    }
  }
```

Also update the function signature to accept options object properly. Find `async function create(agentId, { system, messages, tools, max_tokens })` and change to:

```js
async function create(agentId, { system, messages, tools, max_tokens, _taskType, _workflowName, _runId } = {}) {
```

And update the `options` reference in the loop by replacing `options._taskType` etc with the destructured vars:

```js
    const req = t ? t.startRequest({
      agentId,
      taskType: _taskType || null,
      model: prov.model,
      providerType: prov.provider_type,
      prompt: messages,
      workflowName: _workflowName || null,
      runId: _runId || null,
    }) : null
```

- [ ] **Step 3: Verify agents still start without error**

```bash
cd /Users/prateeksureka/Sites/secondbrain
node -e "
require('dotenv').config({ path: '.env.local' });
const llm = require('./packages/agents/shared/llm');
console.log('llm loaded OK, create is:', typeof llm.create);
"
```

Expected: `llm loaded OK, create is: function`

- [ ] **Step 4: Commit**

```bash
git add packages/agents/shared/llm.js
git commit -m "feat(telemetry): instrument llm.js create() with telemetry startRequest/finish"
```

---

### Task 6: Collector Process

**Files:**
- Create: `packages/collector/index.js`

- [ ] **Step 1: Implement the collector**

```js
// packages/collector/index.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const fs      = require('fs')
const path    = require('path')
const db      = require('@secondbrain/db')
const os      = require('os')
const SPILL_DIR = path.join(os.homedir(), '.secondbrain', 'telemetry-spill')
const SCAN_INTERVAL_MS = 30_000

console.log('[collector] starting, scanning:', SPILL_DIR)

async function writeBatch(events) {
  // Import the writer from the telemetry package rather than duplicating the logic
  const { writeBatch } = require('@secondbrain/telemetry/writer')
  await writeBatch(events)
}

async function replayFile(filepath) {
  const lines = fs.readFileSync(filepath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
  if (lines.length === 0) {
    fs.unlinkSync(filepath)
    return { replayed: 0 }
  }
  const events = lines.map(l => JSON.parse(l))
  const writer = require('@secondbrain/telemetry/writer')
  await writer.writeBatch(events)
  fs.unlinkSync(filepath)
  console.log(`[collector] replayed ${events.length} events from ${path.basename(filepath)}`)
  return { replayed: events.length }
}

async function scanAndReplay() {
  if (!fs.existsSync(SPILL_DIR)) return
  const files = fs.readdirSync(SPILL_DIR).filter(f => f.endsWith('.ndjson'))
  if (files.length === 0) return
  console.log(`[collector] found ${files.length} spill file(s)`)
  let total = 0
  for (const file of files) {
    try {
      const { replayed } = await replayFile(path.join(SPILL_DIR, file))
      total += replayed
    } catch (err) {
      console.warn(`[collector] failed to replay ${file}: ${err.message}`)
    }
  }
  if (total > 0) {
    await db.query(`
      INSERT INTO telemetry.counters (agent_name, counter_name, value, last_updated_at)
      VALUES ('collector', 'replayed_events', $1, NOW())
      ON CONFLICT (agent_name, counter_name) DO UPDATE
        SET value = telemetry.counters.value + EXCLUDED.value,
            last_updated_at = NOW()
    `, [total])
  }
}

// Run immediately on startup, then every SCAN_INTERVAL_MS
scanAndReplay().catch(err => console.warn('[collector] initial scan error:', err.message))
setInterval(() => scanAndReplay().catch(err => console.warn('[collector] scan error:', err.message)), SCAN_INTERVAL_MS)

process.on('SIGINT', () => { console.log('[collector] shutting down'); db.end(); process.exit(0) })
```

- [ ] **Step 2: Verify it starts without crashing**

```bash
cd /Users/prateeksureka/Sites/secondbrain
node packages/collector/index.js &
sleep 2
kill %1
```

Expected: `[collector] starting, scanning: ...` then clean exit.

- [ ] **Step 3: Commit**

```bash
git add packages/collector/index.js
git commit -m "feat(collector): replay spilled telemetry NDJSON files to Postgres"
```

---

### Task 7: Privileged System Sampler

**Files:**
- Create: `packages/sampler/powermetrics.js`
- Create: `packages/sampler/process-stats.js`
- Create: `packages/sampler/ollama-ps.js`
- Create: `packages/sampler/index.js`

- [ ] **Step 1: Implement powermetrics.js**

```js
// packages/sampler/powermetrics.js
'use strict'

const { spawn } = require('child_process')
const plist     = require('plist')

let child    = null
let buffer   = ''
let handlers = []
let running  = false

function onSample(fn) { handlers.push(fn) }

function _emit(sample) {
  for (const h of handlers) {
    try { h(sample) } catch (_) {}
  }
}

function _parseSample(doc) {
  try {
    const parsed = plist.parse(doc)
    // `processor` section
    const proc = parsed.processor || {}
    const pkg  = (proc.packages || [{}])[0]
    const cpuPowerMw  = Math.round((pkg.cpu_energy  || 0) * 1000)
    const gpuPowerMw  = Math.round((pkg.gpu_energy  || 0) * 1000)
    const anePowerMw  = Math.round((pkg.ane_energy  || 0) * 1000)

    // GPU residency
    const gpuActive = parsed.gpu_power?.active_residency   || null
    const gpuIdle   = parsed.gpu_power?.idle_residency     || null

    // Thermals
    const thermalState = parsed.thermal_state || null

    return {
      cpu_power_mw:             cpuPowerMw  || null,
      gpu_power_mw:             gpuPowerMw  || null,
      ane_power_mw:             anePowerMw  || null,
      gpu_active_residency_pct: gpuActive   != null ? parseFloat((gpuActive * 100).toFixed(2))  : null,
      gpu_idle_residency_pct:   gpuIdle     != null ? parseFloat((gpuIdle   * 100).toFixed(2))  : null,
      thermal_state:            thermalState,
    }
  } catch (err) {
    return null
  }
}

function start() {
  if (running) return
  running = true
  child = spawn('powermetrics', [
    '--samplers', 'cpu_power,gpu_power',
    '-i', '1000',
    '-f', 'plist',
  ])

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    // powermetrics emits one plist doc per sample, terminated by </plist>
    let idx
    while ((idx = buffer.indexOf('</plist>')) !== -1) {
      const doc = buffer.slice(0, idx + '</plist>'.length)
      buffer    = buffer.slice(idx + '</plist>'.length)
      const sample = _parseSample(doc)
      if (sample) _emit(sample)
    }
  })

  child.on('error', err => console.error('[sampler:powermetrics] error:', err.message))
  child.on('close', code => {
    running = false
    if (code !== 0) console.warn('[sampler:powermetrics] exited with code', code)
  })
}

function stop() {
  if (child) { child.kill(); child = null }
  running = false
}

module.exports = { start, stop, onSample }
```

- [ ] **Step 2: Implement process-stats.js**

```js
// packages/sampler/process-stats.js
'use strict'

const { exec } = require('child_process')

/**
 * Returns CPU% and RSS MB for processes matching namePattern.
 * @returns {Promise<Array<{pid, name, cpu, rss_mb}>>}
 */
function getProcessStats(namePattern) {
  return new Promise((resolve) => {
    exec('ps aux', (err, stdout) => {
      if (err) return resolve([])
      const results = []
      const lines = stdout.split('\n').slice(1)
      for (const line of lines) {
        if (!line.includes(namePattern)) continue
        const parts = line.trim().split(/\s+/)
        // USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
        const pid  = parseInt(parts[1], 10)
        const cpu  = parseFloat(parts[2])
        const rssMb = Math.round(parseInt(parts[5], 10) / 1024)
        const name = parts.slice(10).join(' ').slice(0, 80)
        if (!isNaN(pid)) results.push({ pid, name, cpu, rss_mb: rssMb })
      }
      resolve(results)
    })
  })
}

module.exports = { getProcessStats }
```

- [ ] **Step 3: Implement ollama-ps.js**

```js
// packages/sampler/ollama-ps.js
'use strict'

const { exec } = require('child_process')

/**
 * Returns list of loaded Ollama models from `ollama ps`.
 * @returns {Promise<Array<{model, size, processor, until}>>}
 */
function getLoadedModels() {
  return new Promise((resolve) => {
    exec('ollama ps', (err, stdout) => {
      if (err) return resolve([])
      const lines = stdout.split('\n').slice(1).filter(l => l.trim())
      const models = lines.map(line => {
        const parts = line.trim().split(/\s{2,}/)
        return {
          model:     parts[0] || null,
          size:      parts[1] || null,
          processor: parts[2] || null,
          until:     parts[3] || null,
        }
      }).filter(m => m.model)
      resolve(models)
    })
  })
}

module.exports = { getLoadedModels }
```

- [ ] **Step 4: Implement index.js (main sampler loop)**

```js
// packages/sampler/index.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const { exec }   = require('child_process')
const db         = require('@secondbrain/db')
const pm         = require('./powermetrics')
const ps         = require('./process-stats')
const ollamaPs   = require('./ollama-ps')

console.log('[sampler] starting (privileged)')

// ── Fast loop: persist powermetrics samples every 1s ──────────────────────────

// Track the latest partial sample from powermetrics; we merge in CPU util
let latestPmSample = {}

pm.onSample(sample => {
  Object.assign(latestPmSample, sample)
})

pm.start()

// Flush powermetrics data to DB every 1s
setInterval(async () => {
  if (Object.keys(latestPmSample).length === 0) return
  const sample = { ...latestPmSample, sampled_at: new Date() }
  latestPmSample = {}
  try {
    await db.query(`
      INSERT INTO telemetry.system_samples
        (sampled_at, cpu_power_mw, gpu_power_mw, ane_power_mw,
         gpu_active_residency_pct, gpu_idle_residency_pct, thermal_state)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      sample.sampled_at,
      sample.cpu_power_mw    || null,
      sample.gpu_power_mw    || null,
      sample.ane_power_mw    || null,
      sample.gpu_active_residency_pct || null,
      sample.gpu_idle_residency_pct   || null,
      sample.thermal_state   || null,
    ])
  } catch (err) {
    console.warn('[sampler] system_samples write error:', err.message)
  }
}, 1000)

// ── Medium loop: process stats every 5s ───────────────────────────────────────

setInterval(async () => {
  try {
    const ollamaProcs = await ps.getProcessStats('ollama')
    const nodeProcs   = await ps.getProcessStats('node')
    // Log summary to stdout (dashboard reads from DB, not here)
    const totalCpu = [...ollamaProcs, ...nodeProcs].reduce((s, p) => s + p.cpu, 0)
    // Update system_samples latest row with cpu_util_pct
    await db.query(`
      UPDATE telemetry.system_samples SET cpu_util_pct = $1
      WHERE sampled_at = (SELECT MAX(sampled_at) FROM telemetry.system_samples)
    `, [parseFloat(totalCpu.toFixed(2))])
  } catch (err) {
    console.warn('[sampler] process-stats error:', err.message)
  }
}, 5000)

// ── Slow loop: ollama ps + memory every 15s ───────────────────────────────────

let knownModels = new Set()

setInterval(async () => {
  try {
    const loaded = await ollamaPs.getLoadedModels()
    const loadedNames = new Set(loaded.map(m => m.model))

    // Upsert active sessions
    for (const m of loaded) {
      await db.query(`
        INSERT INTO telemetry.model_sessions (model_name, loaded_at, last_used_at)
        VALUES ($1, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `, [m.model])
      await db.query(`
        UPDATE telemetry.model_sessions SET last_used_at = NOW()
        WHERE model_name = $1 AND unloaded_at IS NULL
      `, [m.model])
    }

    // Mark models that disappeared as unloaded
    for (const prev of knownModels) {
      if (!loadedNames.has(prev)) {
        await db.query(`
          UPDATE telemetry.model_sessions SET unloaded_at = NOW()
          WHERE model_name = $1 AND unloaded_at IS NULL
        `, [prev])
      }
    }
    knownModels = loadedNames

    // vm_stat for memory
    exec('vm_stat', (err, stdout) => {
      if (err) return
      const pageSize = 16384 // bytes, M1/M2
      const freeMatch  = stdout.match(/Pages free:\s+(\d+)/)
      const activeMatch = stdout.match(/Pages active:\s+(\d+)/)
      const wiredMatch  = stdout.match(/Pages wired down:\s+(\d+)/)
      const swapMatch   = stdout.match(/Swapouts:\s+(\d+)/)
      if (!freeMatch) return
      const free   = parseInt(freeMatch[1],  10) * pageSize
      const active = parseInt(activeMatch?.[1] || '0', 10) * pageSize
      const wired  = parseInt(wiredMatch?.[1]  || '0', 10) * pageSize
      const usedMb = Math.round((active + wired) / 1048576)
      db.query(`
        UPDATE telemetry.system_samples SET mem_used_mb = $1
        WHERE sampled_at = (SELECT MAX(sampled_at) FROM telemetry.system_samples)
      `, [usedMb]).catch(() => {})
    })
  } catch (err) {
    console.warn('[sampler] slow loop error:', err.message)
  }
}, 15000)

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('[sampler] shutting down')
  pm.stop()
  db.end()
  process.exit(0)
})
```

- [ ] **Step 5: Test sampler starts without crash (must run with sudo)**

```bash
cd /Users/prateeksureka/Sites/secondbrain
sudo node packages/sampler/index.js &
sleep 3
sudo kill %1
```

Expected: `[sampler] starting (privileged)` then clean shutdown.

- [ ] **Step 6: Add sudoers entry**

```bash
sudo visudo -f /etc/sudoers.d/secondbrain-sampler
```

Add this line (replace `your-username` with your macOS username):
```
your-username ALL=(ALL) NOPASSWD: /usr/local/bin/node /Users/prateeksureka/Sites/secondbrain/packages/sampler/index.js
```

- [ ] **Step 7: Commit**

```bash
git add packages/sampler/
git commit -m "feat(sampler): privileged system metrics (powermetrics, ollama ps, vm_stat)"
```

---

### Task 8: Observe Server + Phase 1 Dashboard

**Files:**
- Create: `packages/observe/server.js`
- Create: `packages/observe/alerts.js`
- Create: `packages/observe/public/index.html`
- Create: `packages/observe/public/app.js`

- [ ] **Step 1: Implement server.js**

```js
// packages/observe/server.js
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env.local') })

const express = require('express')
const path    = require('path')
const db      = require('@secondbrain/db')
const alerts  = require('./alerts')

const PORT = process.env.OBSERVE_PORT || 4002
const app  = express()

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ── System: latest sample + loaded models ─────────────────────────────────────
app.get('/api/system', async (req, res) => {
  try {
    const { rows: [latest] } = await db.query(`
      SELECT * FROM telemetry.system_samples ORDER BY sampled_at DESC LIMIT 1
    `)
    const { rows: models } = await db.query(`
      SELECT * FROM telemetry.model_sessions WHERE unloaded_at IS NULL ORDER BY loaded_at DESC
    `)
    const { rows: counters } = await db.query(`
      SELECT agent_name, counter_name, value FROM telemetry.counters ORDER BY last_updated_at DESC LIMIT 100
    `)
    res.json({ sample: latest || null, models, counters })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Agents: active runs + per-agent progress ──────────────────────────────────
app.get('/api/agents', async (req, res) => {
  try {
    const { rows: runs } = await db.query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id) AS request_count,
        (SELECT COUNT(*) FROM telemetry.llm_requests lr WHERE lr.run_id = r.run_id AND lr.success = false) AS error_count
      FROM telemetry.agent_runs r
      WHERE r.ended_at IS NULL OR r.started_at > NOW() - INTERVAL '24 hours'
      ORDER BY r.started_at DESC
      LIMIT 50
    `)
    const { rows: progress } = await db.query(`
      SELECT wp.*, ar.agent_name FROM telemetry.work_progress wp
      JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
      WHERE ar.ended_at IS NULL OR ar.started_at > NOW() - INTERVAL '24 hours'
      ORDER BY wp.last_updated_at DESC
    `)
    res.json({ runs, progress })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── LLM requests: paginated ───────────────────────────────────────────────────
app.get('/api/requests', async (req, res) => {
  const { agent, model, task_type, success, limit = 100, offset = 0 } = req.query
  const conditions = []
  const params     = []
  if (agent)     { params.push(agent);     conditions.push(`agent_name = $${params.length}`) }
  if (model)     { params.push(model);     conditions.push(`model = $${params.length}`) }
  if (task_type) { params.push(task_type); conditions.push(`task_type = $${params.length}`) }
  if (success != null) { params.push(success === 'true'); conditions.push(`success = $${params.length}`) }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(parseInt(limit, 10), parseInt(offset, 10))
  try {
    const { rows } = await db.query(`
      SELECT * FROM telemetry.llm_requests ${where}
      ORDER BY started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params)
    res.json({ requests: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Models: session stats ──────────────────────────────────────────────────────
app.get('/api/models', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        model,
        COUNT(*) AS total_requests,
        SUM(prompt_tokens) AS total_prompt_tokens,
        SUM(completion_tokens) AS total_completion_tokens,
        AVG(duration_ms)::int AS avg_latency_ms,
        COUNT(*) FILTER (WHERE success = false) AS error_count,
        MAX(started_at) AS last_used_at
      FROM telemetry.llm_requests
      WHERE started_at > NOW() - INTERVAL '7 days'
      GROUP BY model
      ORDER BY total_requests DESC
    `)
    const { rows: sessions } = await db.query(`
      SELECT * FROM telemetry.model_sessions ORDER BY loaded_at DESC LIMIT 50
    `)
    res.json({ stats: rows, sessions })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Quality: scores + model comparison ───────────────────────────────────────
app.get('/api/quality', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT lr.model, lr.task_type, lr.agent_name,
        COUNT(*) AS total,
        AVG(qs.score_numeric) FILTER (WHERE qs.evaluation_type = 'structural') AS avg_structural,
        AVG(qs.score_numeric) FILTER (WHERE qs.evaluation_type = 'human') AS avg_human,
        COUNT(*) FILTER (WHERE lr.success = false) AS errors,
        AVG(lr.retry_count) AS avg_retries
      FROM telemetry.llm_requests lr
      LEFT JOIN telemetry.quality_scores qs ON qs.request_id = lr.request_id
      WHERE lr.started_at > NOW() - INTERVAL '7 days'
      GROUP BY lr.model, lr.task_type, lr.agent_name
      ORDER BY total DESC
    `)
    res.json({ comparison: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Human quality rating ───────────────────────────────────────────────────────
app.post('/api/quality/rate', async (req, res) => {
  const { requestId, scoreLabel, notes } = req.body
  const scoreMap = { good: 1.0, acceptable: 0.6, poor: 0.2 }
  const scoreNumeric = scoreMap[scoreLabel] ?? null
  try {
    await db.query(`
      INSERT INTO telemetry.quality_scores (request_id, evaluation_type, score_numeric, score_label, evaluator, notes)
      VALUES ($1, 'human', $2, $3, 'operator', $4)
    `, [requestId, scoreNumeric, scoreLabel, notes || null])
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Alerts ─────────────────────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT * FROM telemetry.alerts ORDER BY fired_at DESC LIMIT 100
    `)
    res.json({ alerts: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── SSE: live stream (system + agents every 2s) ───────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const interval = setInterval(async () => {
    try {
      const { rows: [sys] } = await db.query(`SELECT * FROM telemetry.system_samples ORDER BY sampled_at DESC LIMIT 1`)
      const { rows: runs }  = await db.query(`SELECT run_id, agent_name, status, started_at FROM telemetry.agent_runs WHERE ended_at IS NULL LIMIT 20`)
      res.write(`data: ${JSON.stringify({ system: sys || null, runs })}\n\n`)
    } catch (_) {}
  }, 2000)

  req.on('close', () => clearInterval(interval))
})

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' })
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ── Start ─────────────────────────────────────────────────────────────────────
alerts.start(db)

app.listen(PORT, () => {
  console.log(`[observe] dashboard at http://localhost:${PORT}`)
})

process.on('SIGINT', () => { alerts.stop(); db.end(); process.exit(0) })
```

- [ ] **Step 2: Implement alerts.js**

```js
// packages/observe/alerts.js
'use strict'

let db      = null
let timer   = null
// Baseline: rolling averages used for dynamic thresholds
const baseline = { gpu_power_mw: null, gpu_residency: null }

const RULES = [
  {
    name: 'gpu_residency_high',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT AVG(gpu_active_residency_pct) AS avg
        FROM telemetry.system_samples
        WHERE sampled_at > NOW() - INTERVAL '3 minutes'
      `)
      const avg = parseFloat(rows[0]?.avg)
      if (avg > 90) return `GPU active residency ${avg.toFixed(1)}% sustained >3 min`
      return null
    },
  },
  {
    name: 'gpu_power_high',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT AVG(gpu_power_mw) AS avg FROM telemetry.system_samples
        WHERE sampled_at > NOW() - INTERVAL '5 minutes'
      `)
      const avg = parseFloat(rows[0]?.avg)
      const threshold = baseline.gpu_power_mw ? baseline.gpu_power_mw * 1.5 : 30000
      if (avg > threshold) return `GPU power ${(avg/1000).toFixed(1)}W sustained >5 min (threshold ${(threshold/1000).toFixed(1)}W)`
      return null
    },
  },
  {
    name: 'zero_progress_loop',
    severity: 'critical',
    async check(db) {
      const { rows } = await db.query(`
        SELECT lr.agent_name, COUNT(*) AS req_count
        FROM telemetry.llm_requests lr
        JOIN telemetry.agent_runs ar ON ar.run_id = lr.run_id AND ar.ended_at IS NULL
        WHERE lr.started_at > NOW() - INTERVAL '10 minutes'
        GROUP BY lr.agent_name
        HAVING COUNT(*) > 5
      `)
      for (const row of rows) {
        const { rows: progress } = await db.query(`
          SELECT SUM(units_completed) AS total
          FROM telemetry.work_progress wp
          JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id AND ar.agent_name = $1
          WHERE wp.last_updated_at > NOW() - INTERVAL '10 minutes'
        `, [row.agent_name])
        const units = parseInt(progress[0]?.total || '0', 10)
        if (units === 0) return `Agent ${row.agent_name} made ${row.req_count} LLM requests with zero work-unit progress in 10 min`
      }
      return null
    },
  },
  {
    name: 'retry_storm',
    severity: 'warning',
    async check(db) {
      const { rows } = await db.query(`
        SELECT agent_name, SUM(retry_count) AS retries
        FROM telemetry.llm_requests
        WHERE started_at > NOW() - INTERVAL '5 minutes'
        GROUP BY agent_name
        HAVING SUM(retry_count) > 10
      `)
      if (rows.length > 0) return `Retry storm: ${rows.map(r => `${r.agent_name}(${r.retries})`).join(', ')}`
      return null
    },
  },
  {
    name: 'model_loaded_unused',
    severity: 'info',
    async check(db) {
      const { rows } = await db.query(`
        SELECT model_name FROM telemetry.model_sessions
        WHERE unloaded_at IS NULL
          AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '15 minutes')
          AND loaded_at < NOW() - INTERVAL '15 minutes'
      `)
      if (rows.length > 0) return `Model(s) loaded but idle >15 min: ${rows.map(r => r.model_name).join(', ')}`
      return null
    },
  },
  {
    name: 'telemetry_data_loss',
    severity: 'critical',
    async check(db) {
      const { rows } = await db.query(`
        SELECT SUM(value) AS dropped FROM telemetry.counters WHERE counter_name = 'dropped'
      `)
      const dropped = parseInt(rows[0]?.dropped || '0', 10)
      if (dropped > 0) return `Telemetry dropped ${dropped} events — check DB connectivity`
      return null
    },
  },
  {
    name: 'temperature_critical',
    severity: 'critical',
    async check(db) {
      const { rows } = await db.query(`
        SELECT MAX(cpu_temp_c) AS cpu, MAX(gpu_temp_c) AS gpu
        FROM telemetry.system_samples WHERE sampled_at > NOW() - INTERVAL '1 minute'
      `)
      const cpu = parseFloat(rows[0]?.cpu)
      const gpu = parseFloat(rows[0]?.gpu)
      if (cpu > 90) return `CPU temperature critical: ${cpu}°C`
      if (gpu > 90) return `GPU temperature critical: ${gpu}°C`
      return null
    },
  },
]

async function evaluateRules() {
  for (const rule of RULES) {
    try {
      const message = await rule.check(db)
      if (!message) continue
      // Check if this exact alert already fired in last 30 minutes (dedup)
      const { rows } = await db.query(`
        SELECT 1 FROM telemetry.alerts
        WHERE rule_name = $1 AND fired_at > NOW() - INTERVAL '30 minutes' AND resolved_at IS NULL
        LIMIT 1
      `, [rule.name])
      if (rows.length > 0) continue
      await db.query(`
        INSERT INTO telemetry.alerts (rule_name, severity, message)
        VALUES ($1, $2, $3)
      `, [rule.name, rule.severity, message])
      console.warn(`[alerts] ${rule.severity.toUpperCase()}: ${message}`)
    } catch (err) {
      console.warn(`[alerts] rule ${rule.name} error:`, err.message)
    }
  }
}

function start(dbInstance) {
  db    = dbInstance
  timer = setInterval(() => evaluateRules().catch(err => console.warn('[alerts]', err.message)), 30_000)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = { start, stop }
```

- [ ] **Step 3: Create the dashboard shell**

```html
<!-- packages/observe/public/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>secondbrain observe</title>
  <style>
    :root {
      --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
      --text: #e2e8f0; --dim: #64748b; --accent: #6366f1;
      --green: #22c55e; --yellow: #eab308; --red: #ef4444; --blue: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font: 14px/1.5 'SF Mono', 'Fira Code', monospace; }
    #app { display: flex; flex-direction: column; min-height: 100vh; }
    nav { display: flex; gap: 2px; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
    nav button { background: none; border: none; color: var(--dim); cursor: pointer; padding: 6px 14px; border-radius: 4px; font: inherit; }
    nav button.active { background: var(--accent); color: #fff; }
    main { flex: 1; padding: 20px; max-width: 1400px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin-bottom: 10px; }
    .metric { font-size: 28px; font-weight: 700; }
    .metric.warn { color: var(--yellow); }
    .metric.crit { color: var(--red); }
    .metric.ok   { color: var(--green); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; color: var(--dim); font-size: 11px; text-transform: uppercase; border-bottom: 1px solid var(--border); }
    td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
    tr:last-child td { border-bottom: none; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    .pill.running  { background: #166534; color: #86efac; }
    .pill.stopped  { background: #1e293b; color: var(--dim); }
    .pill.failed   { background: #7f1d1d; color: #fca5a5; }
    .pill.warning  { background: #713f12; color: #fde047; }
    .pill.critical { background: #7f1d1d; color: #fca5a5; }
    .pill.info     { background: #1e3a5f; color: #93c5fd; }
    .section { display: none; }
    .section.active { display: block; }
    .bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 4px; }
    .bar-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .3s; }
    .subtext { font-size: 11px; color: var(--dim); margin-top: 2px; }
    input, select { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 4px; font: inherit; }
    button.rate-btn { border: none; cursor: pointer; padding: 4px 10px; border-radius: 4px; font: 11px/1 inherit; margin: 0 2px; }
    .good-btn { background: #166534; color: #86efac; }
    .ok-btn   { background: #713f12; color: #fde047; }
    .poor-btn { background: #7f1d1d; color: #fca5a5; }
  </style>
</head>
<body>
<div id="app">
  <nav>
    <button class="active" data-view="overview">Overview</button>
    <button data-view="agents">Agents</button>
    <button data-view="models">Models</button>
    <button data-view="traces">Traces</button>
    <button data-view="quality">Quality</button>
  </nav>
  <main>
    <div id="overview" class="section active"></div>
    <div id="agents"   class="section"></div>
    <div id="models"   class="section"></div>
    <div id="traces"   class="section"></div>
    <div id="quality"  class="section"></div>
  </main>
</div>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create the dashboard app.js**

```js
// packages/observe/public/app.js
'use strict'

// ── Navigation ──────────────────────────────────────────────────────────────
const views = ['overview','agents','models','traces','quality']
let currentView = 'overview'

document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.view
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'))
    document.getElementById(currentView).classList.add('active')
    renderView(currentView)
  })
})

async function api(path) {
  const r = await fetch(path)
  return r.json()
}

// ── Rendering helpers ────────────────────────────────────────────────────────
function pct(val, warn=70, crit=90) {
  if (val == null) return '<span class="dim">—</span>'
  const cls = val >= crit ? 'crit' : val >= warn ? 'warn' : 'ok'
  return `<span class="metric ${cls}">${val.toFixed(1)}%</span>`
}
function mw(val) {
  if (val == null) return '—'
  return val >= 1000 ? `${(val/1000).toFixed(1)}W` : `${val}mW`
}
function pill(status) {
  return `<span class="pill ${status}">${status}</span>`
}
function bar(val, max=100) {
  const pct = Math.min(100, Math.round((val||0)/max*100))
  return `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`
}
function ago(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso))/1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  return `${Math.floor(s/3600)}h ago`
}

// ── Overview ─────────────────────────────────────────────────────────────────
async function renderOverview() {
  const el = document.getElementById('overview')
  const [sys, agents, alerts] = await Promise.all([
    api('/api/system'), api('/api/agents'), api('/api/alerts')
  ])
  const s = sys.sample || {}
  const recent = (alerts.alerts||[]).filter(a => !a.resolved_at).slice(0,5)
  el.innerHTML = `
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <h3>GPU</h3>
        ${pct(s.gpu_active_residency_pct, 70, 90)}
        <div class="subtext">Power: ${mw(s.gpu_power_mw)} &nbsp; ANE: ${mw(s.ane_power_mw)}</div>
      </div>
      <div class="card">
        <h3>CPU</h3>
        ${pct(s.cpu_util_pct, 70, 90)}
        <div class="subtext">Power: ${mw(s.cpu_power_mw)}</div>
      </div>
      <div class="card">
        <h3>Memory</h3>
        <span class="metric">${s.mem_used_mb ? Math.round(s.mem_used_mb/1024)+'GB' : '—'}</span>
        <div class="subtext">Swap: ${s.swap_used_mb ? Math.round(s.swap_used_mb/1024)+'GB' : '0'} &nbsp; Thermal: ${s.thermal_state||'—'}</div>
      </div>
      <div class="card">
        <h3>Loaded Models</h3>
        <span class="metric">${sys.models.length}</span>
        <div class="subtext">${sys.models.map(m=>m.model_name).join(', ')||'none'}</div>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <h3>Active Agents</h3>
        <table>
          <tr><th>Agent</th><th>Status</th><th>Since</th></tr>
          ${(agents.runs||[]).filter(r=>!r.ended_at).map(r=>`
            <tr><td>${r.agent_name}</td><td>${pill('running')}</td><td>${ago(r.started_at)}</td></tr>
          `).join('')||'<tr><td colspan="3" style="color:var(--dim)">No active agents</td></tr>'}
        </table>
      </div>
      <div class="card">
        <h3>Recent Alerts</h3>
        ${recent.length === 0 ? '<div style="color:var(--green)">No active alerts</div>' :
          recent.map(a=>`<div style="margin-bottom:8px">${pill(a.severity)} ${a.message} <span class="subtext">${ago(a.fired_at)}</span></div>`).join('')}
      </div>
    </div>
  `
}

// ── Agents ───────────────────────────────────────────────────────────────────
async function renderAgents() {
  const el = document.getElementById('agents')
  const { runs, progress } = await api('/api/agents')
  const progressByRun = {}
  for (const p of (progress||[])) {
    if (!progressByRun[p.run_id]) progressByRun[p.run_id] = []
    progressByRun[p.run_id].push(p)
  }
  el.innerHTML = `
    <table>
      <tr><th>Agent</th><th>Status</th><th>Stage</th><th>Progress</th><th>Errors</th><th>Started</th></tr>
      ${(runs||[]).map(r => {
        const stages = progressByRun[r.run_id] || []
        const latest = stages[stages.length-1]
        const pctDone = latest?.units_total ? Math.round(latest.units_completed/latest.units_total*100) : null
        const status = r.ended_at ? r.status : 'running'
        return `<tr>
          <td>${r.agent_name}</td>
          <td>${pill(status)}</td>
          <td>${latest?.stage_name||'—'}</td>
          <td>
            ${latest ? `${latest.units_completed}${latest.units_total ? '/'+latest.units_total : ''}` : '—'}
            ${pctDone != null ? bar(pctDone) : ''}
            ${latest?.eta_seconds ? `<div class="subtext">ETA ~${Math.round(latest.eta_seconds/60)}m</div>` : ''}
          </td>
          <td>${r.error_count||0}</td>
          <td>${ago(r.started_at)}</td>
        </tr>`
      }).join('')||'<tr><td colspan="6" style="color:var(--dim)">No runs yet</td></tr>'}
    </table>
  `
}

// ── Models ───────────────────────────────────────────────────────────────────
async function renderModels() {
  const el = document.getElementById('models')
  const { stats, sessions } = await api('/api/models')
  el.innerHTML = `
    <div style="margin-bottom:16px">
      <h3 style="margin-bottom:10px;color:var(--dim);font-size:11px;text-transform:uppercase">Session Stats</h3>
      <table>
        <tr><th>Model</th><th>Requests</th><th>Tokens In</th><th>Tokens Out</th><th>Avg Latency</th><th>Errors</th><th>Last Used</th></tr>
        ${(stats||[]).map(s=>`<tr>
          <td>${s.model||'—'}</td>
          <td>${s.total_requests}</td>
          <td>${(s.total_prompt_tokens||0).toLocaleString()}</td>
          <td>${(s.total_completion_tokens||0).toLocaleString()}</td>
          <td>${s.avg_latency_ms ? s.avg_latency_ms+'ms' : '—'}</td>
          <td>${s.error_count||0}</td>
          <td>${ago(s.last_used_at)}</td>
        </tr>`).join('')||'<tr><td colspan="7" style="color:var(--dim)">No model data yet</td></tr>'}
      </table>
    </div>
    <div>
      <h3 style="margin-bottom:10px;color:var(--dim);font-size:11px;text-transform:uppercase">Loaded Sessions</h3>
      <table>
        <tr><th>Model</th><th>Loaded</th><th>Last Used</th><th>Unloaded</th></tr>
        ${(sessions||[]).slice(0,20).map(s=>`<tr>
          <td>${s.model_name}</td>
          <td>${ago(s.loaded_at)}</td>
          <td>${ago(s.last_used_at)}</td>
          <td>${s.unloaded_at ? ago(s.unloaded_at) : '<span class="pill running">loaded</span>'}</td>
        </tr>`).join('')||'<tr><td colspan="4" style="color:var(--dim)">No sessions</td></tr>'}
      </table>
    </div>
  `
}

// ── Traces ───────────────────────────────────────────────────────────────────
let traceFilters = { agent: '', model: '', success: '' }

async function renderTraces() {
  const el = document.getElementById('traces')
  const params = new URLSearchParams()
  if (traceFilters.agent)   params.set('agent', traceFilters.agent)
  if (traceFilters.model)   params.set('model', traceFilters.model)
  if (traceFilters.success !== '') params.set('success', traceFilters.success)
  params.set('limit', '50')
  const { requests } = await api('/api/requests?' + params)
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input placeholder="Agent" value="${traceFilters.agent}" oninput="traceFilters.agent=this.value;renderView('traces')" style="width:140px">
      <input placeholder="Model" value="${traceFilters.model}" oninput="traceFilters.model=this.value;renderView('traces')" style="width:160px">
      <select onchange="traceFilters.success=this.value;renderView('traces')">
        <option value="">All</option>
        <option value="true" ${traceFilters.success==='true'?'selected':''}>Success</option>
        <option value="false" ${traceFilters.success==='false'?'selected':''}>Failures</option>
      </select>
    </div>
    <table>
      <tr><th>Agent</th><th>Model</th><th>Task</th><th>Status</th><th>Tokens</th><th>Latency</th><th>Preview</th><th>When</th></tr>
      ${(requests||[]).map(r=>`<tr>
        <td>${r.agent_name}</td>
        <td>${r.model||'—'}</td>
        <td>${r.task_type||'—'}</td>
        <td>${pill(r.success ? 'running' : 'failed')}</td>
        <td>${(r.prompt_tokens||0)+(r.completion_tokens||0)}</td>
        <td>${r.duration_ms ? r.duration_ms+'ms' : '—'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.output_preview||r.prompt_preview||'—'}</td>
        <td>${ago(r.started_at)}</td>
      </tr>`).join('')||'<tr><td colspan="8" style="color:var(--dim)">No traces yet</td></tr>'}
    </table>
  `
}

// ── Quality ──────────────────────────────────────────────────────────────────
async function renderQuality() {
  const el = document.getElementById('quality')
  const { comparison } = await api('/api/quality')
  el.innerHTML = `
    <table>
      <tr><th>Model</th><th>Agent</th><th>Task</th><th>Total</th><th>Errors</th><th>Avg Retries</th><th>Structural</th><th>Human</th></tr>
      ${(comparison||[]).map(r=>`<tr>
        <td>${r.model||'—'}</td>
        <td>${r.agent_name}</td>
        <td>${r.task_type||'—'}</td>
        <td>${r.total}</td>
        <td>${r.errors||0}</td>
        <td>${r.avg_retries ? parseFloat(r.avg_retries).toFixed(2) : '0'}</td>
        <td>${r.avg_structural ? parseFloat(r.avg_structural).toFixed(2) : '—'}</td>
        <td>${r.avg_human ? parseFloat(r.avg_human).toFixed(2) : '—'}</td>
      </tr>`).join('')||'<tr><td colspan="8" style="color:var(--dim)">No quality data yet</td></tr>'}
    </table>
    <div style="margin-top:20px">
      <h3 style="color:var(--dim);font-size:11px;text-transform:uppercase;margin-bottom:10px">Rate Recent Traces</h3>
      <div id="rate-panel">Loading traces for rating...</div>
    </div>
  `
  const ratePanel = document.getElementById('rate-panel')
  const { requests } = await api('/api/requests?limit=20')
  ratePanel.innerHTML = `
    <table>
      <tr><th>Agent</th><th>Model</th><th>Preview</th><th>Rate</th></tr>
      ${(requests||[]).map(r=>`<tr>
        <td>${r.agent_name}</td>
        <td>${r.model||'—'}</td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.output_preview||'—'}</td>
        <td>
          <button class="rate-btn good-btn" onclick="rate('${r.request_id}','good')">Good</button>
          <button class="rate-btn ok-btn"   onclick="rate('${r.request_id}','acceptable')">OK</button>
          <button class="rate-btn poor-btn" onclick="rate('${r.request_id}','poor')">Poor</button>
        </td>
      </tr>`).join('')||'<tr><td colspan="4" style="color:var(--dim)">No traces</td></tr>'}
    </table>
  `
}

async function rate(requestId, label) {
  await fetch('/api/quality/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, scoreLabel: label })
  })
  renderView('quality')
}

// ── View dispatcher ──────────────────────────────────────────────────────────
function renderView(view) {
  switch(view) {
    case 'overview': return renderOverview()
    case 'agents':   return renderAgents()
    case 'models':   return renderModels()
    case 'traces':   return renderTraces()
    case 'quality':  return renderQuality()
  }
}

// ── Auto-refresh overview with SSE ───────────────────────────────────────────
const sse = new EventSource('/api/stream')
sse.onmessage = () => { if (currentView === 'overview') renderOverview() }

// Initial render
renderView('overview')
```

- [ ] **Step 5: Test observe server starts**

```bash
cd /Users/prateeksureka/Sites/secondbrain
node packages/observe/server.js &
sleep 2
curl -s http://localhost:4002/api/system | python3 -m json.tool | head -5
kill %1
```

Expected: JSON response with `sample`, `models`, `counters` keys.

- [ ] **Step 6: Add "Open Observe →" link to agents page**

In `packages/ui/app/agents/page.jsx`, find the component's return statement. Add somewhere near the top of the JSX (after any header):

```jsx
<a
  href="http://localhost:4002"
  target="_blank"
  rel="noopener noreferrer"
  style={{
    display: 'inline-block',
    marginBottom: '1rem',
    fontSize: '0.8125rem',
    color: 'var(--text)',
    opacity: 0.6,
    textDecoration: 'none',
    border: '1px solid var(--border)',
    padding: '4px 12px',
    borderRadius: '4px',
  }}
>
  Open Observe →
</a>
```

- [ ] **Step 7: Commit Phase 1**

```bash
git add packages/observe/ packages/ui/app/agents/page.jsx
git commit -m "feat(observe): Express server, alert rules, vanilla-JS dashboard (5 views)"
```

---

## Phase 2 — Work Visibility

---

### Task 9: Instrument Agent Work Units

**Files:**
- Modify: `packages/agents/relationships/index.js`
- Modify: `packages/agents/projects/index.js`
- Modify: `packages/agents/limitless/index.js`
- Modify: `packages/agents/email/index.js` (or `packages/agents/email/cron/fetchEmails.js`)

The pattern for every agent is the same: call `telemetry.startRun()` at startup, `telemetry.progress()` at each stage, `telemetry.endRun()` on shutdown.

- [ ] **Step 1: Instrument relationships/index.js**

At the top of the file after existing requires, add:

```js
let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null
```

In the agent's `main` (or wherever the main processing loop starts), add run start and progress calls. Find where `upsertContact` or analysis functions are called in bulk, and wrap:

```js
// Near the top of the main processing section, before the big loop:
if (telemetry) {
  _runId = await telemetry.startRun({ agentId: 'relationships', workflowName: 'relationship_analysis' })
}

// Inside processing loops, after each contact is processed:
if (telemetry && _runId) {
  telemetry.progress(_runId, 'people_matched', {
    completed: processedCount,
    total: totalContacts,
  })
}
```

Add to shutdown handler:
```js
if (telemetry && _runId) {
  await telemetry.flush()
  await telemetry.endRun(_runId, { status: 'completed' })
}
```

- [ ] **Step 2: Instrument projects/index.js**

Same pattern. Stages for projects agent:

```js
let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null

// At startup:
if (telemetry) _runId = await telemetry.startRun({ agentId: 'projects', workflowName: 'project_discovery' })

// After tasks_extracted phase completes:
if (telemetry && _runId) telemetry.progress(_runId, 'tasks_extracted', { completed: extractedCount })

// After projects_created phase:
if (telemetry && _runId) telemetry.progress(_runId, 'projects_created', { completed: projectCount })

// On shutdown:
if (telemetry && _runId) { await telemetry.flush(); await telemetry.endRun(_runId) }
```

- [ ] **Step 3: Instrument limitless/index.js**

```js
let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null

// After existing startup:
if (telemetry) _runId = await telemetry.startRun({ agentId: 'limitless', workflowName: 'lifelog_processing' })

// In processBatch success callback:
if (telemetry && _runId) telemetry.progress(_runId, 'transcripts_processed', { completed: batchCount })

// In fetchLifelogs success callback:
if (telemetry && _runId) telemetry.progress(_runId, 'recordings_imported', { completed: fetchedCount })

// In SIGINT handler (before process.exit):
if (telemetry && _runId) { await telemetry.flush(); await telemetry.endRun(_runId) }
```

- [ ] **Step 4: Instrument email/index.js**

```js
let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null

// At startup:
if (telemetry) _runId = await telemetry.startRun({ agentId: 'email', workflowName: 'email_sync' })

// After emails discovered:
if (telemetry && _runId) telemetry.progress(_runId, 'emails_discovered', { completed: discoveredCount, total: totalInMailbox })

// After emails fetched/parsed:
if (telemetry && _runId) telemetry.progress(_runId, 'emails_downloaded', { completed: downloadedCount })

// On shutdown:
if (telemetry && _runId) { await telemetry.flush(); await telemetry.endRun(_runId) }
```

- [ ] **Step 5: Verify agents still start**

```bash
cd /Users/prateeksureka/Sites/secondbrain
node -e "
require('dotenv').config({ path: '.env.local' });
const rel = require('./packages/agents/relationships/index.js');
" 2>&1 | head -5 &
sleep 2
kill %1
```

Expected: agent starts, no crash related to telemetry.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/relationships/index.js packages/agents/projects/index.js packages/agents/limitless/index.js packages/agents/email/index.js
git commit -m "feat(telemetry): instrument agent work units (startRun/progress/endRun)"
```

---

### Task 10: ETA Calculations in Collector

**Files:**
- Modify: `packages/collector/index.js`

The collector computes rolling rate and ETA for work_progress rows that have a total.

- [ ] **Step 1: Add ETA computation to collector**

In `packages/collector/index.js`, add an ETA update loop after the existing `scanAndReplay` call:

```js
// Run every 60 seconds: compute rolling rate and ETA for active runs
setInterval(async () => {
  try {
    // Get all active runs with progress data
    const { rows: activeProgress } = await db.query(`
      SELECT wp.run_id, wp.stage_name, wp.units_completed, wp.units_total,
             wp.last_updated_at, ar.started_at
      FROM telemetry.work_progress wp
      JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
      WHERE ar.ended_at IS NULL
        AND wp.units_completed > 0
    `)
    for (const row of activeProgress) {
      // Rate: units completed / minutes elapsed
      const elapsedMin = (Date.now() - new Date(row.started_at)) / 60000
      if (elapsedMin < 0.1) continue
      const rate = parseFloat((row.units_completed / elapsedMin).toFixed(3))
      let eta = null
      if (row.units_total && rate > 0) {
        const remaining = row.units_total - row.units_completed
        eta = remaining > 0 ? Math.round(remaining / rate * 60) : 0 // seconds
      }
      await db.query(`
        UPDATE telemetry.work_progress
        SET rate_units_per_min = $1, eta_seconds = $2
        WHERE run_id = $3 AND stage_name = $4
      `, [rate, eta, row.run_id, row.stage_name])
    }

    // Compute work_efficiency
    const { rows: effRows } = await db.query(`
      SELECT wp.run_id, wp.stage_name, wp.units_completed,
             SUM(lr.prompt_tokens + lr.completion_tokens) AS total_tokens,
             SUM(lr.duration_ms) AS total_ms,
             COUNT(lr.request_id) AS req_count,
             COUNT(lr.request_id) FILTER (WHERE lr.success = false) AS fail_count
      FROM telemetry.work_progress wp
      JOIN telemetry.agent_runs ar ON ar.run_id = wp.run_id
      JOIN telemetry.llm_requests lr ON lr.run_id = wp.run_id
      WHERE ar.ended_at IS NULL AND wp.units_completed > 0
      GROUP BY wp.run_id, wp.stage_name, wp.units_completed
    `)
    for (const r of effRows) {
      const units = r.units_completed
      if (!units) continue
      await db.query(`
        INSERT INTO telemetry.work_efficiency (run_id, stage_name, tokens_per_unit, ms_per_unit, requests_per_unit, failures_per_unit, computed_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (run_id, stage_name) DO UPDATE SET
          tokens_per_unit = EXCLUDED.tokens_per_unit,
          ms_per_unit     = EXCLUDED.ms_per_unit,
          requests_per_unit = EXCLUDED.requests_per_unit,
          failures_per_unit = EXCLUDED.failures_per_unit,
          computed_at     = NOW()
      `, [
        r.run_id, r.stage_name,
        parseFloat((r.total_tokens / units).toFixed(2)),
        parseFloat((r.total_ms     / units).toFixed(2)),
        parseFloat((r.req_count    / units).toFixed(4)),
        parseFloat((r.fail_count   / units).toFixed(4)),
      ])
    }
  } catch (err) {
    console.warn('[collector] ETA/efficiency update error:', err.message)
  }
}, 60_000)
```

- [ ] **Step 2: Commit**

```bash
git add packages/collector/index.js
git commit -m "feat(collector): rolling ETA computation and work_efficiency derived metrics"
```

---

## Phase 3 — Quality Evaluation

---

### Task 11: Automatic Structural Quality Scoring

**Files:**
- Create: `packages/telemetry/quality.js`
- Modify: `packages/agents/shared/llm.js`

- [ ] **Step 1: Create quality.js**

```js
// packages/telemetry/quality.js
'use strict'

/**
 * Run automatic structural quality checks on an LLM output.
 * Returns { score: 0.0–1.0, issues: string[] }
 */
function scoreStructural(output, { expectJson = false, schema = null } = {}) {
  const issues = []
  if (!output || output.trim().length === 0) {
    return { score: 0, issues: ['empty output'] }
  }

  if (!expectJson) {
    return { score: 1, issues: [] }
  }

  // Try to parse JSON
  let parsed = null
  try {
    // Handle markdown code blocks
    const raw = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
    parsed = JSON.parse(raw)
  } catch (_) {
    issues.push('invalid JSON')
    return { score: 0, issues }
  }

  if (parsed === null) {
    issues.push('null output')
    return { score: 0.1, issues }
  }

  // Schema compliance check (simple: required top-level keys present)
  if (schema && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(key in parsed)) issues.push(`missing required key: ${key}`)
    }
  }

  // Truncation heuristic: output ends mid-sentence or structure is incomplete
  const str = typeof output === 'string' ? output : JSON.stringify(output)
  if (str.length > 100 && !str.trimEnd().endsWith('}') && !str.trimEnd().endsWith(']')) {
    issues.push('possible truncation')
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0.1, 1 - issues.length * 0.25)
  return { score: parseFloat(score.toFixed(2)), issues }
}

module.exports = { scoreStructural }
```

- [ ] **Step 2: Write test**

Add to `packages/telemetry/test/sdk.test.js`:

```js
const { scoreStructural } = require('../quality')

test('scoreStructural: valid JSON returns score 1', () => {
  const { score } = scoreStructural('{"a":1}', { expectJson: true })
  assert.equal(score, 1)
})

test('scoreStructural: invalid JSON returns score 0', () => {
  const { score, issues } = scoreStructural('not json at all', { expectJson: true })
  assert.equal(score, 0)
  assert.ok(issues.includes('invalid JSON'))
})

test('scoreStructural: missing required key reduces score', () => {
  const { score } = scoreStructural('{"a":1}', { expectJson: true, schema: { required: ['a','b'] } })
  assert.ok(score < 1)
})
```

- [ ] **Step 3: Run tests**

```bash
node --test packages/telemetry/test/sdk.test.js
```

Expected: all tests pass including new quality ones.

- [ ] **Step 4: Integrate quality scoring into llm.js**

In `packages/agents/shared/llm.js`, in the `create()` success path, after calling `req.finish()`, add:

```js
      // Automatic structural quality check for JSON-expecting task types
      const t2 = getTelemetry()
      if (t2 && req && result.text) {
        const expectJson = (_taskType || '').toLowerCase().includes('extract') ||
                           (_taskType || '').toLowerCase().includes('classify') ||
                           (_taskType || '').toLowerCase().includes('json')
        if (expectJson) {
          let qModule = null
          try { qModule = require('@secondbrain/telemetry/quality') } catch (_) {}
          if (qModule) {
            const { score, issues } = qModule.scoreStructural(result.text, { expectJson: true })
            t2.recordQuality({
              requestId: req.requestId,
              evaluationType: 'structural',
              scoreNumeric: score,
              scoreLabel: score === 1 ? 'valid' : issues[0] || 'invalid',
              evaluator: 'auto',
              notes: issues.length ? issues.join('; ') : null,
            })
          }
        }
      }
```

- [ ] **Step 5: Commit**

```bash
git add packages/telemetry/quality.js packages/agents/shared/llm.js
git commit -m "feat(quality): automatic structural quality scoring for JSON-expecting tasks"
```

---

## Phase 4 — Alerts + Controls

---

### Task 12: Dynamic Alert Baselines

**Files:**
- Modify: `packages/observe/alerts.js`

The GPU power baseline is computed from the last 24h of `system_samples`. This prevents false alerts when a machine normally runs hot.

- [ ] **Step 1: Add baseline refresh to alerts.js**

After the `RULES` array, before `evaluateRules`, add:

```js
async function refreshBaseline() {
  try {
    const { rows } = await db.query(`
      SELECT
        AVG(gpu_power_mw) AS gpu_power,
        AVG(gpu_active_residency_pct) AS gpu_residency
      FROM telemetry.system_samples
      WHERE sampled_at > NOW() - INTERVAL '24 hours'
        AND gpu_power_mw > 0
    `)
    if (rows[0]?.gpu_power)    baseline.gpu_power_mw  = parseFloat(rows[0].gpu_power)
    if (rows[0]?.gpu_residency) baseline.gpu_residency = parseFloat(rows[0].gpu_residency)
  } catch (_) {}
}
```

In `start()`, refresh baseline once at startup and every hour:

```js
function start(dbInstance) {
  db    = dbInstance
  refreshBaseline()
  setInterval(refreshBaseline, 60 * 60 * 1000)
  timer = setInterval(() => evaluateRules().catch(err => console.warn('[alerts]', err.message)), 30_000)
}
```

- [ ] **Step 2: Add alert for telemetry data loss (missing system samples)**

Add to the `RULES` array:

```js
{
  name: 'sampler_not_running',
  severity: 'warning',
  async check(db) {
    const { rows } = await db.query(`
      SELECT COUNT(*) AS cnt FROM telemetry.system_samples
      WHERE sampled_at > NOW() - INTERVAL '2 minutes'
    `)
    if (parseInt(rows[0]?.cnt || '0', 10) === 0) {
      return 'No system samples in last 2 minutes — is the sampler running?'
    }
    return null
  },
},
```

- [ ] **Step 3: Commit**

```bash
git add packages/observe/alerts.js
git commit -m "feat(alerts): dynamic GPU power baseline, sampler health check alert"
```

---

### Task 13: Data Retention Cleanup

**Files:**
- Modify: `packages/collector/index.js`

- [ ] **Step 1: Add retention cleanup to collector**

Append to `packages/collector/index.js`:

```js
// Run daily: enforce retention policy
setInterval(async () => {
  try {
    // Full traces: 7 days
    await db.query(`DELETE FROM telemetry.llm_request_samples WHERE stored_at < NOW() - INTERVAL '7 days'`)
    // Request metadata: 30 days
    await db.query(`DELETE FROM telemetry.llm_requests WHERE started_at < NOW() - INTERVAL '30 days'`)
    // System samples raw: 7 days
    await db.query(`DELETE FROM telemetry.system_samples WHERE sampled_at < NOW() - INTERVAL '7 days'`)
    // Alerts: 30 days
    await db.query(`DELETE FROM telemetry.alerts WHERE fired_at < NOW() - INTERVAL '30 days'`)
    console.log('[collector] retention cleanup complete')
  } catch (err) {
    console.warn('[collector] retention cleanup error:', err.message)
  }
}, 24 * 60 * 60 * 1000)
```

- [ ] **Step 2: Commit**

```bash
git add packages/collector/index.js
git commit -m "feat(collector): data retention cleanup (7d traces, 30d metadata, 7d samples)"
```

---

### Task 14: Verify End-to-End and Update CLAUDE.md

- [ ] **Step 1: Start all processes and verify**

In four terminals:
```bash
# Terminal 1
npm run ui:dev

# Terminal 2
npm run collector

# Terminal 3 (needs sudo configured)
npm run sampler

# Terminal 4
npm run observe
```

- [ ] **Step 2: Verify telemetry tables have data after running one agent**

```bash
npm run relationships &
sleep 30
kill %1
node -e "
require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
Promise.all([
  db.query('SELECT COUNT(*) FROM telemetry.agent_runs'),
  db.query('SELECT COUNT(*) FROM telemetry.llm_requests'),
  db.query('SELECT COUNT(*) FROM telemetry.system_samples'),
]).then(([runs, reqs, sys]) => {
  console.log('agent_runs:', runs.rows[0].count);
  console.log('llm_requests:', reqs.rows[0].count);
  console.log('system_samples:', sys.rows[0].count);
  db.end();
})
"
```

Expected: all counts > 0.

- [ ] **Step 3: Open dashboard and verify all 5 views render**

```bash
open http://localhost:4002
```

Check: Overview shows GPU%, CPU%, loaded models. Agents view shows the relationships run. Traces view shows LLM requests. No JS console errors.

- [ ] **Step 4: Update CLAUDE.md commands section**

Add these entries to the `## Commands` section:

```bash
npm run collector       # Telemetry collector (replays spilled events, computes ETAs)
npm run sampler         # System metrics sampler (requires sudo)
npm run observe         # Observability dashboard (port 4002)
```

- [ ] **Step 5: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: add collector/sampler/observe to CLAUDE.md commands"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| No silent failure — telemetry_counters | Task 3 (buffer counts), Task 4 (SDK), Task 9 exposes via /api/system |
| SDK → Buffer → Collector → DB pipeline | Tasks 3, 4, 6 |
| Privileged sampler only (no HTTP with sudo) | Task 7: sampler writes to DB only, observe is separate unprivileged process |
| model_sessions with session_id UUID per load | Task 1 (schema), Task 7 (sampler updates sessions) |
| work_efficiency derived metrics | Task 10 (collector computes) |
| Dynamic alert thresholds from baseline | Task 12 |
| 5 dashboard views | Task 8 |
| All 4 implementation phases | Phases 1–4 above |
| Quality scoring (structural + human rating) | Tasks 11, 8 (human rating UI in quality view) |
| Retention policy | Task 13 |
| telemetry_counters tracking dropped/written | Task 3 (buffer), Task 4 (SDK), Task 6 (collector) |
| ETA only when total known and stable | Task 10 (null eta when no total) |
| Causal link: compute → requests → work units → outcomes | run_id FK on llm_requests + work_progress + work_efficiency |
| macOS Apple Silicon, no material slowdown | All telemetry writes are fire-and-forget (buffer.enqueue never awaited) |

**No placeholders found.**

**Type consistency:** `startRequest()` returns handle with `finish()` — used consistently in llm.js. `startRun()` returns `runId` string — used in progress() and endRun() consistently. `writeBatch(events)` called in both buffer drain and collector — same function from `packages/telemetry/writer.js`.
