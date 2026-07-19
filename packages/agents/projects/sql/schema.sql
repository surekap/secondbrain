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

-- Insight lifecycle metadata is additive so existing installations retain history.
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_basis TEXT;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_evidence_refs JSONB DEFAULT '[]';
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolution_confidence NUMERIC(4,3);
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE projects.project_insights ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE projects.project_insights DROP CONSTRAINT IF EXISTS project_insights_resolution_status_check;
ALTER TABLE projects.project_insights ADD CONSTRAINT project_insights_resolution_status_check
  CHECK (resolution_status IN ('open','inferred_resolved','confirmed_resolved','dismissed'));
ALTER TABLE projects.project_insights DROP CONSTRAINT IF EXISTS project_insights_resolution_confidence_check;
ALTER TABLE projects.project_insights ADD CONSTRAINT project_insights_resolution_confidence_check
  CHECK (resolution_confidence IS NULL OR (resolution_confidence >= 0 AND resolution_confidence <= 1));
