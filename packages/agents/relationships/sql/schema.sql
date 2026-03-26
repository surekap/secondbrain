-- Relationships schema
-- Run once to set up tables

CREATE SCHEMA IF NOT EXISTS relationships;

-- ── Contacts ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relationships.contacts (
  id                  BIGSERIAL PRIMARY KEY,
  display_name        TEXT NOT NULL,
  normalized_name     TEXT,
  emails              TEXT[] DEFAULT '{}',
  phone_numbers       TEXT[] DEFAULT '{}',
  wa_jids             TEXT[] DEFAULT '{}',
  company             TEXT,
  job_title           TEXT,
  summary             TEXT,
  relationship_type   TEXT CHECK (relationship_type IN (
                        'family','friend','colleague','client','vendor',
                        'service_provider','professional_contact','unknown'
                      )) DEFAULT 'unknown',
  relationship_strength TEXT CHECK (relationship_strength IN (
                        'strong','moderate','weak','noise'
                      )) DEFAULT 'weak',
  tags                TEXT[] DEFAULT '{}',
  last_interaction_at TIMESTAMPTZ,
  first_interaction_at TIMESTAMPTZ,
  is_noise            BOOLEAN DEFAULT FALSE,
  raw_data            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS contacts_normalized_name_idx ON relationships.contacts (normalized_name);
CREATE INDEX IF NOT EXISTS contacts_wa_jids_idx         ON relationships.contacts USING GIN (wa_jids);
CREATE INDEX IF NOT EXISTS contacts_emails_idx          ON relationships.contacts USING GIN (emails);
CREATE INDEX IF NOT EXISTS contacts_last_interaction_idx ON relationships.contacts (last_interaction_at DESC);
CREATE INDEX IF NOT EXISTS contacts_is_noise_idx        ON relationships.contacts (is_noise);

-- ── Communications ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relationships.communications (
  id              BIGSERIAL PRIMARY KEY,
  contact_id      BIGINT REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('email','whatsapp','limitless')),
  source_id       TEXT NOT NULL,
  direction       TEXT CHECK (direction IN ('inbound','outbound','group')) DEFAULT 'inbound',
  content_snippet TEXT,
  subject         TEXT,
  chat_id         TEXT,
  is_group        BOOLEAN DEFAULT FALSE,
  group_name      TEXT,
  is_read         BOOLEAN DEFAULT TRUE,
  is_replied      BOOLEAN,
  occurred_at     TIMESTAMPTZ NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, source_id, contact_id)
);

CREATE INDEX IF NOT EXISTS comms_contact_id_idx    ON relationships.communications (contact_id);
CREATE INDEX IF NOT EXISTS comms_occurred_at_idx   ON relationships.communications (occurred_at DESC);
CREATE INDEX IF NOT EXISTS comms_source_idx        ON relationships.communications (source);
CREATE INDEX IF NOT EXISTS comms_chat_id_idx       ON relationships.communications (chat_id);

-- ── Insights ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relationships.insights (
  id            BIGSERIAL PRIMARY KEY,
  contact_id    BIGINT REFERENCES relationships.contacts(id) ON DELETE SET NULL,
  insight_type  TEXT NOT NULL CHECK (insight_type IN (
                  'opportunity','cold_email','unread_group',
                  'awaiting_reply','action_needed','topic'
                )),
  title         TEXT NOT NULL,
  description   TEXT,
  source_refs   JSONB DEFAULT '[]',
  priority      TEXT CHECK (priority IN ('high','medium','low')) DEFAULT 'medium',
  is_actioned   BOOLEAN DEFAULT FALSE,
  is_dismissed  BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS insights_contact_id_idx   ON relationships.insights (contact_id);
CREATE INDEX IF NOT EXISTS insights_type_idx         ON relationships.insights (insight_type);
CREATE INDEX IF NOT EXISTS insights_priority_idx     ON relationships.insights (priority);
CREATE INDEX IF NOT EXISTS insights_actioned_idx     ON relationships.insights (is_actioned, is_dismissed);
CREATE INDEX IF NOT EXISTS insights_created_at_idx   ON relationships.insights (created_at DESC);

-- ── Analysis runs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relationships.analysis_runs (
  id                  BIGSERIAL PRIMARY KEY,
  status              TEXT CHECK (status IN ('running','completed','failed')) DEFAULT 'running',
  contacts_processed  INT DEFAULT 0,
  insights_generated  INT DEFAULT 0,
  error               TEXT,
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS analysis_runs_status_idx     ON relationships.analysis_runs (status);
CREATE INDEX IF NOT EXISTS analysis_runs_started_at_idx ON relationships.analysis_runs (started_at DESC);

-- ── Groups ─────────────────────────────────────────────────────────────────────
-- WhatsApp group chats as trackable entities

CREATE TABLE IF NOT EXISTS relationships.groups (
  id              BIGSERIAL PRIMARY KEY,
  wa_chat_id      TEXT UNIQUE NOT NULL,
  name            TEXT,
  importance      TEXT CHECK (importance IN ('high','medium','low','noise')) DEFAULT 'medium',
  tags            TEXT[] DEFAULT '{}',
  msg_count       INT DEFAULT 0,
  my_msg_count    INT DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  first_seen_at   TIMESTAMPTZ,
  is_noise        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS groups_wa_chat_id_idx      ON relationships.groups (wa_chat_id);
CREATE INDEX IF NOT EXISTS groups_last_activity_idx   ON relationships.groups (last_activity_at DESC);
CREATE INDEX IF NOT EXISTS groups_importance_idx      ON relationships.groups (importance);

-- ── Contact topics ─────────────────────────────────────────────────────────────
-- Recurring topics/themes extracted across contacts

CREATE TABLE IF NOT EXISTS relationships.contact_topics (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  frequency   INT DEFAULT 1,
  last_seen_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contact_id, topic)
);

CREATE INDEX IF NOT EXISTS contact_topics_contact_idx ON relationships.contact_topics (contact_id);

-- ── Email senders ──────────────────────────────────────────────────────────────
-- Deduplicated email sender registry (parsed from "Name" <email> format)

CREATE TABLE IF NOT EXISTS relationships.email_senders (
  id            BIGSERIAL PRIMARY KEY,
  raw_address   TEXT UNIQUE NOT NULL,
  parsed_name   TEXT,
  parsed_email  TEXT,
  email_count   INT DEFAULT 0,
  unread_count  INT DEFAULT 0,
  last_email_at TIMESTAMPTZ,
  first_email_at TIMESTAMPTZ,
  contact_id    BIGINT REFERENCES relationships.contacts(id) ON DELETE SET NULL,
  is_noise      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_senders_parsed_email_idx ON relationships.email_senders (parsed_email);
CREATE INDEX IF NOT EXISTS email_senders_contact_id_idx   ON relationships.email_senders (contact_id);
CREATE INDEX IF NOT EXISTS email_senders_noise_idx        ON relationships.email_senders (is_noise);

-- ── Manual overrides ───────────────────────────────────────────────────────────
-- Stores fields that were manually set in the UI. Agents must not overwrite these.
-- Structure: { "field_name": { "value": ..., "set_at": "ISO timestamp" }, ... }
ALTER TABLE relationships.contacts ADD COLUMN IF NOT EXISTS manual_overrides JSONB DEFAULT '{}';

-- ── my_role + research_summary on contacts ──────────────────────────────────
ALTER TABLE relationships.contacts ADD COLUMN IF NOT EXISTS my_role TEXT;
-- e.g. "patient", "client", "mentee", "employer"
-- Describes the account owner's role in relation to this contact

ALTER TABLE relationships.contacts ADD COLUMN IF NOT EXISTS research_summary TEXT;
-- Synthesised dossier paragraph from external research

-- ── Contact research ────────────────────────────────────────────────────────
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
CREATE INDEX IF NOT EXISTS contact_research_name_idx    ON relationships.contact_research (researched_name);
CREATE INDEX IF NOT EXISTS contact_research_at_idx      ON relationships.contact_research (researched_at DESC);

-- ── Extended insight_type ────────────────────────────────────────────────────
ALTER TABLE relationships.insights DROP CONSTRAINT IF EXISTS insights_insight_type_check;
ALTER TABLE relationships.insights ADD CONSTRAINT insights_insight_type_check
  CHECK (insight_type IN (
    'opportunity', 'cold_email', 'unread_group', 'awaiting_reply',
    'action_needed', 'topic',
    'cross_source_opportunity',
    'project_match'
  ));

-- ── contact_ids on insights (for multi-person opportunities) ─────────────────
ALTER TABLE relationships.insights ADD COLUMN IF NOT EXISTS contact_ids BIGINT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS insights_contact_ids_idx ON relationships.insights USING GIN (contact_ids);
-- ── Group intelligence columns ─────────────────────────────────────────────────
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS group_type TEXT
  CHECK (group_type IN ('board_peers','management','employees','community','unknown'))
  DEFAULT 'unknown';
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS my_role TEXT
  CHECK (my_role IN ('active_leader','active_participant','occasional_contributor','status_receiver','passive_observer','unknown'))
  DEFAULT 'unknown';
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS key_topics TEXT[] DEFAULT '{}';
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS communication_advice TEXT;
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS notable_contacts JSONB DEFAULT '[]';
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS opportunities JSONB DEFAULT '[]';
ALTER TABLE relationships.groups ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS groups_type_idx    ON relationships.groups (group_type);
CREATE INDEX IF NOT EXISTS groups_role_idx    ON relationships.groups (my_role);
CREATE INDEX IF NOT EXISTS groups_noise_idx   ON relationships.groups (is_noise);

-- ── Opportunity tracking ────────────────────────────────────────────────────────
-- source_ref deduplicates insights so the same source isn't re-flagged every run.
-- e.g. 'lifelog:<id>', 'wa:<chat_id>:<ts_epoch>', 'email:<id>', 'contact:<id>'
ALTER TABLE relationships.insights ADD COLUMN IF NOT EXISTS source_ref TEXT;
CREATE INDEX IF NOT EXISTS insights_source_ref_idx ON relationships.insights (source_ref)
  WHERE source_ref IS NOT NULL;

ALTER TABLE relationships.contacts ADD COLUMN IF NOT EXISTS manual_overrides JSONB DEFAULT '{}';
