-- Research agent schema — idempotent, safe to run multiple times
-- relationships.contacts profile columns are owned by packages/agents/relationships/sql/schema.sql

CREATE TABLE IF NOT EXISTS relationships.contact_research (
  id              BIGSERIAL PRIMARY KEY,
  contact_id      BIGINT REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('tavily','openai','peopledatalabs','serpapi')),
  query           TEXT,
  result_json     JSONB,
  summary         TEXT,
  researched_name TEXT,
  researched_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contact_id, source)
);

CREATE INDEX IF NOT EXISTS contact_research_contact_idx ON relationships.contact_research (contact_id);
CREATE INDEX IF NOT EXISTS contact_research_source_idx  ON relationships.contact_research (source);
CREATE INDEX IF NOT EXISTS contact_research_name_idx    ON relationships.contact_research (researched_name);
CREATE INDEX IF NOT EXISTS contact_research_at_idx      ON relationships.contact_research (researched_at DESC);
