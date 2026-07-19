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
  embedding_model TEXT NOT NULL DEFAULT 'gemini-embedding-2',
  metadata    JSONB DEFAULT '{}',
  indexed_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, source_id, embedding_model)
);

ALTER TABLE search.embeddings
  ALTER COLUMN embedding TYPE vector USING embedding::vector;

ALTER TABLE search.embeddings
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

UPDATE search.embeddings
SET embedding_model = 'gemini-embedding-2'
WHERE embedding_model IS NULL;

ALTER TABLE search.embeddings
  ALTER COLUMN embedding_model SET DEFAULT 'gemini-embedding-2';

ALTER TABLE search.embeddings
  ALTER COLUMN embedding_model SET NOT NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'search.embeddings'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (source, source_id)'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE search.embeddings DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS search_embeddings_source_id_model_unique
  ON search.embeddings (source, source_id, embedding_model);

DROP INDEX IF EXISTS search_embeddings_hnsw_idx;

-- Provider/model changes can mix dimensions (e.g. 384-d local embeddings and
-- 768-d Jina embeddings). pgvector ANN indexes require one fixed dimension and
-- will throw "different vector dimensions" during inserts/searches. Keep exact
-- vector search working without ANN until each model has its own dimension-safe
-- index.
DO $$
DECLARE
  idx RECORD;
BEGIN
  FOR idx IN
    SELECT schemaname, indexname
    FROM pg_indexes
    WHERE schemaname = 'search'
      AND tablename = 'embeddings'
      AND (indexdef ILIKE '% USING hnsw %' OR indexdef ILIKE '% USING ivfflat %')
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', idx.schemaname, idx.indexname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS search_embeddings_source_idx
  ON search.embeddings (source);

CREATE INDEX IF NOT EXISTS search_embeddings_model_idx
  ON search.embeddings (embedding_model);

CREATE INDEX IF NOT EXISTS search_embeddings_source_model_idx
  ON search.embeddings (source, embedding_model);
