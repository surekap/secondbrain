-- Intelligence schema
-- First-class opportunity ledger, evidence links, weak signals, and attention queue.

CREATE SCHEMA IF NOT EXISTS intelligence;

-- ── Opportunity ledger ───────────────────────────────────────────────────────
-- Durable opportunity/action candidates across relationships, projects, groups,
-- research, and future signal-matching jobs. Existing relationships.insights and
-- projects.project_insights remain as compatibility/UI surfaces.

CREATE TABLE IF NOT EXISTS intelligence.opportunities (
  id                    BIGSERIAL PRIMARY KEY,
  opportunity_type      TEXT NOT NULL CHECK (opportunity_type IN (
                          'check_in','introduction','follow_up','project_match',
                          'meeting_action','urgent_message','relationship_health',
                          'email_response_gap','research_opportunity','group_opportunity',
                          'project_opportunity','risk','other'
                        )) DEFAULT 'other',
  title                 TEXT NOT NULL,
  description           TEXT,
  recommended_next_action TEXT,
  why_now               TEXT,
  status                TEXT NOT NULL CHECK (status IN (
                          'open','snoozed','actioned','dismissed','expired'
                        )) DEFAULT 'open',
  priority              TEXT CHECK (priority IN ('high','medium','low')) DEFAULT 'medium',
  confidence            NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  impact_score          NUMERIC(6,2),
  urgency_score         NUMERIC(6,2),
  relationship_score    NUMERIC(6,2),
  expected_value_score  NUMERIC(8,2),
  score_explanation     TEXT,
  source_system         TEXT CHECK (source_system IN (
                          'relationships','projects','groups','research','manual','signals','import'
                        )) DEFAULT 'relationships',
  source_ref            TEXT,
  source_hash           TEXT,
  dedupe_key            TEXT,
  primary_contact_id    BIGINT REFERENCES relationships.contacts(id) ON DELETE SET NULL,
  primary_project_id    BIGINT REFERENCES projects.projects(id) ON DELETE SET NULL,
  surfaced_insight_id   BIGINT REFERENCES relationships.insights(id) ON DELETE SET NULL,
  surfaced_project_insight_id BIGINT REFERENCES projects.project_insights(id) ON DELETE SET NULL,
  expires_at            TIMESTAMPTZ,
  snoozed_until         TIMESTAMPTZ,
  first_seen_at         TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ DEFAULT NOW(),
  actioned_at           TIMESTAMPTZ,
  dismissed_at          TIMESTAMPTZ,
  feedback              TEXT CHECK (feedback IS NULL OR feedback IN ('useful','not_useful','false_positive','too_late','too_low_value')),
  feedback_note         TEXT,
  metadata              JSONB DEFAULT '{}',
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS opportunities_dedupe_key_idx
  ON intelligence.opportunities (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
DROP INDEX IF EXISTS intelligence.opportunities_source_ref_idx;
CREATE INDEX IF NOT EXISTS opportunities_source_ref_idx
  ON intelligence.opportunities (source_system, source_ref)
  WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunities_status_score_idx
  ON intelligence.opportunities (status, expected_value_score DESC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_primary_contact_idx
  ON intelligence.opportunities (primary_contact_id)
  WHERE primary_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunities_primary_project_idx
  ON intelligence.opportunities (primary_project_id)
  WHERE primary_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunities_type_idx
  ON intelligence.opportunities (opportunity_type);
CREATE INDEX IF NOT EXISTS opportunities_last_seen_idx
  ON intelligence.opportunities (last_seen_at DESC);

-- ── Participant/link tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.opportunity_contacts (
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  contact_id     BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  role           TEXT CHECK (role IN ('primary','beneficiary','helper','introducer','mentioned','owner','other')) DEFAULT 'mentioned',
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (opportunity_id, contact_id, role)
);
CREATE INDEX IF NOT EXISTS opportunity_contacts_contact_idx
  ON intelligence.opportunity_contacts (contact_id, role);

CREATE TABLE IF NOT EXISTS intelligence.opportunity_projects (
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  project_id     BIGINT NOT NULL REFERENCES projects.projects(id) ON DELETE CASCADE,
  role           TEXT CHECK (role IN ('primary','related','risk','blocker','beneficiary','other')) DEFAULT 'related',
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (opportunity_id, project_id, role)
);
CREATE INDEX IF NOT EXISTS opportunity_projects_project_idx
  ON intelligence.opportunity_projects (project_id, role);

-- ── Evidence links ───────────────────────────────────────────────────────────
-- Points to existing source/derived records without forcing a new canonical
-- evidence table on day one. `source_table`/`source_id` may refer to email,
-- WhatsApp, Limitless, relationships.communications, insights, projects, etc.

CREATE TABLE IF NOT EXISTS intelligence.opportunity_evidence (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  source_table   TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  source_ref     TEXT,
  occurred_at    TIMESTAMPTZ,
  quote          TEXT,
  relevance      NUMERIC(5,4) CHECK (relevance IS NULL OR (relevance >= 0 AND relevance <= 1)),
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (opportunity_id, source_table, source_id)
);
CREATE INDEX IF NOT EXISTS opportunity_evidence_opp_idx
  ON intelligence.opportunity_evidence (opportunity_id);
CREATE INDEX IF NOT EXISTS opportunity_evidence_source_idx
  ON intelligence.opportunity_evidence (source_table, source_id);
CREATE INDEX IF NOT EXISTS opportunity_evidence_occurred_idx
  ON intelligence.opportunity_evidence (occurred_at DESC NULLS LAST);

-- ── Weak-signal accumulator ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.signals (
  id             BIGSERIAL PRIMARY KEY,
  signal_type    TEXT NOT NULL CHECK (signal_type IN (
                   'need','offer','event','risk','location','capability','interest','intent','other'
                 )) DEFAULT 'other',
  title          TEXT NOT NULL,
  description    TEXT,
  contact_id     BIGINT REFERENCES relationships.contacts(id) ON DELETE SET NULL,
  project_id     BIGINT REFERENCES projects.projects(id) ON DELETE SET NULL,
  source_table   TEXT,
  source_id      TEXT,
  source_ref     TEXT,
  occurred_at    TIMESTAMPTZ,
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  strength       NUMERIC(6,2),
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
DROP INDEX IF EXISTS intelligence.signals_source_idx;
CREATE INDEX IF NOT EXISTS signals_source_idx
  ON intelligence.signals (source_table, source_id, signal_type)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS signals_type_time_idx
  ON intelligence.signals (signal_type, occurred_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS signals_contact_idx
  ON intelligence.signals (contact_id)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS signals_project_idx
  ON intelligence.signals (project_id)
  WHERE project_id IS NOT NULL;

-- ── Feedback events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.opportunity_feedback_events (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  feedback       TEXT NOT NULL CHECK (feedback IN ('useful','not_useful','false_positive','too_late','too_low_value')),
  note           TEXT,
  created_by     TEXT DEFAULT 'user',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS opportunity_feedback_opp_idx
  ON intelligence.opportunity_feedback_events (opportunity_id, created_at DESC);

-- ── Attention queue ──────────────────────────────────────────────────────────
-- Read-only daily surface: currently opportunities only. Future revisions can
-- UNION relationship/project/group risks and events once scoring is normalized.

CREATE OR REPLACE VIEW intelligence.attention_queue AS
SELECT
  o.id,
  'opportunity'::text AS item_type,
  o.title,
  o.description,
  o.recommended_next_action,
  o.why_now,
  o.priority,
  o.status,
  o.opportunity_type,
  o.expected_value_score,
  o.confidence,
  o.primary_contact_id,
  c.display_name AS primary_contact_name,
  o.primary_project_id,
  p.name AS primary_project_name,
  o.expires_at,
  o.last_seen_at,
  o.created_at
FROM intelligence.opportunities o
LEFT JOIN relationships.contacts c ON c.id = o.primary_contact_id
LEFT JOIN projects.projects p ON p.id = o.primary_project_id
WHERE o.status = 'open'
  AND (o.snoozed_until IS NULL OR o.snoozed_until <= NOW())
  AND (o.expires_at IS NULL OR o.expires_at > NOW())
ORDER BY
  o.expected_value_score DESC NULLS LAST,
  CASE o.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  o.last_seen_at DESC NULLS LAST,
  o.created_at DESC;
