-- packages/agents/shared/sql/system-schema.sql
-- Run once (or via runSystemSchema on server startup — idempotent)

CREATE SCHEMA IF NOT EXISTS system;

-- Named LLM credential registry
CREATE TABLE IF NOT EXISTS system.llm_providers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  provider_type TEXT NOT NULL
    CHECK (provider_type IN ('anthropic','claude_cli','openai','gemini','kimi','ollama')),
  api_key       TEXT,
  base_url      TEXT,
  model         TEXT,
  is_enabled    BOOLEAN NOT NULL DEFAULT true,
  has_credits   BOOLEAN NOT NULL DEFAULT true,
  last_error    TEXT,
  last_error_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_name_unique ON system.llm_providers (name);

ALTER TABLE system.llm_providers
  ADD COLUMN IF NOT EXISTS base_url TEXT;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'llm_providers_provider_type_check'
      AND conrelid = 'system.llm_providers'::regclass
  ) THEN
    ALTER TABLE system.llm_providers DROP CONSTRAINT llm_providers_provider_type_check;
  END IF;
END $$;

ALTER TABLE system.llm_providers
  ADD CONSTRAINT llm_providers_provider_type_check
  CHECK (provider_type IN ('anthropic','claude_cli','openai','gemini','kimi','ollama'));

-- Per-agent ordered provider list
CREATE TABLE IF NOT EXISTS system.agent_llm_priority (
  agent_id    TEXT NOT NULL,
  provider_id INT NOT NULL REFERENCES system.llm_providers(id) ON DELETE CASCADE,
  priority    INT NOT NULL,
  PRIMARY KEY (agent_id, provider_id)
);
CREATE INDEX IF NOT EXISTS agent_llm_priority_order
  ON system.agent_llm_priority (agent_id, priority);

-- Per-call usage log
CREATE TABLE IF NOT EXISTS system.llm_usage (
  id          BIGSERIAL PRIMARY KEY,
  provider_id INT REFERENCES system.llm_providers(id) ON DELETE SET NULL,
  agent_id    TEXT NOT NULL,
  tokens_in   INT,
  tokens_out  INT,
  cost_usd    NUMERIC(10,6),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS llm_usage_provider_time
  ON system.llm_usage (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_agent_time
  ON system.llm_usage (agent_id, created_at DESC);

-- Shared cross-agent key-value config
CREATE TABLE IF NOT EXISTS system.config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-agent config tables (created only if the agent schema already exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'email') THEN
    CREATE TABLE IF NOT EXISTS email.config (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'limitless') THEN
    CREATE TABLE IF NOT EXISTS limitless.config (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'projects') THEN
    CREATE TABLE IF NOT EXISTS projects.config (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'relationships') THEN
    CREATE TABLE IF NOT EXISTS relationships.config (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  END IF;
END $$;

-- Agent processing cache (tracks what's been processed to skip redundant LLM calls)
CREATE TABLE IF NOT EXISTS system.agent_cache (
  agent_id    TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata    JSONB,
  PRIMARY KEY (agent_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS agent_cache_agent_type
  ON system.agent_cache (agent_id, item_type);
CREATE INDEX IF NOT EXISTS agent_cache_processed_time
  ON system.agent_cache (processed_at DESC);
