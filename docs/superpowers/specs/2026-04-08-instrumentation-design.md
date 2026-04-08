# Instrumentation & Observability Design

**Date:** 2026-04-08  
**Status:** Approved

## Summary

Add a full observability layer to the secondbrain multi-agent system so the operator can answer in real time: which agents are running, which models are loaded, how much work is being done, how fast it is progressing, how much compute it is consuming, and whether output quality justifies resource cost.

---

## Architecture

```
packages/
├── telemetry/              @secondbrain/telemetry SDK
│   ├── index.js            Public API: startRun, endRun, startRequest, progress, recordQuality
│   ├── ids.js              Trace/request ID generation (crypto.randomUUID)
│   └── writer.js           Fire-and-forget Postgres writes (never throws)
│
├── observe/                Dashboard process (port 4002, runs with sudo for powermetrics)
│   ├── server.js           Express API + SSE stream
│   ├── sampler.js          Background system poller (powermetrics, ollama ps, ps)
│   ├── alerts.js           Alert rule evaluator (runs every 30s)
│   └── app/                React SPA (5 dashboard views, Vite build)
│
└── agents/shared/
    └── llm.js              MODIFIED: wraps create() through telemetry SDK
```

**Data flow:**
1. Agent calls `llm.create(agentId, opts)` → SDK records start time, emits to Postgres on completion
2. Agent calls `telemetry.progress(runId, stage, { completed, total })` at key stages
3. `observe/sampler.js` runs `powermetrics` + `ollama ps` on schedule, writes `system_samples`
4. `observe/server.js` queries Postgres, serves JSON to React dashboard + SSE for live views
5. Existing UI at port 4000 links to `http://localhost:4002`

---

## Database Schema

New `telemetry` schema, auto-migrated on startup alongside existing schemas.

### Tables

**`telemetry.agent_runs`**
- `run_id` UUID PK, `agent_name`, `workflow_name`, `started_at`, `ended_at`, `status`, `host_name`, `pid`, `config_version`

**`telemetry.llm_requests`**
- `request_id` UUID PK, `trace_id`, `run_id` FK, `agent_name`, `workflow_name`, `task_type`, `model`, `provider_type`, `prompt_template_version`
- `started_at`, `ended_at`, `duration_ms`, `prompt_tokens`, `completion_tokens`, `total_tokens`
- `input_chars`, `output_chars`, `success` bool, `error_type`, `retry_count`, `stream_mode`
- `prompt_hash`, `output_hash`, `prompt_preview` (500 chars), `output_preview` (500 chars)
- `full_trace_stored` bool

**`telemetry.llm_request_samples`**
- `request_id` FK, `full_prompt`, `full_output`, `stored_at`

**`telemetry.work_progress`**
- `progress_id` BIGSERIAL PK, `run_id` FK, `stage_name`, `units_total`, `units_completed`, `units_failed`, `units_skipped`, `rate_units_per_min`, `eta_seconds`, `last_updated_at`

**`telemetry.system_samples`**
- `sampled_at` TIMESTAMPTZ, `cpu_power_mw`, `gpu_power_mw`, `ane_power_mw`, `gpu_active_residency_pct`, `gpu_idle_residency_pct`, `cpu_util_pct`, `mem_used_mb`, `swap_used_mb`, `gpu_freq_mhz`, `cpu_temp_c`, `gpu_temp_c`, `fan_rpm`, `thermal_state`

**`telemetry.model_sessions`**
- `model_name` PK, `loaded_at`, `last_used_at`, `unloaded_at`, `total_requests`, `total_prompt_tokens`, `total_completion_tokens`, `cumulative_duration_ms`

**`telemetry.quality_scores`**
- `quality_id` BIGSERIAL PK, `request_id` FK, `evaluation_type` (structural/task/human), `score_numeric`, `score_label`, `evaluator`, `notes`, `created_at`

**`telemetry.alerts`**
- `alert_id` BIGSERIAL PK, `rule_name`, `severity`, `message`, `context` JSONB, `fired_at`, `resolved_at`

**TimescaleDB:** If available, `create_hypertable` is called on `system_samples` (partition by `sampled_at`) and `llm_requests` (partition by `started_at`). Wrapped in exception handler — silently skips if not installed.

`system.llm_usage` is preserved unchanged for backward compatibility.

---

## Telemetry SDK

Thin write-only library. All DB writes fire-and-forget — never throws, never blocks agents.

### Public API

```js
const telemetry = require('@secondbrain/telemetry')

// Agent lifecycle
const runId = await telemetry.startRun({ agentId, workflowName, pid, configVersion })
await telemetry.endRun(runId, { status })  // 'completed' | 'failed' | 'cancelled'

// LLM call instrumentation (used inside llm.js)
const req = telemetry.startRequest({ agentId, runId, taskType, model, providerType,
                                     promptPreview, promptHash, streamMode })
await req.finish({ tokensIn, tokensOut, durationMs, status, errorType, retryCount,
                   outputPreview, outputHash, shouldStoreFull, fullPrompt, fullOutput })

// Work-unit progress (called by agents at stage transitions)
telemetry.progress(runId, stageName, { completed, total, failed, skipped })

// Quality scoring
telemetry.recordQuality({ requestId, evaluationType, scoreNumeric, scoreLabel, evaluator, notes })
```

### Sampling Policy

Full prompt/output stored when any of:
- `status !== 'success'` (error, timeout, cancelled)
- `retry_count > 0`
- Output expected to be JSON but failed to parse
- Quality score below threshold (configurable, default 0.5)
- `system.config` key `telemetry.debug_agents` includes this agent
- Random sample: configurable rate (default 2%), stratified by agent+model

---

## System Sampler

Three polling loops in `observe/sampler.js`:

| Loop | Interval | Source | Metrics |
|------|----------|--------|---------|
| Fast | 1s | `powermetrics` (persistent child, plist output) | CPU/GPU power, GPU residency, ANE power, temps, fan |
| Medium | 5s | `ps aux` | Per-process CPU/RAM for ollama + node agents |
| Slow | 15s | `ollama ps`, `vm_stat` | Loaded models, memory pressure, swap |

`powermetrics` is spawned once as a persistent child process (`powermetrics --samplers cpu_power,gpu_power -i 1000 -f plist`), not re-spawned per sample. Output parsed incrementally.

---

## Alert Rules

Evaluated every 30s in `observe/alerts.js`. Thresholds configurable via `system.config`.

| Rule | Default threshold |
|------|------------------|
| GPU residency high | >90% for 3+ min |
| GPU power high | >30W for 5+ min |
| Zero-progress loop | LLM calls but no work_progress increments for 10+ min |
| Retry storm | >10 retries in 5 min for one agent |
| Model loaded unused | Loaded but no requests for 15+ min |
| JSON parse failure spike | >20% failure rate in 30 min |
| Temperature critical | CPU or GPU temp >90°C |
| Swap growing | Monotonically increasing for 5+ samples |

---

## Observe Server (port 4002)

Express server + static React SPA. Runs as a separate process with sudo privileges (for `powermetrics`).

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/system` | Latest system sample + loaded models |
| `GET /api/agents` | Active runs + per-agent progress |
| `GET /api/requests` | Paginated/filtered llm_requests |
| `GET /api/models` | Model session stats |
| `GET /api/quality` | Quality scores + model comparison |
| `GET /api/alerts` | Recent alerts |
| `GET /api/stream` | SSE: system samples + agent state every 2s |

### Dashboard Views (React SPA)

1. **Overview** — machine status badge, GPU%, CPU%, temp, power draw, top active agents, loaded models, requests/min, tokens/min, work units/min, ETA per workflow, recent failures, worst-quality outputs in last hour
2. **Agents** — per-agent: status pill, current stage, active model, items processed, rate, ETA, last error, last success time
3. **Models** — per model: loaded state, loaded since, total requests, token totals, avg latency, tokens/sec, error rate
4. **Traces** — filterable request log (by agent, model, task type, status, latency, quality, date range); shows metadata, previews, sampled full traces
5. **Quality** — model comparison table: success rate, parse validity, retry rate, human ratings, avg latency, tokens used; human review UI (good/acceptable/poor buttons per trace)

---

## Agent Work-Unit Instrumentation

Each agent emits `telemetry.progress()` at its natural processing stages:

| Agent | Stages |
|-------|--------|
| email | discovered → downloaded → parsed → classified → embedded → linked |
| whatsapp | chats_scanned → messages_extracted → media_processed → threads_summarized → entities_extracted |
| limitless | recordings_imported → transcripts_processed → key_moments_extracted → actions_inferred |
| relationships | people_matched → identity_merges → graph_edges_inferred → opportunities_flagged |
| projects | tasks_extracted → tasks_clustered → projects_created → stakeholders_attached |

ETA formula: `remaining_units / smoothed_rate_per_min` (trailing 5-min window). No fake ETA shown when total is unknown — show rate only.

---

## Integration Points

- `packages/agents/shared/llm.js` — wrap `create()` with telemetry (5 lines added)
- `packages/agents/shared/sql/system-schema.sql` — append telemetry schema
- `packages/ui/server.js` — add `packages/observe/sql/schema.sql` to migration list
- `packages/ui/app/agents/page.jsx` — add "Open Observe →" link
- Root `package.json` — add `"observe": "node packages/observe/server.js"` script
- `packages/observe/package.json` — standalone, lists `@secondbrain/telemetry` + `@secondbrain/db` as deps

---

## Delivery Phases

| Phase | Focus | Key deliverables |
|-------|-------|-----------------|
| 1 | Minimal viable | Telemetry SDK, llm.js wrapper, schema, system sampler, Overview + Models dashboards |
| 2 | Progress visibility | Work-unit instrumentation in all agents, Agents dashboard, ETA calculations |
| 3 | Quality evaluation | Quality scoring, Traces dashboard, Quality dashboard, human rating UI |
| 4 | Alerts + controls | Alert rules, alert UI, concurrency limits, idle model shutdown, token budgets |

---

## Non-Goals

- No raw prompt/output logging by default
- No heavyweight external services (Prometheus, Grafana, OTLP collector)
- No material slowdown to agent execution (all telemetry writes are fire-and-forget)
- No manual terminal inspection as primary observability mechanism
