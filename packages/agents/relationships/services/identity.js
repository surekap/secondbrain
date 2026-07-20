'use strict'

function normalizeIdentityValue(identityType, value) {
  if (value === null || value === undefined) return null
  let v = String(value).trim()
  if (!v) return null
  if (identityType === 'email') v = v.toLowerCase()
  if (identityType === 'wa_jid') {
    v = v.toLowerCase().replace(/@s\.whatsapp\.net$/, '@c.us')
    if (!/^(?:[1-9]\d{6,14}@c\.us|[1-9]\d{6,20}@lid)$/.test(v)) return null
  }
  if (identityType === 'phone') {
    v = v.replace(/[^0-9+]/g, '')
    if (v.startsWith('+')) v = v.slice(1)
    if (!/^[1-9]\d{6,14}$/.test(v)) return null
  }
  return v || null
}

function normalizeIdentity(identity = {}) {
  const source = String(identity.source || '').trim().toLowerCase()
  const identityType = String(identity.identity_type || identity.type || '').trim().toLowerCase()
  const identityValue = normalizeIdentityValue(identityType, identity.identity_value ?? identity.value)
  if (!source || !identityType || !identityValue) return null
  if (!['whatsapp', 'email', 'phone', 'apple_contacts', 'manual', 'limitless'].includes(source)) return null
  if (!['wa_jid', 'email', 'phone', 'apple_contact_id', 'name_alias', 'limitless_speaker'].includes(identityType)) return null
  return {
    source,
    identity_type: identityType,
    identity_value: identityValue,
    confidence: identity.confidence == null ? 1 : Number(identity.confidence),
    verified_by: identity.verified_by || 'system',
    metadata: identity.metadata || {},
  }
}

function identitiesForContactLike(contact = {}) {
  const identities = []
  for (const waJid of contact.wa_jids || []) {
    identities.push({ source: 'whatsapp', identity_type: 'wa_jid', identity_value: waJid, confidence: 1 })
  }
  for (const email of contact.emails || []) {
    identities.push({ source: 'email', identity_type: 'email', identity_value: email, confidence: 1 })
  }
  for (const phone of contact.phone_numbers || []) {
    identities.push({ source: 'phone', identity_type: 'phone', identity_value: phone, confidence: 0.98 })
  }
  if (contact.apple_contact_id) {
    identities.push({ source: 'apple_contacts', identity_type: 'apple_contact_id', identity_value: contact.apple_contact_id, confidence: 1 })
  }
  return identities.map(normalizeIdentity).filter(Boolean)
}

async function ensureIdentitySchema(pool) {
  await pool.query(`
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
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS contact_identities_unique_active_idx
      ON relationships.contact_identities (source, identity_type, identity_value)
      WHERE is_active;
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_identities_contact_idx
      ON relationships.contact_identities (contact_id, is_active);
  `)
  await pool.query(`
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
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS identity_conflicts_pending_idx
      ON relationships.identity_conflicts (
        source, identity_type, identity_value, existing_contact_id, claimed_contact_id
      ) WHERE status = 'pending';
  `)
  await pool.query(`
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
      AND claimed_contact.is_noise = TRUE
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relationships.contact_merge_redirects (
      from_contact_id BIGINT PRIMARY KEY REFERENCES relationships.contacts(id) ON DELETE CASCADE,
      to_contact_id   BIGINT NOT NULL REFERENCES relationships.contacts(id) ON DELETE RESTRICT,
      reason          TEXT NOT NULL,
      metadata        JSONB NOT NULL DEFAULT '{}',
      merged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (from_contact_id <> to_contact_id)
    );
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS contact_merge_redirects_target_idx
      ON relationships.contact_merge_redirects (to_contact_id);
  `)
  await pool.query(`
    UPDATE relationships.contact_identities
    SET is_active = FALSE,
        metadata = COALESCE(metadata, '{}'::jsonb) ||
                   jsonb_build_object('deactivated_reason', 'invalid_stable_identity'),
        updated_at = NOW()
    WHERE is_active = TRUE
      AND (
        (identity_type = 'wa_jid' AND identity_value !~ '^([1-9][0-9]{6,14}@c\\.us|[1-9][0-9]{6,20}@lid)$')
        OR (identity_type = 'phone' AND identity_value !~ '^[1-9][0-9]{6,14}$')
      )
  `)
}

async function findContactByIdentity(pool, identity) {
  const normalized = normalizeIdentity(identity)
  if (!normalized) return null
  const { rows } = await pool.query(`
    SELECT contact_id
    FROM relationships.contact_identities
    WHERE source = $1
      AND identity_type = $2
      AND identity_value = $3
      AND is_active = TRUE
    LIMIT 1
  `, [normalized.source, normalized.identity_type, normalized.identity_value])
  return rows[0]?.contact_id || null
}

async function upsertContactIdentity(pool, contactId, identity) {
  const normalized = normalizeIdentity(identity)
  if (!normalized || !contactId) return null
  const { rows: inserted } = await pool.query(`
    INSERT INTO relationships.contact_identities (
      contact_id, source, identity_type, identity_value, confidence, verified_by, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (source, identity_type, identity_value) WHERE is_active
    DO NOTHING
    RETURNING *
  `, [
    contactId,
    normalized.source,
    normalized.identity_type,
    normalized.identity_value,
    normalized.confidence,
    normalized.verified_by,
    JSON.stringify(normalized.metadata || {}),
  ])
  if (inserted[0]) return inserted[0]

  const { rows: owners } = await pool.query(`
    SELECT *
    FROM relationships.contact_identities
    WHERE source = $1
      AND identity_type = $2
      AND identity_value = $3
      AND is_active = TRUE
    LIMIT 1
  `, [normalized.source, normalized.identity_type, normalized.identity_value])
  const owner = owners[0]
  if (!owner) return null

  if (String(owner.contact_id) === String(contactId)) {
    const { rows } = await pool.query(`
      UPDATE relationships.contact_identities
      SET confidence  = GREATEST(COALESCE(confidence, 0), COALESCE($2::numeric, 0)),
          verified_by = $3,
          metadata    = metadata || $4::jsonb,
          updated_at  = NOW()
      WHERE id = $1
      RETURNING *
    `, [owner.id, normalized.confidence, normalized.verified_by, JSON.stringify(normalized.metadata || {})])
    return rows[0] || owner
  }

  await pool.query(`
    INSERT INTO relationships.identity_conflicts (
      source, identity_type, identity_value, existing_contact_id, claimed_contact_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (source, identity_type, identity_value, existing_contact_id, claimed_contact_id)
      WHERE status = 'pending'
    DO UPDATE SET
      occurrences = relationships.identity_conflicts.occurrences + 1,
      metadata = relationships.identity_conflicts.metadata || EXCLUDED.metadata,
      last_seen_at = NOW()
  `, [
    normalized.source,
    normalized.identity_type,
    normalized.identity_value,
    owner.contact_id,
    contactId,
    JSON.stringify(normalized.metadata || {}),
  ])

  return { ...owner, conflict: true, requested_contact_id: contactId }
}

async function recordContactIdentities(pool, contactId, identities = []) {
  const out = []
  for (const identity of identities.map(normalizeIdentity).filter(Boolean)) {
    out.push(await upsertContactIdentity(pool, contactId, identity))
  }
  return out.filter(Boolean)
}

async function mergeContactRecords(pool, canonicalId, duplicateIds = [], options = {}) {
  const canonical = String(canonicalId || '').trim()
  const duplicates = [...new Set((duplicateIds || []).map(id => String(id || '').trim()).filter(id => id && id !== canonical))]
  if (!canonical || !duplicates.length) return { canonical_id: canonical, duplicate_ids: [], merged: 0 }

  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  try {
    await ensureIdentitySchema(client)
  } catch (err) {
    if (client !== pool && typeof client.release === 'function') client.release()
    throw err
  }
  const params = [canonical, duplicates]
  const run = async (sql, extra = []) => client.query(sql, params.concat(extra))
  let savepointId = 0
  const optionalSchemaError = err => /does not exist|relation .* does not exist|column .* does not exist/i.test(err.message)
  const runOptional = async (sql, extra = []) => {
    const savepoint = `merge_optional_${++savepointId}`
    await client.query(`SAVEPOINT ${savepoint}`)
    try {
      const result = await run(sql, extra)
      await client.query(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await client.query(`RELEASE SAVEPOINT ${savepoint}`)
      if (optionalSchemaError(err)) return null
      throw err
    }
  }

  await client.query('BEGIN')
  try {
    const { rows: contactRows } = await client.query(`
      SELECT id, display_name, normalized_name, emails, phone_numbers, wa_jids, tags,
             first_interaction_at, last_interaction_at, manual_overrides
      FROM relationships.contacts
      WHERE id::text = $1 OR id::text = ANY($2::text[])
      ORDER BY CASE WHEN id::text = $1 THEN 0 ELSE 1 END, id ASC
    `, params)
    const canonicalRow = contactRows.find(r => String(r.id) === canonical)
    if (!canonicalRow) throw new Error(`Canonical contact ${canonical} not found`)
    const canonicalOverrides = canonicalRow.manual_overrides || {}

    await run(`
      UPDATE relationships.contacts c SET
        emails = ARRAY(SELECT DISTINCT unnest(c.emails || COALESCE(src.emails, '{}'))),
        phone_numbers = ARRAY(SELECT DISTINCT unnest(c.phone_numbers || COALESCE(src.phone_numbers, '{}'))),
        wa_jids = ARRAY(SELECT DISTINCT unnest(c.wa_jids || COALESCE(src.wa_jids, '{}'))),
        tags = ARRAY(SELECT DISTINCT unnest(c.tags || COALESCE(src.tags, '{}'))),
        first_interaction_at = LEAST(c.first_interaction_at, src.first_interaction_at),
        last_interaction_at = GREATEST(c.last_interaction_at, src.last_interaction_at),
        manual_overrides = COALESCE(src.manual_overrides, '{}'::jsonb) || COALESCE(c.manual_overrides, '{}'::jsonb),
        updated_at = NOW()
      FROM (
        SELECT ARRAY_AGG(DISTINCT e) FILTER (WHERE e IS NOT NULL) AS emails,
               ARRAY_AGG(DISTINCT p) FILTER (WHERE p IS NOT NULL) AS phone_numbers,
               ARRAY_AGG(DISTINCT w) FILTER (WHERE w IS NOT NULL) AS wa_jids,
               ARRAY_AGG(DISTINCT t) FILTER (WHERE t IS NOT NULL) AS tags,
               MIN(first_interaction_at) AS first_interaction_at,
               MAX(last_interaction_at) AS last_interaction_at,
               jsonb_object_agg(k, v ORDER BY dup.id DESC) FILTER (WHERE k IS NOT NULL) AS manual_overrides
        FROM relationships.contacts dup
        LEFT JOIN LATERAL unnest(dup.emails) e ON TRUE
        LEFT JOIN LATERAL unnest(dup.phone_numbers) p ON TRUE
        LEFT JOIN LATERAL unnest(dup.wa_jids) w ON TRUE
        LEFT JOIN LATERAL unnest(dup.tags) t ON TRUE
        LEFT JOIN LATERAL jsonb_each(COALESCE(dup.manual_overrides, '{}'::jsonb)) mo(k, v) ON TRUE
        WHERE dup.id::text = ANY($2::text[])
      ) src
      WHERE c.id::text = $1
    `)

    // Delete rows that would conflict after moving duplicate contact IDs onto the canonical ID.
    // These are duplicate evidence rows created by the previous polluted identity model.
    const conflictDeletes = [
      `DELETE FROM relationships.communications d
       USING relationships.communications c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.source = c.source
         AND d.source_id = c.source_id`,
      `DELETE FROM relationships.contact_touches d
       USING relationships.contact_touches c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.source = c.source
         AND COALESCE(d.external_id, '') = COALESCE(c.external_id, '')`,
      `DELETE FROM relationships.contact_facts d
       USING relationships.contact_facts c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.fact_type = c.fact_type
         AND d.fact = c.fact
         AND COALESCE(d.source_ref, '') = COALESCE(c.source_ref, '')`,
      `DELETE FROM relationships.contact_topics d
       USING relationships.contact_topics c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.topic = c.topic`,
      `DELETE FROM relationships.contact_research d
       USING relationships.contact_research c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.source = c.source`,
      `DELETE FROM intelligence.opportunity_contacts d
       USING intelligence.opportunity_contacts c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.opportunity_id = c.opportunity_id
         AND d.role = c.role`,
      `DELETE FROM intelligence.contact_organizations d
       USING intelligence.contact_organizations c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.organization_id = c.organization_id
         AND COALESCE(d.relationship, 'other') = COALESCE(c.relationship, 'other')`,
      `DELETE FROM relationships.contact_identities d
       USING relationships.contact_identities c
       WHERE d.contact_id::text = ANY($2::text[])
         AND c.contact_id::text = $1
         AND d.source = c.source
         AND d.identity_type = c.identity_type
         AND d.identity_value = c.identity_value
         AND d.is_active = TRUE
         AND c.is_active = TRUE`,
      `DELETE FROM intelligence.entity_aliases d
       USING intelligence.entity_aliases c
       WHERE d.entity_type = 'contact'
         AND c.entity_type = 'contact'
         AND d.entity_id = ANY($2::text[])
         AND c.entity_id = $1
         AND d.normalized_alias = c.normalized_alias`,
      `DELETE FROM intelligence.object_topics d
       USING intelligence.object_topics c
       WHERE d.object_type = 'contact'
         AND c.object_type = 'contact'
         AND d.object_id = ANY($2::text[])
         AND c.object_id = $1
         AND d.topic_id = c.topic_id
         AND COALESCE(d.role, 'mentioned') = COALESCE(c.role, 'mentioned')`,
    ]
    for (const sql of conflictDeletes) {
      await runOptional(sql)
    }

    const updateTables = [
      ['relationships.communications', 'contact_id'],
      ['relationships.contact_touches', 'contact_id'],
      ['relationships.contact_facts', 'contact_id'],
      ['relationships.contact_topics', 'contact_id'],
      ['relationships.email_senders', 'contact_id'],
      ['relationships.contact_research', 'contact_id'],
      ['relationships.insights', 'contact_id'],
      ['intelligence.signals', 'contact_id'],
      ['intelligence.communication_events', 'source_contact_id'],
      ['intelligence.opportunities', 'primary_contact_id'],
      ['intelligence.contact_organizations', 'contact_id'],
      ['intelligence.opportunity_contacts', 'contact_id'],
      ['projects.project_communications', 'contact_id'],
      ['projects.communication_classifications', 'contact_id'],
    ]

    for (const [table, column] of updateTables) {
      await runOptional(`UPDATE ${table} SET ${column} = $1::bigint WHERE ${column}::text = ANY($2::text[])`)
    }

    await runOptional(`
        UPDATE relationships.insights
        SET contact_ids = ARRAY(
          SELECT DISTINCT CASE WHEN x::text = ANY($2::text[]) THEN $1::bigint ELSE x END
          FROM unnest(contact_ids) x
        )
        WHERE contact_ids && (SELECT ARRAY_AGG(x::bigint) FROM unnest($2::text[]) x)
      `)

    await runOptional(`
        UPDATE projects.projects
        SET key_contact_ids = ARRAY(
          SELECT DISTINCT CASE WHEN x::text = ANY($2::text[]) THEN $1::bigint ELSE x END
          FROM unnest(COALESCE(key_contact_ids, '{}')) x
        ),
        updated_at = NOW()
        WHERE COALESCE(key_contact_ids, '{}') &&
              (SELECT ARRAY_AGG(x::bigint) FROM unnest($2::text[]) x)
      `)

    await runOptional(`
        UPDATE intelligence.entity_aliases
        SET entity_id = $1
        WHERE entity_type = 'contact' AND entity_id = ANY($2::text[])
      `)

    await runOptional(`
        UPDATE intelligence.object_topics
        SET object_id = $1
        WHERE object_type = 'contact' AND object_id = ANY($2::text[])
      `)

    const semanticScopeUpdates = [
      `UPDATE intelligence.claims SET subject_id = $1, updated_at = NOW()
       WHERE subject_type = 'contact' AND subject_id = ANY($2::text[])`,
      `UPDATE intelligence.claims SET object_id = $1, updated_at = NOW()
       WHERE object_type = 'contact' AND object_id = ANY($2::text[])`,
      `UPDATE intelligence.guidance_facts SET scope_id = $1, updated_at = NOW()
       WHERE scope_type = 'contact' AND scope_id = ANY($2::text[])`,
      `UPDATE intelligence.clarification_questions SET scope_id = $1, updated_at = NOW()
       WHERE scope_type = 'contact' AND scope_id = ANY($2::text[])`,
      `UPDATE intelligence.opportunity_suppressions SET scope_id = $1
       WHERE scope_type = 'contact' AND scope_id = ANY($2::text[])`,
    ]
    for (const sql of semanticScopeUpdates) await runOptional(sql)

    await run(`UPDATE relationships.contact_identities SET contact_id = $1::bigint, updated_at = NOW() WHERE contact_id::text = ANY($2::text[])`)

    // Remove duplicate comm rows created by previous polluted contact IDs, keeping the canonical/oldest row.
    await client.query(`
      DELETE FROM relationships.communications c
      USING relationships.communications keeper
      WHERE c.id > keeper.id
        AND c.source = keeper.source
        AND c.source_id = keeper.source_id
        AND c.contact_id = keeper.contact_id
        AND c.contact_id::text = $1
    `, [canonical])

    await run(`
      UPDATE relationships.contacts
      SET is_noise = TRUE,
          relationship_strength = 'noise',
          summary = COALESCE(summary, '') || CASE WHEN summary LIKE '%Merged duplicate%' THEN '' ELSE ' Merged duplicate into contact ' || $1 || '.' END,
          updated_at = NOW()
      WHERE id::text = ANY($2::text[])
    `)

    for (const duplicateId of duplicates) {
      const duplicateRow = contactRows.find(row => String(row.id) === duplicateId)
      const duplicateOverrides = duplicateRow?.manual_overrides || {}
      const manualOverrideConflicts = Object.keys(duplicateOverrides)
        .filter(key => Object.prototype.hasOwnProperty.call(canonicalOverrides, key))
        .filter(key => JSON.stringify(duplicateOverrides[key]) !== JSON.stringify(canonicalOverrides[key]))
        .map(key => ({ key, canonical_value: canonicalOverrides[key], duplicate_value: duplicateOverrides[key] }))
      await client.query(`
        INSERT INTO relationships.contact_merge_redirects (
          from_contact_id, to_contact_id, reason, metadata
        ) VALUES ($1::bigint, $2::bigint, $3, $4::jsonb)
        ON CONFLICT (from_contact_id) DO UPDATE SET
          to_contact_id = EXCLUDED.to_contact_id,
          reason = EXCLUDED.reason,
          metadata = relationships.contact_merge_redirects.metadata || EXCLUDED.metadata,
          merged_at = NOW()
      `, [
        duplicateId,
        canonical,
        options.note || 'Exact source identity merge',
        JSON.stringify({
          duplicate_key: options.duplicate_key || null,
          decided_by: options.decided_by || 'system',
          from_snapshot: duplicateRow || {},
          manual_override_conflicts: manualOverrideConflicts,
          conflict_resolution: 'canonical_value_preserved',
        }),
      ])
    }

    await runOptional(`
      UPDATE relationships.identity_conflicts
      SET status = 'resolved',
          resolved_at = NOW(),
          metadata = metadata || jsonb_build_object('resolved_to_contact_id', $1::text)
      WHERE status = 'pending'
        AND (
          existing_contact_id::text = ANY($2::text[])
          OR claimed_contact_id::text = ANY($2::text[])
        )
    `)

    if (options.recordDecision !== false) {
      const key = options.duplicate_key || `exact_identity:${canonical}:${duplicates.join(',')}`
      await runOptional(`
        INSERT INTO intelligence.duplicate_decisions (entity_type, duplicate_key, action, canonical_id, duplicate_ids, decided_by, note)
        VALUES ('contact', $3, 'confirmed', $1, $2::text[], $4, $5)
        ON CONFLICT (entity_type, duplicate_key) DO UPDATE SET
          action = EXCLUDED.action,
          canonical_id = EXCLUDED.canonical_id,
          duplicate_ids = EXCLUDED.duplicate_ids,
          decided_by = EXCLUDED.decided_by,
          note = EXCLUDED.note,
          decided_at = NOW()
      `, [key, options.decided_by || 'system', options.note || 'Exact source identity merge'])
    }

    await client.query('COMMIT')
    return { canonical_id: canonical, duplicate_ids: duplicates, merged: duplicates.length }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release()
  }
}

module.exports = {
  normalizeIdentityValue,
  normalizeIdentity,
  identitiesForContactLike,
  ensureIdentitySchema,
  findContactByIdentity,
  upsertContactIdentity,
  recordContactIdentities,
  mergeContactRecords,
}
