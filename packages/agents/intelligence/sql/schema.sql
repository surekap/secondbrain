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

CREATE TABLE IF NOT EXISTS intelligence.duplicate_decisions (
  id             BIGSERIAL PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('contact','organization')),
  duplicate_key  TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('confirmed','ignored')),
  canonical_id   TEXT,
  duplicate_ids  TEXT[] DEFAULT '{}',
  decided_by     TEXT,
  decided_at     TIMESTAMPTZ DEFAULT NOW(),
  note           TEXT,
  metadata       JSONB DEFAULT '{}',
  UNIQUE (entity_type, duplicate_key)
);
CREATE INDEX IF NOT EXISTS duplicate_decisions_action_idx
  ON intelligence.duplicate_decisions (entity_type, action, decided_at DESC);

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

-- `opportunities` remains the write-compatible table used by existing APIs,
-- while these columns make it the single typed intelligence-item ledger.
ALTER TABLE intelligence.opportunities
  ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'opportunity'
    CHECK (item_type IN ('opportunity','issue','insight','action','risk','decision')),
  ADD COLUMN IF NOT EXISTS item_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('candidate','active','resolved','dismissed','expired')),
  ADD COLUMN IF NOT EXISTS first_corroborated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_corroborated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_contradicted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_presented_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS detector_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_item_fingerprint_idx
  ON intelligence.opportunities (item_fingerprint)
  WHERE item_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunities_item_lifecycle_idx
  ON intelligence.opportunities (item_type, lifecycle_state, expected_value_score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS intelligence.item_lifecycle_events (
  id               BIGSERIAL PRIMARY KEY,
  opportunity_id   BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  from_status      TEXT,
  to_status        TEXT NOT NULL,
  from_state       TEXT,
  to_state         TEXT NOT NULL,
  actor             TEXT NOT NULL,
  producer          TEXT,
  producer_version  TEXT,
  reason            TEXT NOT NULL,
  evidence_refs     JSONB NOT NULL DEFAULT '[]',
  claim_refs        JSONB NOT NULL DEFAULT '[]',
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS item_lifecycle_events_item_idx
  ON intelligence.item_lifecycle_events (opportunity_id, occurred_at DESC);

-- Normalize the legacy status-only ledger once. Keep an auditable migration
-- transition rather than allowing thousands of dismissed rows to remain active.
WITH mismatched AS (
  SELECT id, status AS from_status, lifecycle_state AS from_state,
         CASE status
           WHEN 'actioned' THEN 'resolved'
           WHEN 'dismissed' THEN 'dismissed'
           WHEN 'expired' THEN 'expired'
           ELSE lifecycle_state
         END AS to_state
  FROM intelligence.opportunities
  WHERE lifecycle_state IS DISTINCT FROM CASE status
    WHEN 'actioned' THEN 'resolved'
    WHEN 'dismissed' THEN 'dismissed'
    WHEN 'expired' THEN 'expired'
    ELSE lifecycle_state
  END
), updated AS (
  UPDATE intelligence.opportunities o
  SET lifecycle_state = mismatched.to_state,
      updated_at = NOW()
  FROM mismatched
  WHERE o.id = mismatched.id
  RETURNING o.id
)
INSERT INTO intelligence.item_lifecycle_events (
  opportunity_id, from_status, to_status, from_state, to_state,
  actor, producer, producer_version, reason, metadata
)
SELECT mismatched.id, mismatched.from_status, mismatched.from_status,
       mismatched.from_state, mismatched.to_state,
       'system', 'schema_migration', 'lifecycle-normalization-v1',
       'Normalized legacy status/lifecycle mismatch', '{"migration":true}'::jsonb
FROM mismatched JOIN updated USING (id);

CREATE OR REPLACE FUNCTION intelligence.record_item_lifecycle_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status
     OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state THEN
    INSERT INTO intelligence.item_lifecycle_events (
      opportunity_id, from_status, to_status, from_state, to_state,
      actor, producer, producer_version, reason, evidence_refs, claim_refs, metadata
    ) VALUES (
      NEW.id, OLD.status, NEW.status, OLD.lifecycle_state, NEW.lifecycle_state,
      COALESCE(NULLIF(current_setting('secondbrain.lifecycle_actor', true), ''), 'system'),
      NULLIF(current_setting('secondbrain.lifecycle_producer', true), ''),
      NULLIF(current_setting('secondbrain.lifecycle_version', true), ''),
      COALESCE(NULLIF(current_setting('secondbrain.lifecycle_reason', true), ''), 'Lifecycle fields changed'),
      COALESCE(NULLIF(current_setting('secondbrain.lifecycle_evidence_refs', true), '')::jsonb, '[]'::jsonb),
      COALESCE(NULLIF(current_setting('secondbrain.lifecycle_claim_refs', true), '')::jsonb, '[]'::jsonb),
      '{}'::jsonb
    );
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS opportunities_lifecycle_audit_trigger ON intelligence.opportunities;
CREATE TRIGGER opportunities_lifecycle_audit_trigger
AFTER UPDATE OF status, lifecycle_state ON intelligence.opportunities
FOR EACH ROW EXECUTE FUNCTION intelligence.record_item_lifecycle_event();

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
-- Item evidence always points to a canonical communication. Derived insight,
-- group, project, and raw-source provenance belongs in item/evidence metadata;
-- it must never substitute for inspectable canonical source evidence.

CREATE TABLE IF NOT EXISTS intelligence.opportunity_evidence (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  source_table   TEXT NOT NULL CHECK (source_table = 'relationships.communications'),
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

CREATE TABLE IF NOT EXISTS intelligence.opportunity_evidence_quarantine (
  evidence_id      BIGINT PRIMARY KEY,
  opportunity_id   BIGINT NOT NULL,
  source_snapshot  JSONB NOT NULL,
  reason           TEXT NOT NULL,
  quarantined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH invalid AS (
  SELECT evidence.*
  FROM intelligence.opportunity_evidence evidence
  WHERE NOT (
    (evidence.source_table = 'relationships.communications' AND EXISTS (
      SELECT 1 FROM relationships.communications source_row
      WHERE source_row.id = CASE WHEN evidence.source_id ~ '^[0-9]+$' THEN evidence.source_id::bigint ELSE -1 END
        AND COALESCE(source_row.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
    ))
  )
)
INSERT INTO intelligence.opportunity_evidence_quarantine (
  evidence_id, opportunity_id, source_snapshot, reason
)
SELECT invalid.id, invalid.opportunity_id, to_jsonb(invalid),
       'Unsupported, derived, or dangling evidence pointer removed from canonical item ledger'
FROM invalid
ON CONFLICT (evidence_id) DO NOTHING;

DELETE FROM intelligence.opportunity_evidence evidence
USING intelligence.opportunity_evidence_quarantine quarantine
WHERE evidence.id = quarantine.evidence_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
    WHERE schema_row.nspname = 'intelligence'
      AND table_row.relname = 'opportunity_evidence'
      AND constraint_row.conname = 'opportunity_evidence_canonical_source_check'
  ) THEN
    ALTER TABLE intelligence.opportunity_evidence
      ADD CONSTRAINT opportunity_evidence_canonical_source_check
      CHECK (source_table = 'relationships.communications');
  END IF;
END $$;

-- Unsupported items leave active attention automatically. Unlinked items stay
-- as candidates for later entity resolution rather than interrupting the user.
UPDATE intelligence.opportunities opportunity
SET status = 'expired', lifecycle_state = 'expired',
    expires_at = COALESCE(expires_at, NOW()),
    metadata = metadata || '{"self_correction":"missing_inspectable_direct_evidence"}'::jsonb,
    updated_at = NOW()
WHERE opportunity.status = 'open'
  AND opportunity.lifecycle_state IN ('active', 'candidate')
  AND NOT EXISTS (
    SELECT 1 FROM intelligence.opportunity_evidence evidence
    WHERE evidence.opportunity_id = opportunity.id
  );

UPDATE intelligence.opportunities opportunity
SET lifecycle_state = 'candidate',
    metadata = metadata || '{"candidate_reason":"unresolved_canonical_entity"}'::jsonb,
    updated_at = NOW()
WHERE opportunity.status = 'open'
  AND opportunity.lifecycle_state = 'active'
  AND opportunity.primary_contact_id IS NULL
  AND opportunity.primary_project_id IS NULL;

-- ── Communication event extraction ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.communication_events (
  id                 BIGSERIAL PRIMARY KEY,
  event_key          TEXT NOT NULL UNIQUE,
  event_kind         TEXT NOT NULL CHECK (event_kind IN (
                         'event','conference','zoom_call','webinar','meeting','call',
                         'workshop','summit','panel','roundtable','launch','other'
                       )),
  title              TEXT NOT NULL,
  description        TEXT,
  communicated_at    TIMESTAMPTZ NOT NULL,
  starts_at          TIMESTAMPTZ,
  ends_at            TIMESTAMPTZ,
  source_table       TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  source_ref         TEXT,
  source_contact_id  BIGINT REFERENCES relationships.contacts(id) ON DELETE SET NULL,
  source_project_id  BIGINT REFERENCES projects.projects(id) ON DELETE SET NULL,
  source_subject     TEXT,
  source_excerpt     TEXT,
  confidence         NUMERIC(4,3) DEFAULT 0.700 CHECK (confidence >= 0 AND confidence <= 1),
  metadata           JSONB DEFAULT '{}',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS communication_events_kind_idx
  ON intelligence.communication_events (event_kind, communicated_at DESC);
CREATE INDEX IF NOT EXISTS communication_events_source_idx
  ON intelligence.communication_events (source_table, source_id);
CREATE INDEX IF NOT EXISTS communication_events_start_idx
  ON intelligence.communication_events (starts_at DESC NULLS LAST);

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

-- ── Evidence-backed semantic claims ─────────────────────────────────────────
-- Claims are the semantic layer between raw/canonical communication evidence
-- and surfaced intelligence items. Counter-evidence updates lifecycle without
-- mutating the source record.

CREATE TABLE IF NOT EXISTS intelligence.claims (
  id                BIGSERIAL PRIMARY KEY,
  claim_key         TEXT NOT NULL UNIQUE,
  claim_type        TEXT NOT NULL CHECK (claim_type IN (
                      'need','offer','event','risk','location','capability','interest','intent','decision','status','commitment','other'
                    )),
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('contact','project','organization','group','unknown')),
  subject_id        TEXT,
  predicate         TEXT NOT NULL,
  object_type       TEXT,
  object_id         TEXT,
  polarity          TEXT NOT NULL DEFAULT 'positive' CHECK (polarity IN ('positive','negative','uncertain')),
  lifecycle_state   TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('proposed','active','fulfilled','resolved','cancelled','unknown')),
  valid_from        TIMESTAMPTZ,
  valid_until       TIMESTAMPTZ,
  confidence        NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extractor_version TEXT NOT NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contradicted_at TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS claims_subject_idx
  ON intelligence.claims (subject_type, subject_id, claim_type, lifecycle_state);
CREATE INDEX IF NOT EXISTS claims_recent_idx
  ON intelligence.claims (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS intelligence.claim_evidence (
  id           BIGSERIAL PRIMARY KEY,
  claim_id     BIGINT NOT NULL REFERENCES intelligence.claims(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  source_ref   TEXT,
  occurred_at  TIMESTAMPTZ,
  quote        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (claim_id, source_table, source_id, content_hash)
);
CREATE INDEX IF NOT EXISTS claim_evidence_source_idx
  ON intelligence.claim_evidence (source_table, source_id);

CREATE TABLE IF NOT EXISTS intelligence.item_claims (
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  claim_id       BIGINT NOT NULL REFERENCES intelligence.claims(id) ON DELETE CASCADE,
  role           TEXT NOT NULL DEFAULT 'supporting' CHECK (role IN ('primary','supporting','contradicting')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (opportunity_id, claim_id, role)
);
CREATE INDEX IF NOT EXISTS item_claims_claim_idx
  ON intelligence.item_claims (claim_id, role);

-- ── Durable user-guidance overlay and clarification lifecycle ───────────────

CREATE TABLE IF NOT EXISTS intelligence.guidance_facts (
  id               BIGSERIAL PRIMARY KEY,
  guidance_key     TEXT NOT NULL UNIQUE,
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('global','contact','project','organization','group','topic')),
  scope_id         TEXT,
  fact_type        TEXT NOT NULL,
  fact_value       JSONB NOT NULL,
  provenance       TEXT NOT NULL CHECK (provenance IN ('user_clarification','user_fact','inferred','imported')),
  source_ref       TEXT,
  confidence       NUMERIC(5,4) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','contradicted','expired')),
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until      TIMESTAMPTZ,
  supersedes_id    BIGINT REFERENCES intelligence.guidance_facts(id) ON DELETE SET NULL,
  superseded_by_id BIGINT REFERENCES intelligence.guidance_facts(id) ON DELETE SET NULL,
  metadata         JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS guidance_facts_scope_idx
  ON intelligence.guidance_facts (scope_type, scope_id, fact_type)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS intelligence.clarification_questions (
  id                      BIGSERIAL PRIMARY KEY,
  ambiguity_key           TEXT NOT NULL UNIQUE,
  scope_type              TEXT NOT NULL CHECK (scope_type IN ('global','contact','project','organization','group','topic')),
  scope_id                TEXT,
  question                TEXT NOT NULL,
  impact                  TEXT NOT NULL DEFAULT 'low' CHECK (impact IN ('low','medium','high')),
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','auto_resolved','dismissed')),
  occurrences             INTEGER NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  first_observed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at             TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  answer_guidance_fact_id BIGINT REFERENCES intelligence.guidance_facts(id) ON DELETE SET NULL,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clarification_questions_pending_idx
  ON intelligence.clarification_questions (impact, occurrences DESC, last_observed_at DESC)
  WHERE status = 'pending';

ALTER TABLE intelligence.clarification_questions
  DROP CONSTRAINT IF EXISTS clarification_questions_occurrences_check;
ALTER TABLE intelligence.clarification_questions
  ALTER COLUMN occurrences SET DEFAULT 0;
ALTER TABLE intelligence.clarification_questions
  ADD CONSTRAINT clarification_questions_occurrences_check CHECK (occurrences >= 0);

CREATE TABLE IF NOT EXISTS intelligence.clarification_observations (
  id               BIGSERIAL PRIMARY KEY,
  clarification_id BIGINT NOT NULL REFERENCES intelligence.clarification_questions(id) ON DELETE CASCADE,
  evidence_key     TEXT NOT NULL,
  source_ref       TEXT,
  occurred_at      TIMESTAMPTZ,
  metadata         JSONB NOT NULL DEFAULT '{}',
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clarification_id, evidence_key)
);
CREATE INDEX IF NOT EXISTS clarification_observations_question_idx
  ON intelligence.clarification_observations (clarification_id, observed_at DESC);

-- Historic occurrence counters did not preserve evidence identity. Retain one
-- conservative observation rather than treating detector reruns as independent
-- communications.
INSERT INTO intelligence.clarification_observations (clarification_id, evidence_key, metadata)
SELECT id, 'legacy:' || id::text, '{"migration":"legacy_counter"}'::jsonb
FROM intelligence.clarification_questions
WHERE occurrences > 0
ON CONFLICT (clarification_id, evidence_key) DO NOTHING;

UPDATE intelligence.clarification_questions q
SET occurrences = observations.distinct_count
FROM (
  SELECT clarification_id, COUNT(*)::integer AS distinct_count
  FROM intelligence.clarification_observations
  GROUP BY clarification_id
) observations
WHERE q.id = observations.clarification_id;

-- ── Durable pipeline execution ledger ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.pipeline_runs (
  id             BIGSERIAL PRIMARY KEY,
  trigger        TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','schedule','startup','api','recovery')),
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','skipped')),
  runner_id      TEXT,
  stats          JSONB NOT NULL DEFAULT '{}',
  checkpoints    JSONB NOT NULL DEFAULT '{}',
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx
  ON intelligence.pipeline_runs (status, started_at DESC);

-- Read-compatible unified surface. Existing APIs continue writing
-- `opportunities`; new consumers should read `items` and use item_type.
CREATE OR REPLACE VIEW intelligence.items AS
SELECT
  o.*
FROM intelligence.opportunities o;

-- ── Feedback events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.opportunity_feedback_events (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES intelligence.opportunities(id) ON DELETE CASCADE,
  feedback       TEXT NOT NULL CHECK (feedback IN ('useful','not_useful','false_positive','too_late','too_low_value')),
  note           TEXT,
  created_by     TEXT DEFAULT 'user',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE intelligence.opportunity_feedback_events ADD COLUMN IF NOT EXISTS action TEXT;
ALTER TABLE intelligence.opportunity_feedback_events ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE intelligence.opportunity_feedback_events DROP CONSTRAINT IF EXISTS opportunity_feedback_events_feedback_check;
ALTER TABLE intelligence.opportunity_feedback_events ADD CONSTRAINT opportunity_feedback_events_feedback_check
  CHECK (feedback IN ('useful','not_useful','false_positive','too_late','too_low_value'));
CREATE INDEX IF NOT EXISTS opportunity_feedback_opp_idx
  ON intelligence.opportunity_feedback_events (opportunity_id, created_at DESC);

-- ── Suppressions / trust layer ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS intelligence.opportunity_suppressions (
  id             BIGSERIAL PRIMARY KEY,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('contact','project','opportunity','source_ref','pattern')),
  scope_id       TEXT,
  match_type     TEXT NOT NULL CHECK (match_type IN ('exact','normalized_title_hash','pattern')),
  match_value    TEXT NOT NULL,
  detector       TEXT,
  source_system  TEXT,
  reason_code    TEXT NOT NULL CHECK (reason_code IN ('wrong_person','wrong_project','already_closed','not_useful','suppress_pattern')),
  note           TEXT,
  created_by     TEXT DEFAULT 'user',
  expires_at     TIMESTAMPTZ,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS opportunity_suppressions_active_idx
  ON intelligence.opportunity_suppressions (active, scope_type, match_type);
CREATE INDEX IF NOT EXISTS opportunity_suppressions_scope_idx
  ON intelligence.opportunity_suppressions (scope_type, scope_id)
  WHERE scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunity_suppressions_match_idx
  ON intelligence.opportunity_suppressions (match_type, match_value)
  WHERE active = true;

-- ── Attention queue ──────────────────────────────────────────────────────────
-- Read-only daily surface: currently opportunities only. Future revisions can
-- UNION relationship/project/group risks and events once scoring is normalized.

DROP VIEW IF EXISTS intelligence.daily_attention_queue;
DROP VIEW IF EXISTS intelligence.attention_queue;
CREATE VIEW intelligence.attention_queue AS
WITH scored_inputs AS (
  SELECT
    o.id,
    o.item_type,
    o.title,
    o.description,
    o.recommended_next_action,
    o.why_now,
    o.priority,
    o.status,
    o.opportunity_type,
    o.source_system,
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
    LOWER(COALESCE(o.title, '') || ' ' || COALESCE(o.description, '') || ' ' || COALESCE(o.recommended_next_action, '') || ' ' || COALESCE(o.source_ref, '') || ' ' || COALESCE(c.display_name, '') || ' ' || COALESCE(p.name, '')) AS source_hint_text,
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
    AND o.lifecycle_state = 'active'
    AND (o.primary_contact_id IS NOT NULL OR o.primary_project_id IS NOT NULL)
    AND (o.primary_project_id IS NULL OR COALESCE(p.is_archived, FALSE) = FALSE)
    AND EXISTS (
      SELECT 1
      FROM intelligence.opportunity_evidence direct_evidence
      WHERE direct_evidence.opportunity_id = o.id
        AND direct_evidence.source_table = 'relationships.communications'
        AND EXISTS (
          SELECT 1 FROM relationships.communications source_row
          WHERE source_row.id = CASE WHEN direct_evidence.source_id ~ '^[0-9]+$' THEN direct_evidence.source_id::bigint ELSE -1 END
            AND COALESCE(source_row.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
        )
    )
    AND (o.snoozed_until IS NULL OR o.snoozed_until <= NOW())
    AND (o.expires_at IS NULL OR o.expires_at > NOW())
    AND NOT EXISTS (
      SELECT 1
      FROM intelligence.opportunity_suppressions s
      WHERE s.active = true
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
        AND (
          (s.scope_type = 'opportunity' AND s.scope_id = o.id::text)
          OR (s.scope_type = 'source_ref' AND s.match_type = 'exact' AND s.match_value = COALESCE(o.source_ref, ''))
          OR (s.scope_type = 'contact' AND s.match_type = 'exact' AND s.scope_id = o.primary_contact_id::text)
          OR (s.scope_type = 'project' AND s.match_type = 'exact' AND s.scope_id = o.primary_project_id::text)
          OR (s.scope_type = 'pattern' AND s.match_type = 'pattern' AND (
            LOWER(COALESCE(o.title, '')) LIKE LOWER(s.match_value)
            OR LOWER(COALESCE(o.description, '')) LIKE LOWER(s.match_value)
            OR LOWER(COALESCE(o.source_ref, '')) LIKE LOWER(s.match_value)
          ))
        )
    )
), classified_inputs AS (
  SELECT
    scored_inputs.*,
    CASE
      WHEN opportunity_type IN ('project_match', 'project_opportunity') THEN 'project'
      WHEN opportunity_type = 'research_opportunity' THEN 'capital'
      WHEN opportunity_type IN ('meeting_action', 'urgent_message') THEN 'admin'
      WHEN opportunity_type IN ('follow_up', 'relationship_health', 'check_in') THEN 'closure'
      WHEN source_system IN ('manual', 'import') THEN 'internal'
      ELSE 'relationship'
    END AS surface_bucket,
    CASE
      WHEN source_system = 'manual' THEN 8
      WHEN source_system = 'research' THEN 6
      WHEN source_system = 'projects' THEN 4
      WHEN source_system = 'signals' THEN 2
      ELSE 0
    END AS source_priority_bonus
  FROM scored_inputs
), scored AS (
  SELECT
    classified_inputs.*,
    GREATEST(0,
      COALESCE(expected_value_score, CASE priority WHEN 'high' THEN 80 WHEN 'low' THEN 30 ELSE 55 END)
      + source_priority_bonus
      -- Boost genuinely current items; do not let newly backfilled old evidence float to the top.
      + CASE WHEN scoring_source_at >= NOW() - INTERVAL '3 days' THEN 8
             WHEN scoring_source_at >= NOW() - INTERVAL '7 days' THEN 4
             ELSE 0 END
      + CASE WHEN confidence >= 0.80 THEN 5 WHEN confidence <= 0.40 THEN -8 ELSE 0 END
      + CASE WHEN evidence_count >= 3 THEN 4 WHEN evidence_count = 2 THEN 1 ELSE 0 END
      - CASE WHEN LOWER(title) LIKE 're-engage %' THEN 25 ELSE 0 END
      - CASE WHEN attention_text LIKE '%unresolved direct-chat loop%' THEN 0
             WHEN evidence_count = 0 THEN 45 WHEN evidence_count = 1 THEN 60 ELSE 0 END
      - CASE WHEN attention_text LIKE '%unresolved direct-chat loop%' THEN 0
             WHEN evidence_count = 1 AND scoring_source_at < NOW() - INTERVAL '14 days' THEN 15 ELSE 0 END
      - CASE WHEN opportunity_type = 'group_opportunity' AND evidence_count < 2 THEN 26 ELSE 0 END
      - CASE WHEN opportunity_type = 'group_opportunity' AND primary_contact_id IS NULL AND primary_project_id IS NULL THEN 18 ELSE 0 END
      - CASE WHEN NULLIF(TRIM(COALESCE(recommended_next_action, '')), '') IS NULL THEN 8 ELSE 0 END
      - CASE WHEN why_now IS NULL OR NULLIF(TRIM(COALESCE(why_now, '')), '') IS NULL THEN 35 ELSE 0 END
      - CASE WHEN action_text LIKE '%turn %into a concrete task%'
               OR action_text LIKE '%identify the best-fit person or project owner%'
               OR action_text LIKE '%send a short intro note explaining the specific mutual value%'
               OR action_text LIKE '%save a research task%'
               OR action_text LIKE '%assign an owner to validate the clustered risk%'
               OR action_text LIKE '%review the clustered signals%'
               OR action_text LIKE '%either convert to one concrete action or dismiss%'
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
      - CASE WHEN attention_text LIKE '%unresolved direct-chat loop%' THEN
                 CASE WHEN scoring_source_at < NOW() - INTERVAL '90 days' THEN 25
                      WHEN scoring_source_at < NOW() - INTERVAL '30 days' THEN 12
                      WHEN scoring_source_at < NOW() - INTERVAL '14 days' THEN 4
                      ELSE 0 END
             WHEN scoring_source_at < NOW() - INTERVAL '90 days' THEN 40
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
      CASE WHEN source_priority_bonus > 0 THEN 'high_signal_source' END,
      CASE WHEN surface_bucket = 'capital' THEN 'capital_surface' END,
      CASE WHEN surface_bucket = 'internal' THEN 'internal_surface' END,
      CASE WHEN surface_bucket = 'project' THEN 'project_surface' END,
      CASE WHEN surface_bucket = 'admin' THEN 'admin_surface' END,
      CASE WHEN surface_bucket = 'closure' THEN 'closure_surface' END,
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
             OR action_text LIKE '%assign an owner to validate the clustered risk%'
             OR action_text LIKE '%review the clustered signals%'
             OR action_text LIKE '%either convert to one concrete action or dismiss%'
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
  FROM classified_inputs
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
  surface_bucket,
  evidence_count,
  attention_score,
  quality_flags
FROM deduped
WHERE duplicate_rank = 1
  AND attention_score >= 20
  AND NOT ('no_evidence' = ANY(quality_flags))
  AND NOT ('low_value_admin' = ANY(quality_flags))
ORDER BY
  attention_score DESC NULLS LAST,
  CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
  COALESCE(source_last_seen_at, last_seen_at) DESC NULLS LAST,
  created_at DESC;

-- Precision-first daily budget. The complete ranked queue remains available for
-- audit/review, while ordinary daily consumers should read these ten items.
CREATE OR REPLACE VIEW intelligence.daily_attention_queue AS
SELECT * FROM intelligence.attention_queue
LIMIT 10;
