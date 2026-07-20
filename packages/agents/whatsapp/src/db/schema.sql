-- Create whatsapp schema and set as default for postgres role
CREATE SCHEMA IF NOT EXISTS public;
ALTER ROLE postgres SET search_path TO public;
SET search_path TO public;

-- WhatsApp auth sessions (RemoteAuth persistence)
CREATE TABLE IF NOT EXISTS sessions (
  client_id    TEXT PRIMARY KEY,
  session_name TEXT NOT NULL,
  data         TEXT
);

-- All inbound WhatsApp events (denormalized for fast filter matching)
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL   PRIMARY KEY,
  client_id  TEXT        NOT NULL,
  event      TEXT        NOT NULL,
  data       JSONB       NOT NULL,
  chat_id    TEXT,
  group_id   TEXT,
  msg_type   TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_chat_id_idx  ON messages (chat_id);
CREATE INDEX IF NOT EXISTS messages_group_id_idx ON messages (group_id);
CREATE INDEX IF NOT EXISTS messages_ts_idx       ON messages (ts DESC);

-- wa_msg_id: WhatsApp message ID for deduplication (NULLs are not considered equal, so multiple NULLs are fine)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_msg_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_msg_id_idx ON messages (wa_msg_id) WHERE wa_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_serialized_id_idx
  ON messages ((data->'id'->>'_serialized'))
  WHERE data->'id'->>'_serialized' IS NOT NULL;

-- Webhook subscriber endpoints
CREATE TABLE IF NOT EXISTS subscribers (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  url        TEXT        NOT NULL,
  secret     TEXT,
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-subscriber message filters (OR semantics across rows, AND within a row)
-- A subscriber with no filters is a catch-all and receives every message.
CREATE TABLE IF NOT EXISTS filters (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  chat_id       TEXT,
  group_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS filters_subscriber_id_idx ON filters (subscriber_id);

-- Webhook delivery audit log (append-only; retries are new rows)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            BIGSERIAL   PRIMARY KEY,
  message_id    BIGINT      NOT NULL REFERENCES messages(id),
  subscriber_id UUID        NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  attempt       SMALLINT    NOT NULL DEFAULT 1,
  status        TEXT        NOT NULL DEFAULT 'pending',
  http_status   SMALLINT,
  response_body TEXT,
  error         TEXT,
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wd_message_id_idx    ON webhook_deliveries (message_id);
CREATE INDEX IF NOT EXISTS wd_subscriber_id_idx ON webhook_deliveries (subscriber_id);
CREATE INDEX IF NOT EXISTS wd_status_idx        ON webhook_deliveries (status)
  WHERE status IN ('pending', 'failed');

-- Chat name cache (populated during historical sync and live message events)
CREATE TABLE IF NOT EXISTS chat_metadata (
    chat_id     TEXT PRIMARY KEY,
    name        TEXT,
    is_group    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Durable historical-sync control state. Raw messages remain immutable; these
-- tables only record ingestion progress so an outage can resume safely.
CREATE TABLE IF NOT EXISTS whatsapp_sync_runs (
  id                 BIGSERIAL PRIMARY KEY,
  client_id          TEXT NOT NULL,
  trigger            TEXT NOT NULL DEFAULT 'manual',
  status             TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,
  lookback_days      INTEGER NOT NULL,
  overlap_minutes    INTEGER NOT NULL DEFAULT 0,
  msg_limit          INTEGER NOT NULL,
  page_size          INTEGER NOT NULL,
  chat_offset        INTEGER NOT NULL DEFAULT 0,
  chat_batch_size    INTEGER,
  download_media     BOOLEAN NOT NULL DEFAULT FALSE,
  attempt            INTEGER NOT NULL DEFAULT 1,
  total_chats        INTEGER NOT NULL DEFAULT 0,
  completed_chats    INTEGER NOT NULL DEFAULT 0,
  saved_count        INTEGER NOT NULL DEFAULT 0,
  duplicate_count    INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (window_end >= window_start)
);
CREATE INDEX IF NOT EXISTS whatsapp_sync_runs_client_idx
  ON whatsapp_sync_runs (client_id, id DESC);
CREATE INDEX IF NOT EXISTS whatsapp_sync_runs_status_idx
  ON whatsapp_sync_runs (status, heartbeat_at);

CREATE TABLE IF NOT EXISTS whatsapp_sync_checkpoints (
  id                 BIGSERIAL PRIMARY KEY,
  run_id             BIGINT NOT NULL REFERENCES whatsapp_sync_runs(id) ON DELETE CASCADE,
  client_id          TEXT NOT NULL,
  chat_id            TEXT NOT NULL,
  is_group           BOOLEAN NOT NULL DEFAULT FALSE,
  checkpoint_kind    TEXT NOT NULL CHECK (checkpoint_kind IN ('chat','page')),
  page_number        INTEGER NOT NULL,
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,
  page_start_ts      TIMESTAMPTZ,
  page_end_ts        TIMESTAMPTZ,
  cursor_wa_msg_id   TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  fetched_count      INTEGER NOT NULL DEFAULT 0,
  saved_count        INTEGER NOT NULL DEFAULT 0,
  duplicate_count    INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, chat_id, checkpoint_kind, page_number)
);
CREATE INDEX IF NOT EXISTS whatsapp_sync_checkpoints_resume_idx
  ON whatsapp_sync_checkpoints (run_id, checkpoint_kind, status, chat_id, page_number);
CREATE INDEX IF NOT EXISTS whatsapp_sync_checkpoints_group_idx
  ON whatsapp_sync_checkpoints (is_group, status, updated_at);

CREATE TABLE IF NOT EXISTS whatsapp_sync_watermarks (
  client_id                   TEXT NOT NULL,
  chat_id                     TEXT NOT NULL,
  is_group                    BOOLEAN NOT NULL DEFAULT FALSE,
  high_watermark_ts           TIMESTAMPTZ,
  high_watermark_wa_msg_id    TEXT,
  last_completed_window_start TIMESTAMPTZ NOT NULL,
  last_completed_window_end   TIMESTAMPTZ NOT NULL,
  last_run_id                 BIGINT REFERENCES whatsapp_sync_runs(id) ON DELETE SET NULL,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, chat_id)
);
CREATE INDEX IF NOT EXISTS whatsapp_sync_watermarks_group_idx
  ON whatsapp_sync_watermarks (is_group, last_completed_window_end DESC);

-- Hi-res media files downloaded from WhatsApp messages
CREATE TABLE IF NOT EXISTS media_files (
  id         BIGSERIAL PRIMARY KEY,
  wa_msg_id  TEXT NOT NULL,
  chat_id    TEXT,
  file_path  TEXT NOT NULL,
  mime_type  TEXT,
  file_size  BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (wa_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_media_files_wa_msg_id ON media_files(wa_msg_id);

-- Derived text keeps media searchable without mutating the raw WhatsApp event.
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS extracted_text TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS semantic_text TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_kind TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_provider TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_model TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_error TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
-- Cross-process leases make analysis safe when a connector is replaced or two
-- instances briefly overlap. Expired leases are reclaimable with SKIP LOCKED;
-- successful/failing writers must still own the lease they complete.
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_lease_owner TEXT;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS analysis_lease_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_media_files_analysis_status ON media_files(analysis_status);
CREATE INDEX IF NOT EXISTS idx_media_files_content_sha256
  ON media_files(content_sha256)
  WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_analysis_lease
  ON media_files(analysis_status, analysis_lease_expires_at, created_at)
  WHERE semantic_text IS NULL;
