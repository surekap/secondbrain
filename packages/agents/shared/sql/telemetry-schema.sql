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
