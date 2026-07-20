CREATE SCHEMA IF NOT EXISTS projects;

CREATE TABLE IF NOT EXISTS projects.projects (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT CHECK (status IN ('active','stalled','completed','on_hold','unknown')) DEFAULT 'active',
  health            TEXT CHECK (health IN ('on_track','at_risk','blocked','unknown')) DEFAULT 'unknown',
  priority          TEXT CHECK (priority IN ('high','medium','low')) DEFAULT 'medium',
  tags              TEXT[] DEFAULT '{}',
  next_action       TEXT,
  last_activity_at  TIMESTAMPTZ,
  comm_count        INT DEFAULT 0,
  key_contact_ids   BIGINT[] DEFAULT '{}',
  is_archived       BOOLEAN DEFAULT FALSE,
  archived_at       TIMESTAMPTZ,
  archive_reason    TEXT,
  archive_version   TEXT,
  ai_summary        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects.project_communications (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT REFERENCES projects.projects(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('email','whatsapp','limitless')),
  source_id       TEXT NOT NULL,
  contact_id      BIGINT,
  content_snippet TEXT,
  subject         TEXT,
  occurred_at     TIMESTAMPTZ,
  relevance_score FLOAT DEFAULT 1.0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, source, source_id)
);

CREATE TABLE IF NOT EXISTS projects.project_insights (
  id           BIGSERIAL PRIMARY KEY,
  project_id   BIGINT REFERENCES projects.projects(id) ON DELETE CASCADE,
  insight_type TEXT NOT NULL CHECK (insight_type IN ('status','next_action','risk','opportunity','blocker','decision')),
  content      TEXT NOT NULL,
  priority     TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  is_resolved  BOOLEAN DEFAULT FALSE,
  resolution_status TEXT NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open','inferred_resolved','confirmed_resolved','dismissed')),
  resolution_basis TEXT,
  resolution_evidence_refs JSONB DEFAULT '[]',
  resolution_confidence NUMERIC(4,3) CHECK (resolution_confidence IS NULL OR (resolution_confidence >= 0 AND resolution_confidence <= 1)),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects.analysis_runs (
  id                 BIGSERIAL PRIMARY KEY,
  status             TEXT DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  projects_found     INT DEFAULT 0,
  comms_classified   INT DEFAULT 0,
  error              TEXT,
  started_at         TIMESTAMPTZ DEFAULT NOW(),
  completed_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS projects.project_candidates (
  candidate_fingerprint TEXT PRIMARY KEY,
  proposed_name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  evidence_refs JSONB NOT NULL DEFAULT '[]',
  occurrences INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','admitted','rejected')),
  admitted_project_id BIGINT REFERENCES projects.projects(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS project_candidates_status_idx
  ON projects.project_candidates (status, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS project_analysis_single_running_idx
  ON projects.analysis_runs (status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS projects.communication_classifications (
  id                    BIGSERIAL PRIMARY KEY,
  source                TEXT NOT NULL CHECK (source IN ('email','whatsapp','limitless')),
  episode_id            TEXT NOT NULL,
  content_hash          TEXT NOT NULL,
  project_catalog_hash  TEXT NOT NULL,
  classifier_version    TEXT NOT NULL,
  model_profile         TEXT NOT NULL DEFAULT 'bulk_structured',
  decision              TEXT NOT NULL CHECK (decision IN ('matched','no_match')),
  project_id            BIGINT REFERENCES projects.projects(id) ON DELETE SET NULL,
  contact_id            BIGINT,
  relevance_score       NUMERIC(5,4) CHECK (relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 1)),
  rationale             TEXT,
  is_current            BOOLEAN NOT NULL DEFAULT TRUE,
  metadata              JSONB NOT NULL DEFAULT '{}',
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, episode_id, content_hash, project_catalog_hash, classifier_version)
);
CREATE INDEX IF NOT EXISTS communication_classifications_lookup_idx
  ON projects.communication_classifications (source, episode_id, project_catalog_hash, classifier_version, is_current);
CREATE INDEX IF NOT EXISTS communication_classifications_negative_idx
  ON projects.communication_classifications (source, decided_at DESC)
  WHERE decision = 'no_match' AND is_current = TRUE;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_status       ON projects.projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_health       ON projects.projects(health);
CREATE INDEX IF NOT EXISTS idx_projects_priority     ON projects.projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_archived     ON projects.projects(is_archived);
CREATE INDEX IF NOT EXISTS idx_projects_last_activity ON projects.projects(last_activity_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_proj_comms_project_id  ON projects.project_communications(project_id);
CREATE INDEX IF NOT EXISTS idx_proj_comms_occurred_at ON projects.project_communications(occurred_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_proj_comms_source      ON projects.project_communications(source);
CREATE INDEX IF NOT EXISTS idx_proj_comms_created_at  ON projects.project_communications(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_proj_insights_project_id  ON projects.project_insights(project_id);
CREATE INDEX IF NOT EXISTS idx_proj_insights_resolved    ON projects.project_insights(is_resolved);
CREATE INDEX IF NOT EXISTS idx_proj_insights_priority    ON projects.project_insights(priority);

CREATE INDEX IF NOT EXISTS idx_analysis_runs_status ON projects.analysis_runs(status);

-- ── Manual overrides ───────────────────────────────────────────────────────────
-- Stores fields that were manually set in the UI. Agents must not overwrite these.
-- Structure: { "field_name": { "value": ..., "set_at": "ISO timestamp" }, ... }
ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS manual_overrides JSONB DEFAULT '{}';
ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS discovery_evidence_refs JSONB NOT NULL DEFAULT '[]';
ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS discovery_version TEXT;
ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE projects.projects ADD COLUMN IF NOT EXISTS archive_version TEXT;

ALTER TABLE projects.project_communications ADD COLUMN IF NOT EXISTS episode_id TEXT;
ALTER TABLE projects.project_communications ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE projects.project_communications ADD COLUMN IF NOT EXISTS classification_decision_id BIGINT REFERENCES projects.communication_classifications(id) ON DELETE SET NULL;
ALTER TABLE projects.project_communications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
UPDATE projects.project_communications SET episode_id = source_id WHERE episode_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_proj_comms_episode ON projects.project_communications (source, episode_id);
CREATE INDEX IF NOT EXISTS idx_proj_comms_updated_at ON projects.project_communications (updated_at DESC);

-- Insight lifecycle metadata is additive so existing installations retain history.
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_basis TEXT;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_evidence_refs JSONB DEFAULT '[]';
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_confidence NUMERIC(4,3);
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS insight_fingerprint TEXT;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS evidence_refs JSONB DEFAULT '[]';
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS evidence_occurred_at TIMESTAMPTZ;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS project_insights_active_fingerprint_idx
  ON projects.project_insights (project_id, insight_fingerprint)
  WHERE insight_fingerprint IS NOT NULL AND is_resolved = FALSE;
ALTER TABLE projects.project_insights DROP CONSTRAINT IF EXISTS project_insights_resolution_status_check;
ALTER TABLE projects.project_insights ADD CONSTRAINT project_insights_resolution_status_check
  CHECK (resolution_status IN ('open','inferred_resolved','confirmed_resolved','dismissed'));
ALTER TABLE projects.project_insights DROP CONSTRAINT IF EXISTS project_insights_resolution_confidence_check;
ALTER TABLE projects.project_insights ADD CONSTRAINT project_insights_resolution_confidence_check
  CHECK (resolution_confidence IS NULL OR (resolution_confidence >= 0 AND resolution_confidence <= 1));

-- Reconcile legacy lifecycle combinations and remove unsupported generated
-- prose from the active compatibility projection. Canonical items are rebuilt
-- only from exact communication evidence.
UPDATE projects.project_insights
SET resolution_status = 'inferred_resolved',
    resolution_basis = COALESCE(resolution_basis, 'Legacy resolved flag normalized by project schema migration'),
    resolved_at = COALESCE(resolved_at, updated_at, NOW()),
    resolved_by = COALESCE(resolved_by, 'schema_migration'),
    updated_at = NOW()
WHERE is_resolved = TRUE AND resolution_status = 'open';

UPDATE projects.project_insights
SET is_resolved = TRUE,
    resolution_status = 'dismissed',
    resolution_basis = 'Quarantined legacy project insight without canonical evidence lineage',
    resolved_at = COALESCE(resolved_at, NOW()),
    resolved_by = 'schema_migration',
    updated_at = NOW()
WHERE is_resolved = FALSE
  AND resolution_status = 'open'
  AND (
    COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(evidence_refs) = 'array' THEN evidence_refs ELSE '[]'::jsonb END), 0) = 0
    OR insight_fingerprint IS NULL
  );

WITH aggregates AS (
  SELECT project.id,
         COUNT(communication.id)::int AS communication_count,
         MAX(communication.occurred_at) AS last_activity_at
  FROM projects.projects project
  LEFT JOIN projects.project_communications communication ON communication.project_id = project.id
  GROUP BY project.id
)
UPDATE projects.projects project
SET comm_count = aggregates.communication_count,
    last_activity_at = aggregates.last_activity_at,
    updated_at = CASE
      WHEN project.comm_count IS DISTINCT FROM aggregates.communication_count
        OR project.last_activity_at IS DISTINCT FROM aggregates.last_activity_at
      THEN NOW() ELSE project.updated_at END
FROM aggregates
WHERE project.id = aggregates.id
  AND (
    project.comm_count IS DISTINCT FROM aggregates.communication_count
    OR project.last_activity_at IS DISTINCT FROM aggregates.last_activity_at
  );
