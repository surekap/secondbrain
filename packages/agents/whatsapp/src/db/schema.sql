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
