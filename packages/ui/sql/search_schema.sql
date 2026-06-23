-- Semantic search schema
-- Run once: psql $DATABASE_URL -f packages/ui/sql/search_schema.sql

SET search_path TO public;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS search;

CREATE TABLE IF NOT EXISTS search.embeddings (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,   -- 'email' | 'whatsapp' | 'lifelog' | 'contact' | 'insight' | 'project' | 'project_insight'
  source_id   TEXT NOT NULL,   -- primary key from the source table
  content     TEXT NOT NULL,   -- the text that was embedded
  embedding   vector,          -- variable dimensions; must match embedding_model at query time
  embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-2-preview',
  metadata    JSONB DEFAULT '{}',
  indexed_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, source_id)
);

ALTER TABLE search.embeddings
  ALTER COLUMN embedding TYPE vector USING embedding::vector;

ALTER TABLE search.embeddings
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

UPDATE search.embeddings
SET embedding_model = 'gemini-embedding-2-preview'
WHERE embedding_model IS NULL;

ALTER TABLE search.embeddings
  ALTER COLUMN embedding_model SET DEFAULT 'gemini-embedding-2-preview';

ALTER TABLE search.embeddings
  ALTER COLUMN embedding_model SET NOT NULL;

DROP INDEX IF EXISTS search_embeddings_hnsw_idx;

CREATE INDEX IF NOT EXISTS search_embeddings_source_idx
  ON search.embeddings (source);

CREATE INDEX IF NOT EXISTS search_embeddings_model_idx
  ON search.embeddings (embedding_model);

CREATE INDEX IF NOT EXISTS search_embeddings_source_model_idx
  ON search.embeddings (source, embedding_model);
