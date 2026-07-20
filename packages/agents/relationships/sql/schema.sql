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

-- ── Canonical source identities ────────────────────────────────────────────────
-- Stable per-source identity keys for preventing duplicate people across
-- WhatsApp, email, phone, Apple Contacts, Limitless, and manual corrections.
-- relationships.contacts remains the canonical person/profile row.
CREATE TABLE IF NOT EXISTS relationships.contact_identities (
  id             BIGSERIAL PRIMARY KEY,
  contact_id     BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('whatsapp','email','phone','apple_contacts','manual','limitless')),
  identity_type  TEXT NOT NULL CHECK (identity_type IN ('wa_jid','email','phone','apple_contact_id','name_alias','limitless_speaker')),
  identity_value TEXT NOT NULL,
  confidence     NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  verified_by    TEXT DEFAULT 'system',
  is_active      BOOLEAN DEFAULT TRUE,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_identities_unique_active_idx
  ON relationships.contact_identities (source, identity_type, identity_value)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS contact_identities_contact_idx
  ON relationships.contact_identities (contact_id, is_active);

-- Invalid pseudo-identities (for example 0@c.us) must never participate in
-- exact matching. Keep the audit row but deactivate it in the derived registry.
UPDATE relationships.contact_identities
SET is_active = FALSE,
    metadata = COALESCE(metadata, '{}'::jsonb) ||
               jsonb_build_object('deactivated_reason', 'invalid_stable_identity'),
    updated_at = NOW()
WHERE is_active = TRUE
  AND (
    (identity_type = 'wa_jid' AND identity_value !~ '^([1-9][0-9]{6,14}@c\.us|[1-9][0-9]{6,20}@lid)$')
    OR (identity_type = 'phone' AND identity_value !~ '^[1-9][0-9]{6,14}$')
  );

-- Conflicting ownership is evidence to resolve, never permission for the newest
-- importer to steal an identity from an existing contact.
CREATE TABLE IF NOT EXISTS relationships.identity_conflicts (
  id                  BIGSERIAL PRIMARY KEY,
  source              TEXT NOT NULL,
  identity_type       TEXT NOT NULL,
  identity_value      TEXT NOT NULL,
  existing_contact_id BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  claimed_contact_id  BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','ignored')),
  occurrences         INT NOT NULL DEFAULT 1,
  metadata            JSONB NOT NULL DEFAULT '{}',
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_conflicts_pending_idx
  ON relationships.identity_conflicts (
    source, identity_type, identity_value, existing_contact_id, claimed_contact_id
  ) WHERE status = 'pending';

-- A duplicate profile that is already noise cannot own or contest a stable
-- identity. Close that derived review debt while retaining its audit history.
UPDATE relationships.identity_conflicts conflict
SET status = 'resolved',
    resolved_at = NOW(),
    metadata = conflict.metadata || jsonb_build_object(
      'resolved_reason', 'inactive_duplicate_claim',
      'resolved_to_contact_id', conflict.existing_contact_id::text
    )
FROM relationships.contacts existing_contact,
     relationships.contacts claimed_contact
WHERE conflict.status = 'pending'
  AND existing_contact.id = conflict.existing_contact_id
  AND claimed_contact.id = conflict.claimed_contact_id
  AND existing_contact.is_noise IS DISTINCT FROM TRUE
  AND claimed_contact.is_noise = TRUE;

-- Duplicate source rows remain as auditable raw profiles. This redirect makes
-- the canonical target explicit for every reader and future backfill.
CREATE TABLE IF NOT EXISTS relationships.contact_merge_redirects (
  from_contact_id BIGINT PRIMARY KEY REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  to_contact_id   BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE RESTRICT,
  reason          TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  merged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_contact_id <> to_contact_id)
);
CREATE INDEX IF NOT EXISTS contact_merge_redirects_target_idx
  ON relationships.contact_merge_redirects (to_contact_id);

-- Redirected/noise profiles cannot keep ownership of an active stable identity.
-- Preserve the row and its provenance, but remove it from exact-match decisions.
UPDATE relationships.contact_identities identity
SET is_active = FALSE,
    metadata = COALESCE(identity.metadata, '{}'::jsonb) || jsonb_build_object(
      'deactivated_reason', CASE
        WHEN redirect.from_contact_id IS NOT NULL THEN 'merged_contact_redirect'
        ELSE 'noise_contact'
      END,
      'canonical_contact_id', redirect.to_contact_id
    ),
    updated_at = NOW()
FROM relationships.contacts contact
LEFT JOIN relationships.contact_merge_redirects redirect
  ON redirect.from_contact_id = contact.id
WHERE identity.contact_id = contact.id
  AND identity.is_active = TRUE
  AND (contact.is_noise = TRUE OR redirect.from_contact_id IS NOT NULL);

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

-- One canonical event may reconcile several duplicated provider rows. Keep
-- every immutable raw-row pointer instead of overwriting one metadata field.
CREATE TABLE IF NOT EXISTS relationships.communication_source_rows (
  communication_id BIGINT NOT NULL REFERENCES relationships.communications(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_row_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, source_row_id)
);
CREATE INDEX IF NOT EXISTS communication_source_rows_communication_idx
  ON relationships.communication_source_rows (communication_id);

-- Canonical event identity is source + source_id for the current single-account
-- deployment. Preserve an audit redirect before removing historical rows that
-- were duplicated once per fragmented contact (including NULL contacts).
CREATE TABLE IF NOT EXISTS relationships.communication_merge_redirects (
  from_communication_id BIGINT PRIMARY KEY,
  to_communication_id   BIGINT NOT NULL REFERENCES relationships.communications(id) ON DELETE CASCADE,
  source                TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  from_contact_id       BIGINT,
  to_contact_id         BIGINT,
  from_snapshot         JSONB NOT NULL DEFAULT '{}',
  reason                TEXT NOT NULL DEFAULT 'canonical source event dedupe',
  merged_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_communication_id <> to_communication_id)
);
ALTER TABLE relationships.communication_merge_redirects ADD COLUMN IF NOT EXISTS from_contact_id BIGINT;
ALTER TABLE relationships.communication_merge_redirects ADD COLUMN IF NOT EXISTS to_contact_id BIGINT;
ALTER TABLE relationships.communication_merge_redirects ADD COLUMN IF NOT EXISTS from_snapshot JSONB NOT NULL DEFAULT '{}';

-- A later exact identity may repair a stale participant association. Preserve
-- both values so self-correction remains reviewable without changing raw data.
CREATE TABLE IF NOT EXISTS relationships.communication_identity_conflicts (
  id                  BIGSERIAL PRIMARY KEY,
  source              TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  previous_contact_id BIGINT NOT NULL,
  resolved_contact_id BIGINT NOT NULL,
  occurrences         INT NOT NULL DEFAULT 1,
  metadata            JSONB NOT NULL DEFAULT '{}',
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (previous_contact_id <> resolved_contact_id),
  UNIQUE (source, source_id, previous_contact_id, resolved_contact_id)
);
-- Exact identities also resolve previously unknown (NULL) participants. Keep
-- those transitions in the same audit ledger; NULL is historical derived state,
-- not missing raw evidence.
ALTER TABLE relationships.communication_identity_conflicts
  ALTER COLUMN previous_contact_id DROP NOT NULL;

WITH ranked AS (
  SELECT id, source, source_id,
         FIRST_VALUE(id) OVER (
           PARTITION BY source, source_id
           ORDER BY
             (NULLIF(metadata->>'media_semantic_text', '') IS NOT NULL) DESC,
             (contact_id IS NOT NULL) DESC,
             LENGTH(COALESCE(content_snippet, '')) DESC,
             (occurred_at IS NOT NULL) DESC,
             id ASC
         ) AS keeper_id,
         COUNT(*) OVER (PARTITION BY source, source_id) AS copies
  FROM relationships.communications
)
INSERT INTO relationships.communication_merge_redirects (
  from_communication_id, to_communication_id, source, source_id,
  from_contact_id, to_contact_id, from_snapshot
)
SELECT duplicate.id, ranked.keeper_id, ranked.source, ranked.source_id,
       duplicate.contact_id, keeper.contact_id, to_jsonb(duplicate)
FROM ranked
JOIN relationships.communications duplicate ON duplicate.id = ranked.id
JOIN relationships.communications keeper ON keeper.id = ranked.keeper_id
WHERE ranked.copies > 1 AND ranked.id <> ranked.keeper_id
ON CONFLICT (from_communication_id) DO UPDATE SET
  to_communication_id = EXCLUDED.to_communication_id,
  source = EXCLUDED.source,
  source_id = EXCLUDED.source_id,
  from_contact_id = EXCLUDED.from_contact_id,
  to_contact_id = EXCLUDED.to_contact_id,
  from_snapshot = EXCLUDED.from_snapshot,
  merged_at = NOW();

-- Fill missing keeper fields and merge metadata before deleting duplicate
-- derived rows. Raw email/WhatsApp/Limitless source tables are never modified.
UPDATE relationships.communications keeper SET
  contact_id = COALESCE(keeper.contact_id, (
    SELECT c.contact_id FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.contact_id IS NOT NULL
    ORDER BY c.id ASC LIMIT 1
  )),
  content_snippet = COALESCE((
    SELECT c.content_snippet FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND NULLIF(c.content_snippet, '') IS NOT NULL
    ORDER BY (NULLIF(c.metadata->>'media_semantic_text', '') IS NOT NULL) DESC,
             LENGTH(c.content_snippet) DESC, c.id ASC LIMIT 1
  ), keeper.content_snippet),
  subject = COALESCE(keeper.subject, (
    SELECT c.subject FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.subject IS NOT NULL
    ORDER BY c.id ASC LIMIT 1
  )),
  chat_id = COALESCE(keeper.chat_id, (
    SELECT c.chat_id FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.chat_id IS NOT NULL
    ORDER BY c.id ASC LIMIT 1
  )),
  group_name = COALESCE(keeper.group_name, (
    SELECT c.group_name FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.group_name IS NOT NULL
    ORDER BY c.id ASC LIMIT 1
  )),
  is_group = EXISTS (
    SELECT 1 FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.is_group = TRUE
  ),
  is_read = NOT EXISTS (
    SELECT 1 FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.is_read = FALSE
  ),
  is_replied = CASE
    WHEN EXISTS (
      SELECT 1 FROM relationships.communications c
      WHERE c.source = keeper.source AND c.source_id = keeper.source_id AND c.is_replied = TRUE
    ) THEN TRUE ELSE keeper.is_replied
  END,
  occurred_at = COALESCE(keeper.occurred_at, (
    SELECT MIN(c.occurred_at) FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id
  )),
  metadata = COALESCE((
    SELECT jsonb_object_agg(entry.key, entry.value ORDER BY (c.id = keeper.id))
    FROM relationships.communications c
    CROSS JOIN LATERAL jsonb_each(COALESCE(c.metadata, '{}'::jsonb)) entry
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id
  ), '{}'::jsonb) || COALESCE(keeper.metadata, '{}'::jsonb),
  created_at = (
    SELECT MIN(c.created_at) FROM relationships.communications c
    WHERE c.source = keeper.source AND c.source_id = keeper.source_id
  )
WHERE EXISTS (
  SELECT 1 FROM relationships.communication_merge_redirects redirect
  WHERE redirect.to_communication_id = keeper.id
);

-- Historical rows created before a native WhatsApp ID arrived used a stable
-- fallback fingerprint. Once the exact raw row exposes a native ID, merge only
-- proven one-to-one fallback/native pairs and preserve a full redirect snapshot.
WITH candidate_pairs AS (
  SELECT fallback.id AS fallback_id, native.id AS native_id
  FROM relationships.communications fallback
  JOIN public.messages raw
    ON COALESCE(fallback.metadata->>'source_row_id', '') ~ '^[0-9]+$'
   AND raw.id = (fallback.metadata->>'source_row_id')::bigint
  JOIN relationships.communications native
    ON native.source = 'whatsapp'
   AND native.source_id = 'wa:' || COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', ''))
  WHERE fallback.source = 'whatsapp'
    AND fallback.source_id LIKE 'wa:fallback:%'
    AND COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', '')) IS NOT NULL
    AND fallback.id <> native.id
), safe_pairs AS (
  SELECT pair.*
  FROM candidate_pairs pair
  WHERE (SELECT COUNT(*) FROM candidate_pairs x WHERE x.fallback_id = pair.fallback_id) = 1
    AND (SELECT COUNT(*) FROM candidate_pairs x WHERE x.native_id = pair.native_id) = 1
)
INSERT INTO relationships.communication_merge_redirects (
  from_communication_id, to_communication_id, source, source_id,
  from_contact_id, to_contact_id, from_snapshot, reason
)
SELECT fallback.id, native.id, 'whatsapp', fallback.source_id,
       fallback.contact_id, native.contact_id, to_jsonb(fallback),
       'native WhatsApp ID superseded deterministic fallback'
FROM safe_pairs pair
JOIN relationships.communications fallback ON fallback.id = pair.fallback_id
JOIN relationships.communications native ON native.id = pair.native_id
ON CONFLICT (from_communication_id) DO UPDATE SET
  to_communication_id = EXCLUDED.to_communication_id,
  from_contact_id = EXCLUDED.from_contact_id,
  to_contact_id = EXCLUDED.to_contact_id,
  from_snapshot = EXCLUDED.from_snapshot,
  reason = EXCLUDED.reason,
  merged_at = NOW();

UPDATE relationships.communications native SET
  contact_id = COALESCE(native.contact_id, fallback.contact_id),
  content_snippet = CASE
    WHEN NULLIF(native.metadata->>'media_semantic_text', '') IS NULL
     AND NULLIF(fallback.metadata->>'media_semantic_text', '') IS NOT NULL THEN fallback.content_snippet
    WHEN NULLIF(native.content_snippet, '') IS NULL THEN fallback.content_snippet
    ELSE native.content_snippet END,
  subject = COALESCE(native.subject, fallback.subject),
  chat_id = COALESCE(native.chat_id, fallback.chat_id),
  is_group = native.is_group OR fallback.is_group,
  group_name = COALESCE(native.group_name, fallback.group_name),
  is_read = native.is_read AND fallback.is_read,
  is_replied = CASE WHEN native.is_replied IS TRUE OR fallback.is_replied IS TRUE THEN TRUE ELSE native.is_replied END,
  metadata = COALESCE(fallback.metadata, '{}'::jsonb) || COALESCE(native.metadata, '{}'::jsonb),
  created_at = LEAST(native.created_at, fallback.created_at)
FROM relationships.communication_merge_redirects redirect
JOIN relationships.communications fallback ON fallback.id = redirect.from_communication_id
WHERE redirect.reason = 'native WhatsApp ID superseded deterministic fallback'
  AND native.id = redirect.to_communication_id;

DO $whatsapp_source_refs$
BEGIN
  IF to_regclass('projects.project_insights') IS NOT NULL THEN
    WITH mapping AS (
      SELECT fallback.source_id old_ref, native.source_id new_ref
      FROM relationships.communication_merge_redirects redirect
      JOIN relationships.communications fallback ON fallback.id = redirect.from_communication_id
      JOIN relationships.communications native ON native.id = redirect.to_communication_id
      WHERE redirect.reason = 'native WhatsApp ID superseded deterministic fallback'
    )
    UPDATE projects.project_insights insight
    SET evidence_refs = (
      SELECT COALESCE(jsonb_agg(to_jsonb(COALESCE(mapping.new_ref, value.ref)) ORDER BY value.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(insight.evidence_refs) = 'array' THEN insight.evidence_refs ELSE '[]'::jsonb END)
           WITH ORDINALITY value(ref, ordinality)
      LEFT JOIN mapping ON mapping.old_ref = value.ref
    )
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(insight.evidence_refs) = 'array' THEN insight.evidence_refs ELSE '[]'::jsonb END) value(ref)
      JOIN mapping ON mapping.old_ref = value.ref
    );
  END IF;

  IF to_regclass('relationships.insights') IS NOT NULL THEN
    WITH mapping AS (
      SELECT fallback.source_id old_ref, native.source_id new_ref
      FROM relationships.communication_merge_redirects redirect
      JOIN relationships.communications fallback ON fallback.id = redirect.from_communication_id
      JOIN relationships.communications native ON native.id = redirect.to_communication_id
      WHERE redirect.reason = 'native WhatsApp ID superseded deterministic fallback'
    )
    UPDATE relationships.insights insight
    SET source_refs = (
      SELECT COALESCE(jsonb_agg(to_jsonb(COALESCE(mapping.new_ref, value.ref)) ORDER BY value.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(insight.source_refs) = 'array' THEN insight.source_refs ELSE '[]'::jsonb END)
           WITH ORDINALITY value(ref, ordinality)
      LEFT JOIN mapping ON mapping.old_ref = value.ref
    )
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(insight.source_refs) = 'array' THEN insight.source_refs ELSE '[]'::jsonb END) value(ref)
      JOIN mapping ON mapping.old_ref = value.ref
    );
  END IF;

  IF to_regclass('projects.communication_classifications') IS NOT NULL THEN
    WITH mapping AS (
      SELECT fallback.source_id old_ref, native.source_id new_ref
      FROM relationships.communication_merge_redirects redirect
      JOIN relationships.communications fallback ON fallback.id = redirect.from_communication_id
      JOIN relationships.communications native ON native.id = redirect.to_communication_id
      WHERE redirect.reason = 'native WhatsApp ID superseded deterministic fallback'
    )
    UPDATE projects.communication_classifications classification
    SET metadata = jsonb_set(metadata, '{canonical_source_refs}', (
      SELECT COALESCE(jsonb_agg(to_jsonb(COALESCE(mapping.new_ref, value.ref)) ORDER BY value.ordinality), '[]'::jsonb)
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(classification.metadata->'canonical_source_refs') = 'array' THEN classification.metadata->'canonical_source_refs' ELSE '[]'::jsonb END)
           WITH ORDINALITY value(ref, ordinality)
      LEFT JOIN mapping ON mapping.old_ref = value.ref
    ), TRUE), updated_at = NOW()
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(classification.metadata->'canonical_source_refs') = 'array' THEN classification.metadata->'canonical_source_refs' ELSE '[]'::jsonb END) value(ref)
      JOIN mapping ON mapping.old_ref = value.ref
    );
  END IF;
END
$whatsapp_source_refs$;

-- Redirect the known logical references that store communication IDs as text.
-- There are currently no foreign keys to relationships.communications.id.
DO $communication_refs$
BEGIN
  IF to_regclass('intelligence.opportunity_evidence') IS NOT NULL THEN
    DELETE FROM intelligence.opportunity_evidence duplicate
    USING relationships.communication_merge_redirects redirect,
          intelligence.opportunity_evidence keeper
    WHERE duplicate.source_table = 'relationships.communications'
      AND duplicate.source_id = redirect.from_communication_id::text
      AND keeper.opportunity_id = duplicate.opportunity_id
      AND keeper.source_table = duplicate.source_table
      AND keeper.source_id = redirect.to_communication_id::text;
    UPDATE intelligence.opportunity_evidence evidence
    SET source_id = redirect.to_communication_id::text,
        source_ref = CASE
          WHEN evidence.source_ref = 'relationships.communication:' || redirect.from_communication_id::text
          THEN 'relationships.communication:' || redirect.to_communication_id::text
          ELSE evidence.source_ref END
    FROM relationships.communication_merge_redirects redirect
    WHERE evidence.source_table = 'relationships.communications'
      AND evidence.source_id = redirect.from_communication_id::text;
  END IF;

  IF to_regclass('intelligence.claim_evidence') IS NOT NULL THEN
    DELETE FROM intelligence.claim_evidence duplicate
    USING relationships.communication_merge_redirects redirect,
          intelligence.claim_evidence keeper
    WHERE duplicate.source_table = 'relationships.communications'
      AND duplicate.source_id = redirect.from_communication_id::text
      AND keeper.claim_id = duplicate.claim_id
      AND keeper.source_table = duplicate.source_table
      AND keeper.source_id = redirect.to_communication_id::text
      AND keeper.content_hash = duplicate.content_hash;
    UPDATE intelligence.claim_evidence evidence
    SET source_id = redirect.to_communication_id::text
    FROM relationships.communication_merge_redirects redirect
    WHERE evidence.source_table = 'relationships.communications'
      AND evidence.source_id = redirect.from_communication_id::text;
  END IF;

  IF to_regclass('intelligence.communication_events') IS NOT NULL THEN
    UPDATE intelligence.communication_events event
    SET source_id = redirect.to_communication_id::text,
        source_ref = CASE
          WHEN event.source_ref = 'relationships.communication:' || redirect.from_communication_id::text
          THEN 'relationships.communication:' || redirect.to_communication_id::text
          ELSE event.source_ref END
    FROM relationships.communication_merge_redirects redirect
    WHERE event.source_table = 'relationships.communications'
      AND event.source_id = redirect.from_communication_id::text;
  END IF;

  IF to_regclass('intelligence.signals') IS NOT NULL THEN
    UPDATE intelligence.signals signal
    SET source_id = redirect.to_communication_id::text,
        source_ref = CASE
          WHEN signal.source_ref = 'relationships.communication:' || redirect.from_communication_id::text
          THEN 'relationships.communication:' || redirect.to_communication_id::text
          ELSE signal.source_ref END
    FROM relationships.communication_merge_redirects redirect
    WHERE signal.source_table = 'relationships.communications'
      AND signal.source_id = redirect.from_communication_id::text;
  END IF;

  IF to_regclass('intelligence.object_topics') IS NOT NULL THEN
    DELETE FROM intelligence.object_topics duplicate
    USING relationships.communication_merge_redirects redirect,
          intelligence.object_topics keeper
    WHERE duplicate.object_type = 'communication'
      AND duplicate.object_id = redirect.from_communication_id::text
      AND keeper.topic_id = duplicate.topic_id
      AND keeper.object_type = duplicate.object_type
      AND keeper.object_id = redirect.to_communication_id::text
      AND COALESCE(keeper.role, 'mentioned') = COALESCE(duplicate.role, 'mentioned');
    UPDATE intelligence.object_topics topic
    SET object_id = redirect.to_communication_id::text
    FROM relationships.communication_merge_redirects redirect
    WHERE topic.object_type = 'communication'
      AND topic.object_id = redirect.from_communication_id::text;
  END IF;

  -- Exact textual references are secondary indexes into canonical evidence.
  -- Rewrite both historical source IDs and numeric canonical references so a
  -- merge can never leave guidance, facts, or clarifications dangling.
  IF to_regclass('relationships.contact_facts') IS NOT NULL THEN
    UPDATE relationships.contact_facts fact
    SET source_ref = CASE
      WHEN fact.source_ref = fallback.source_id THEN native.source_id
      WHEN fact.source_ref = 'relationships.communication:' || redirect.from_communication_id::text
        THEN 'relationships.communication:' || redirect.to_communication_id::text
      ELSE fact.source_ref END,
      updated_at = NOW()
    FROM relationships.communication_merge_redirects redirect
    JOIN relationships.communications fallback ON fallback.id = redirect.from_communication_id
    JOIN relationships.communications native ON native.id = redirect.to_communication_id
    WHERE fact.source_ref IN (
      fallback.source_id,
      'relationships.communication:' || redirect.from_communication_id::text
    );
  END IF;

  IF to_regclass('relationships.insights') IS NOT NULL THEN
    UPDATE relationships.insights insight
    SET source_ref = CASE
      WHEN insight.source_ref = fallback.source_id THEN native.source_id
      WHEN insight.source_ref = 'relationships.communication:' || redirect.from_communication_id::text
        THEN 'relationships.communication:' || redirect.to_communication_id::text
      ELSE insight.source_ref END,
      updated_at = NOW()
    FROM relationships.communication_merge_redirects redirect
    JOIN relationships.communications fallback ON fallback.id = redirect.from_communication_id
    JOIN relationships.communications native ON native.id = redirect.to_communication_id
    WHERE insight.source_ref IN (
      fallback.source_id,
      'relationships.communication:' || redirect.from_communication_id::text
    );
  END IF;

  IF to_regclass('intelligence.guidance_facts') IS NOT NULL THEN
    UPDATE intelligence.guidance_facts fact
    SET source_ref = 'relationships.communication:' || redirect.to_communication_id::text,
        updated_at = NOW()
    FROM relationships.communication_merge_redirects redirect
    WHERE fact.source_ref = 'relationships.communication:' || redirect.from_communication_id::text;
  END IF;

  IF to_regclass('intelligence.clarification_observations') IS NOT NULL THEN
    UPDATE intelligence.clarification_observations observation
    SET source_ref = 'relationships.communication:' || redirect.to_communication_id::text
    FROM relationships.communication_merge_redirects redirect
    WHERE observation.source_ref = 'relationships.communication:' || redirect.from_communication_id::text;
  END IF;
END
$communication_refs$;

DELETE FROM relationships.communications duplicate
USING relationships.communication_merge_redirects redirect
WHERE duplicate.id = redirect.from_communication_id;

-- A derived row without a surviving immutable raw row is retained for audit,
-- but excluded from all analysis until a later source sync re-establishes its
-- lineage. Re-running this migration automatically releases recovered rows.
CREATE TABLE IF NOT EXISTS relationships.communication_quarantine (
  communication_id BIGINT PRIMARY KEY REFERENCES relationships.communications(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  source_snapshot   JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  quarantined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at       TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'
);

WITH verified_ids AS (
  SELECT communication.id
  FROM relationships.communications communication
  JOIN public.messages raw
    ON COALESCE(communication.metadata->>'source_row_id', '') ~ '^[0-9]+$'
   AND raw.id = (communication.metadata->>'source_row_id')::bigint
  WHERE communication.source = 'whatsapp'
  UNION
  SELECT communication.id
  FROM public.messages raw
  JOIN relationships.communications communication
    ON communication.source = 'whatsapp'
   AND communication.source_id = 'wa:' || COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', ''))
  WHERE COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', '')) IS NOT NULL
)
UPDATE relationships.communications communication
SET metadata = (COALESCE(communication.metadata, '{}'::jsonb) - 'lineage_status')
             || jsonb_build_object('lineage_status', 'verified')
FROM verified_ids
WHERE communication.id = verified_ids.id
  AND communication.metadata->>'lineage_status' IS DISTINCT FROM 'verified';

UPDATE relationships.communication_quarantine quarantine
SET status = 'released', released_at = COALESCE(released_at, NOW())
FROM relationships.communications communication
WHERE communication.id = quarantine.communication_id
  AND communication.metadata->>'lineage_status' = 'verified'
  AND quarantine.status = 'active';

WITH verified_ids AS (
  SELECT communication.id
  FROM relationships.communications communication
  JOIN public.messages raw
    ON COALESCE(communication.metadata->>'source_row_id', '') ~ '^[0-9]+$'
   AND raw.id = (communication.metadata->>'source_row_id')::bigint
  WHERE communication.source = 'whatsapp'
  UNION
  SELECT communication.id
  FROM public.messages raw
  JOIN relationships.communications communication
    ON communication.source = 'whatsapp'
   AND communication.source_id = 'wa:' || COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', ''))
  WHERE COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', '')) IS NOT NULL
)
INSERT INTO relationships.communication_quarantine (
  communication_id, reason, source_snapshot, metadata
)
SELECT communication.id, 'canonical WhatsApp event has no immutable raw source row',
       to_jsonb(communication), '{"self_correcting":true}'::jsonb
FROM relationships.communications communication
WHERE communication.source = 'whatsapp'
  AND communication.source_id NOT LIKE 'wa:fallback:%'
  AND NOT EXISTS (SELECT 1 FROM verified_ids WHERE verified_ids.id = communication.id)
ON CONFLICT (communication_id) DO UPDATE SET
  status = 'active', released_at = NULL, source_snapshot = EXCLUDED.source_snapshot;

UPDATE relationships.communications communication
SET metadata = COALESCE(communication.metadata, '{}'::jsonb) - 'lineage_status'
             || jsonb_build_object('lineage_status', 'quarantined_missing_raw')
FROM relationships.communication_quarantine quarantine
WHERE communication.id = quarantine.communication_id
  AND quarantine.status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS comms_source_source_id_unique_idx
  ON relationships.communications (source, source_id);

CREATE INDEX IF NOT EXISTS comms_contact_id_idx    ON relationships.communications (contact_id);
CREATE INDEX IF NOT EXISTS comms_occurred_at_idx   ON relationships.communications (occurred_at DESC);
CREATE INDEX IF NOT EXISTS comms_source_idx        ON relationships.communications (source);
CREATE INDEX IF NOT EXISTS comms_chat_id_idx       ON relationships.communications (chat_id);

CREATE TABLE IF NOT EXISTS relationships.communication_recovery_runs (
  id             BIGSERIAL PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('running','completed','failed','partial')) DEFAULT 'running',
  page_size      INT NOT NULL,
  pages_processed INT NOT NULL DEFAULT 0,
  stats          JSONB NOT NULL DEFAULT '{}',
  error          TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS communication_recovery_runs_status_idx
  ON relationships.communication_recovery_runs (status, started_at DESC);

-- ── Contact touch ledger ──────────────────────────────────────────────────────
-- Metadata-only relationship touches from manual corrections, WhatsApp/iOS call
-- history, phone calls, in-person meetings, and other non-content sources.
CREATE TABLE IF NOT EXISTS relationships.contact_touches (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN (
                'manual','whatsapp','whatsapp_call','ios_call','phone','in_person','email','limitless'
              )),
  direction   TEXT CHECK (direction IN ('inbound','outbound','missed','unknown')) DEFAULT 'unknown',
  touched_at  TIMESTAMPTZ NOT NULL,
  duration_seconds INT,
  external_id TEXT,
  note        TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source, external_id, contact_id)
);

CREATE INDEX IF NOT EXISTS contact_touches_contact_idx ON relationships.contact_touches (contact_id, touched_at DESC);
CREATE INDEX IF NOT EXISTS contact_touches_source_idx  ON relationships.contact_touches (source, touched_at DESC);

-- ── Contact facts ──────────────────────────────────────────────────────────────
-- Durable relationship memory atoms. These are not free-text profile summaries;
-- they preserve evidence-backed facts such as preferences, important dates,
-- gifts, cancelled plans, support context, family links, and communication advice.
CREATE TABLE IF NOT EXISTS relationships.contact_facts (
  id             BIGSERIAL PRIMARY KEY,
  contact_id     BIGINT REFERENCES relationships.contacts(id) ON DELETE CASCADE,
  fact_type      TEXT NOT NULL CHECK (fact_type IN (
                   'gift_preference','important_date','life_event','support_context',
                   'cancelled_plan','gift_sent','personal_preference','family_context',
                   'communication_advice','open_loop','avoidance'
                 )),
  fact           TEXT NOT NULL,
  sentiment      TEXT CHECK (sentiment IN ('positive','neutral','sensitive','negative')) DEFAULT 'neutral',
  source         TEXT NOT NULL CHECK (source IN ('manual','whatsapp','email','limitless','hermes','import')),
  source_ref     TEXT,
  confidence     NUMERIC(4,3) DEFAULT 0.700 CHECK (confidence >= 0 AND confidence <= 1),
  occurred_at    TIMESTAMPTZ,
  first_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at     TIMESTAMPTZ,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_facts_dedupe_idx ON relationships.contact_facts (contact_id, fact_type, fact, COALESCE(source_ref, ''));
CREATE INDEX IF NOT EXISTS contact_facts_contact_idx ON relationships.contact_facts (contact_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS contact_facts_type_idx    ON relationships.contact_facts (fact_type, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS contact_facts_source_idx  ON relationships.contact_facts (source, source_ref);

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
CREATE UNIQUE INDEX IF NOT EXISTS relationship_analysis_single_running_idx
  ON relationships.analysis_runs (status) WHERE status = 'running';

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
CREATE INDEX IF NOT EXISTS contact_research_source_idx ON relationships.contact_research (source);

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
