-- Intelligence schema
-- First-class opportunity ledger, evidence links, weak signals, and attention queue.

CREATE SCHEMA IF NOT EXISTS intelligence;

-- ── Entity graph foundation ──────────────────────────────────────────────────
-- Pragmatic relationship intelligence graph. Contacts remain canonical people in
-- relationships.contacts; these tables add organizations, aliases, topics, and
-- typed links without introducing a graph database.

ALTER TABLE relationships.contacts
  ADD COLUMN IF NOT EXISTS identity_confidence NUMERIC(5,4)
    CHECK (identity_confidence IS NULL OR (identity_confidence >= 0 AND identity_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS relationship_tier TEXT
    CHECK (relationship_tier IS NULL OR relationship_tier IN ('tier_1','tier_2','tier_3','noise','unknown')),
  ADD COLUMN IF NOT EXISTS strategic_importance_score NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS preferred_cadence_days INTEGER
    CHECK (preferred_cadence_days IS NULL OR preferred_cadence_days > 0),
  ADD COLUMN IF NOT EXISTS dormant_threshold_days INTEGER
    CHECK (dormant_threshold_days IS NULL OR dormant_threshold_days > 0),
  ADD COLUMN IF NOT EXISTS next_suggested_touch_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intro_sensitivity TEXT
    CHECK (intro_sensitivity IS NULL OR intro_sensitivity IN ('low','medium','high','do_not_intro','unknown')),
  ADD COLUMN IF NOT EXISTS do_not_contact_unless TEXT;

CREATE INDEX IF NOT EXISTS contacts_relationship_tier_idx
  ON relationships.contacts (relationship_tier)
  WHERE relationship_tier IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_next_touch_idx
  ON relationships.contacts (next_suggested_touch_at)
  WHERE next_suggested_touch_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS intelligence.organizations (
  id                         BIGSERIAL PRIMARY KEY,
  name                       TEXT NOT NULL,
  normalized_name            TEXT GENERATED ALWAYS AS (LOWER(REGEXP_REPLACE(TRIM(name), '[[:space:]]+', ' ', 'g'))) STORED,
  domain                     TEXT,
  sector                     TEXT,
  geography                  TEXT,
  relationship_to_prateek    TEXT,
  strategic_importance_score NUMERIC(6,2),
  tags                       TEXT[] DEFAULT '{}',
  metadata                   JSONB DEFAULT '{}',
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (normalized_name)
);
CREATE INDEX IF NOT EXISTS organizations_domain_idx
  ON intelligence.organizations (LOWER(domain))
  WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS organizations_tags_idx
  ON intelligence.organizations USING GIN (tags);

CREATE TABLE IF NOT EXISTS intelligence.entity_aliases (
  id             BIGSERIAL PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('contact','organization','project','topic','group','event','other')),
  entity_id      TEXT NOT NULL,
  alias          TEXT NOT NULL,
  normalized_alias TEXT GENERATED ALWAYS AS (LOWER(REGEXP_REPLACE(TRIM(alias), '[[:space:]]+', ' ', 'g'))) STORED,
  source         TEXT,
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (entity_type, entity_id, normalized_alias)
);
CREATE INDEX IF NOT EXISTS entity_aliases_lookup_idx
  ON intelligence.entity_aliases (entity_type, normalized_alias);

CREATE TABLE IF NOT EXISTS intelligence.contact_organizations (
  id                BIGSERIAL PRIMARY KEY,
  contact_id       BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  organization_id  BIGINT NOT NULL REFERENCES intelligence.organizations(id) ON DELETE CASCADE,
  role             TEXT,
  relationship     TEXT CHECK (relationship IS NULL OR relationship IN ('employee','founder','owner','advisor','investor','customer','supplier','partner','board','alumni','other')),
  is_current       BOOLEAN DEFAULT true,
  confidence       NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_ref       TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_organizations_unique_idx
  ON intelligence.contact_organizations (contact_id, organization_id, (COALESCE(relationship, 'other')));
CREATE INDEX IF NOT EXISTS contact_organizations_org_idx
  ON intelligence.contact_organizations (organization_id, is_current);

CREATE TABLE IF NOT EXISTS intelligence.topics (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  normalized_name   TEXT GENERATED ALWAYS AS (LOWER(REGEXP_REPLACE(TRIM(name), '[[:space:]]+', ' ', 'g'))) STORED,
  topic_type        TEXT CHECK (topic_type IS NULL OR topic_type IN ('domain','sector','geography','event','project','personal','investment','operations','other')) DEFAULT 'other',
  parent_topic_id   BIGINT REFERENCES intelligence.topics(id) ON DELETE SET NULL,
  description       TEXT,
  strategic_weight  NUMERIC(6,2),
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (normalized_name)
);
CREATE INDEX IF NOT EXISTS topics_type_idx
  ON intelligence.topics (topic_type);

CREATE TABLE IF NOT EXISTS intelligence.object_topics (
  id             BIGSERIAL PRIMARY KEY,
  topic_id       BIGINT NOT NULL REFERENCES intelligence.topics(id) ON DELETE CASCADE,
  object_type    TEXT NOT NULL CHECK (object_type IN ('contact','organization','project','opportunity','group','communication','message','email','lifelog','other')),
  object_id      TEXT NOT NULL,
  role           TEXT CHECK (role IS NULL OR role IN ('primary','secondary','mentioned','need','offer','risk','interest','other')) DEFAULT 'mentioned',
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_ref     TEXT,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS object_topics_unique_idx
  ON intelligence.object_topics (topic_id, object_type, object_id, (COALESCE(role, 'mentioned')));
CREATE INDEX IF NOT EXISTS object_topics_object_idx
  ON intelligence.object_topics (object_type, object_id);

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

DROP VIEW IF EXISTS intelligence.attention_queue;
CREATE VIEW intelligence.attention_queue AS
WITH scored_inputs AS (
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
    o.feedback,
    o.primary_contact_id,
    c.display_name AS primary_contact_name,
    o.primary_project_id,
    p.name AS primary_project_name,
    o.expires_at,
    o.last_seen_at,
    o.created_at,
    o.first_seen_at,
    ev.first_occurred_at AS source_first_seen_at,
    ev.last_occurred_at AS source_last_seen_at,
    COALESCE(ev.evidence_count, 0)::int AS evidence_count,
    COALESCE(ev.last_occurred_at, o.first_seen_at, o.created_at, o.last_seen_at) AS scoring_source_at,
    LOWER(COALESCE(o.title, '') || ' ' || COALESCE(o.description, '')) AS attention_text,
    LOWER(COALESCE(o.recommended_next_action, '')) AS action_text,
    LOWER(REGEXP_REPLACE(COALESCE(o.title, ''), '[[:space:]]+', ' ', 'g')) AS normalized_title
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
  WHERE o.status = 'open'
    AND (o.snoozed_until IS NULL OR o.snoozed_until <= NOW())
    AND (o.expires_at IS NULL OR o.expires_at > NOW())
), scored AS (
  SELECT
    scored_inputs.*,
    GREATEST(0,
      COALESCE(expected_value_score, CASE priority WHEN 'high' THEN 80 WHEN 'low' THEN 30 ELSE 55 END)
      -- Boost genuinely current items; do not let newly backfilled old evidence float to the top.
      + CASE WHEN scoring_source_at >= NOW() - INTERVAL '3 days' THEN 8
             WHEN scoring_source_at >= NOW() - INTERVAL '7 days' THEN 4
             ELSE 0 END
      + CASE WHEN confidence >= 0.80 THEN 5 WHEN confidence <= 0.40 THEN -8 ELSE 0 END
      + CASE WHEN evidence_count >= 3 THEN 4 WHEN evidence_count = 2 THEN 1 ELSE 0 END
      - CASE WHEN LOWER(title) LIKE 're-engage %' THEN 25 ELSE 0 END
      - CASE WHEN evidence_count = 0 THEN 35 WHEN evidence_count = 1 THEN 20 ELSE 0 END
      - CASE WHEN evidence_count = 1 AND scoring_source_at < NOW() - INTERVAL '14 days' THEN 15 ELSE 0 END
      - CASE WHEN opportunity_type = 'group_opportunity' AND evidence_count < 2 THEN 26 ELSE 0 END
      - CASE WHEN opportunity_type = 'group_opportunity' AND primary_contact_id IS NULL AND primary_project_id IS NULL THEN 18 ELSE 0 END
      - CASE WHEN NULLIF(TRIM(COALESCE(recommended_next_action, '')), '') IS NULL THEN 8 ELSE 0 END
      - CASE WHEN why_now IS NULL OR NULLIF(TRIM(COALESCE(why_now, '')), '') IS NULL THEN 18 ELSE 0 END
      - CASE WHEN action_text LIKE '%turn %into a concrete task%'
               OR action_text LIKE '%identify the best-fit person or project owner%'
               OR action_text LIKE '%send a short intro note explaining the specific mutual value%'
               OR action_text LIKE '%save a research task%'
             THEN 18 ELSE 0 END
      - CASE WHEN (
               attention_text LIKE '%flight%'
               OR attention_text LIKE '%travel plan%'
               OR attention_text LIKE '%travel/access friction%'
               OR attention_text LIKE '%access friction%'
               OR attention_text LIKE '%reservation support%'
               OR attention_text LIKE '%hotel%'
               OR attention_text LIKE '%cab%'
               OR attention_text LIKE '%taxi%'
               OR attention_text LIKE '%certificate/key rotation%'
               OR attention_text LIKE '%certificate rotation%'
               OR attention_text LIKE '%client credentials%'
               OR attention_text LIKE '% csr %'
             ) AND attention_text NOT LIKE '%investment%'
               AND attention_text NOT LIKE '%capital%'
               AND attention_text NOT LIKE '%acquisition%'
               AND attention_text NOT LIKE '%strategic%'
               AND attention_text NOT LIKE '%distribution%'
             THEN 35 ELSE 0 END
      - CASE WHEN opportunity_type = 'meeting_action' AND evidence_count < 2 THEN 10 ELSE 0 END
      - CASE WHEN scoring_source_at < NOW() - INTERVAL '90 days' THEN 40
             WHEN scoring_source_at < NOW() - INTERVAL '30 days' THEN 25
             WHEN scoring_source_at < NOW() - INTERVAL '14 days' THEN 8
             ELSE 0 END
      - CASE WHEN opportunity_type = 'risk' AND scoring_source_at < NOW() - INTERVAL '14 days' THEN 12 ELSE 0 END
      + CASE WHEN feedback = 'useful' THEN 10
             WHEN feedback = 'too_late' THEN -30
             WHEN feedback IN ('not_useful','false_positive','too_low_value') THEN -60
             ELSE 0 END
    )::numeric(8,2) AS attention_score,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN evidence_count = 0 THEN 'no_evidence' END,
      CASE WHEN evidence_count = 1 THEN 'single_evidence' END,
      CASE WHEN evidence_count = 1 AND scoring_source_at < NOW() - INTERVAL '14 days' THEN 'old_single_evidence' END,
      CASE WHEN opportunity_type = 'group_opportunity' AND evidence_count < 2 THEN 'group_single_evidence' END,
      CASE WHEN opportunity_type = 'group_opportunity' AND primary_contact_id IS NULL AND primary_project_id IS NULL THEN 'unlinked_group_opportunity' END,
      CASE WHEN LOWER(title) LIKE 're-engage %' THEN 'generic_reengage' END,
      CASE WHEN NULLIF(TRIM(COALESCE(recommended_next_action, '')), '') IS NULL THEN 'missing_next_action' END,
      CASE WHEN why_now IS NULL OR NULLIF(TRIM(COALESCE(why_now, '')), '') IS NULL THEN 'missing_why_now' END,
      CASE WHEN action_text LIKE '%turn %into a concrete task%'
             OR action_text LIKE '%identify the best-fit person or project owner%'
             OR action_text LIKE '%send a short intro note explaining the specific mutual value%'
             OR action_text LIKE '%save a research task%'
           THEN 'generic_next_action' END,
      CASE WHEN (
             attention_text LIKE '%flight%'
             OR attention_text LIKE '%travel plan%'
             OR attention_text LIKE '%travel/access friction%'
             OR attention_text LIKE '%access friction%'
             OR attention_text LIKE '%reservation support%'
             OR attention_text LIKE '%hotel%'
             OR attention_text LIKE '%cab%'
             OR attention_text LIKE '%taxi%'
             OR attention_text LIKE '%certificate/key rotation%'
             OR attention_text LIKE '%certificate rotation%'
             OR attention_text LIKE '%client credentials%'
             OR attention_text LIKE '% csr %'
           ) AND attention_text NOT LIKE '%investment%'
             AND attention_text NOT LIKE '%capital%'
             AND attention_text NOT LIKE '%acquisition%'
             AND attention_text NOT LIKE '%strategic%'
             AND attention_text NOT LIKE '%distribution%'
           THEN 'low_value_admin' END,
      CASE WHEN opportunity_type = 'meeting_action' AND evidence_count < 2 THEN 'thin_meeting_action' END,
      CASE WHEN scoring_source_at < NOW() - INTERVAL '90 days' THEN 'very_stale'
           WHEN scoring_source_at < NOW() - INTERVAL '30 days' THEN 'stale'
           WHEN scoring_source_at < NOW() - INTERVAL '14 days' THEN 'aging' END,
      CASE WHEN opportunity_type = 'risk' AND scoring_source_at < NOW() - INTERVAL '14 days' THEN 'archival_risk' END,
      CASE WHEN feedback IN ('not_useful','false_positive','too_low_value') THEN 'negative_feedback' END,
      CASE WHEN feedback = 'too_late' THEN 'feedback_too_late' END,
      CASE WHEN scoring_source_at >= NOW() - INTERVAL '3 days' THEN 'recent_source' END
    ], NULL)::text[] AS quality_flags
  FROM scored_inputs
), deduped AS (
  SELECT
    scored.*,
    ROW_NUMBER() OVER (
      PARTITION BY normalized_title
      ORDER BY attention_score DESC NULLS LAST, COALESCE(source_last_seen_at, last_seen_at) DESC NULLS LAST, created_at DESC
    ) AS duplicate_rank
  FROM scored
)
SELECT
  id,
  item_type,
  title,
  description,
  recommended_next_action,
  why_now,
  priority,
  status,
  opportunity_type,
  expected_value_score,
  confidence,
  primary_contact_id,
  primary_contact_name,
  primary_project_id,
  primary_project_name,
  expires_at,
  last_seen_at,
  created_at,
  first_seen_at,
  source_first_seen_at,
  source_last_seen_at,
  evidence_count,
  attention_score,
  quality_flags
FROM deduped
WHERE duplicate_rank = 1
ORDER BY
  attention_score DESC NULLS LAST,
  CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  COALESCE(source_last_seen_at, last_seen_at) DESC NULLS LAST,
  created_at DESC;
