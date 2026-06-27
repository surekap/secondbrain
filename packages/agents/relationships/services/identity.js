'use strict'

function normalizeIdentityValue(identityType, value) {
  if (value === null || value === undefined) return null
  let v = String(value).trim()
  if (!v) return null
  if (identityType === 'email') v = v.toLowerCase()
  if (identityType === 'wa_jid') v = v.toLowerCase()
  if (identityType === 'phone') v = v.replace(/[^0-9+]/g, '')
  if (identityType === 'phone' && v.startsWith('+')) v = v.slice(1)
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
  const { rows } = await pool.query(`
    INSERT INTO relationships.contact_identities (
      contact_id, source, identity_type, identity_value, confidence, verified_by, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (source, identity_type, identity_value) WHERE is_active
    DO UPDATE SET
      contact_id  = EXCLUDED.contact_id,
      confidence  = GREATEST(COALESCE(relationships.contact_identities.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
      verified_by = EXCLUDED.verified_by,
      metadata    = relationships.contact_identities.metadata || EXCLUDED.metadata,
      updated_at  = NOW()
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
  return rows[0] || null
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

  const params = [canonical, duplicates]
  const run = async (sql, extra = []) => pool.query(sql, params.concat(extra))

  await pool.query('BEGIN')
  try {
    const { rows: contactRows } = await pool.query(`
      SELECT id, display_name, normalized_name, emails, phone_numbers, wa_jids, tags,
             first_interaction_at, last_interaction_at, manual_overrides
      FROM relationships.contacts
      WHERE id::text = $1 OR id::text = ANY($2::text[])
      ORDER BY CASE WHEN id::text = $1 THEN 0 ELSE 1 END, id ASC
    `, params)
    const canonicalRow = contactRows.find(r => String(r.id) === canonical)
    if (!canonicalRow) throw new Error(`Canonical contact ${canonical} not found`)

    await run(`
      UPDATE relationships.contacts c SET
        emails = ARRAY(SELECT DISTINCT unnest(c.emails || COALESCE(src.emails, '{}'))),
        phone_numbers = ARRAY(SELECT DISTINCT unnest(c.phone_numbers || COALESCE(src.phone_numbers, '{}'))),
        wa_jids = ARRAY(SELECT DISTINCT unnest(c.wa_jids || COALESCE(src.wa_jids, '{}'))),
        tags = ARRAY(SELECT DISTINCT unnest(c.tags || COALESCE(src.tags, '{}'))),
        first_interaction_at = LEAST(c.first_interaction_at, src.first_interaction_at),
        last_interaction_at = GREATEST(c.last_interaction_at, src.last_interaction_at),
        manual_overrides = COALESCE(c.manual_overrides, '{}'::jsonb) || COALESCE(src.manual_overrides, '{}'::jsonb),
        updated_at = NOW()
      FROM (
        SELECT ARRAY_AGG(DISTINCT e) FILTER (WHERE e IS NOT NULL) AS emails,
               ARRAY_AGG(DISTINCT p) FILTER (WHERE p IS NOT NULL) AS phone_numbers,
               ARRAY_AGG(DISTINCT w) FILTER (WHERE w IS NOT NULL) AS wa_jids,
               ARRAY_AGG(DISTINCT t) FILTER (WHERE t IS NOT NULL) AS tags,
               MIN(first_interaction_at) AS first_interaction_at,
               MAX(last_interaction_at) AS last_interaction_at,
               jsonb_object_agg(k, v) FILTER (WHERE k IS NOT NULL) AS manual_overrides
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
      try { await run(sql) } catch (err) {
        if (!/does not exist|relation .* does not exist|column .* does not exist/i.test(err.message)) throw err
      }
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
      ['intelligence.opportunities', 'primary_contact_id'],
      ['intelligence.contact_organizations', 'contact_id'],
      ['intelligence.opportunity_contacts', 'contact_id'],
    ]

    for (const [table, column] of updateTables) {
      try {
        await run(`UPDATE ${table} SET ${column} = $1::bigint WHERE ${column}::text = ANY($2::text[])`)
      } catch (err) {
        if (!/does not exist|relation .* does not exist|column .* does not exist/i.test(err.message)) throw err
      }
    }

    try {
      await run(`
        UPDATE relationships.insights
        SET contact_ids = ARRAY(
          SELECT DISTINCT CASE WHEN x::text = ANY($2::text[]) THEN $1::bigint ELSE x END
          FROM unnest(contact_ids) x
        )
        WHERE contact_ids && (SELECT ARRAY_AGG(x::bigint) FROM unnest($2::text[]) x)
      `)
    } catch (err) {
      if (!/does not exist|column .* does not exist/i.test(err.message)) throw err
    }

    try {
      await run(`
        UPDATE intelligence.entity_aliases
        SET entity_id = $1
        WHERE entity_type = 'contact' AND entity_id = ANY($2::text[])
      `)
    } catch (err) {
      if (!/does not exist|relation .* does not exist/i.test(err.message)) throw err
    }

    try {
      await run(`
        UPDATE intelligence.object_topics
        SET object_id = $1
        WHERE object_type = 'contact' AND object_id = ANY($2::text[])
      `)
    } catch (err) {
      if (!/does not exist|relation .* does not exist/i.test(err.message)) throw err
    }

    await run(`UPDATE relationships.contact_identities SET contact_id = $1::bigint, updated_at = NOW() WHERE contact_id::text = ANY($2::text[])`)

    // Remove duplicate comm rows created by previous polluted contact IDs, keeping the canonical/oldest row.
    await pool.query(`
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

    if (options.recordDecision !== false) {
      const key = options.duplicate_key || `exact_identity:${canonical}:${duplicates.join(',')}`
      await pool.query(`
        INSERT INTO intelligence.duplicate_decisions (entity_type, duplicate_key, action, canonical_id, duplicate_ids, decided_by, note)
        VALUES ('contact', $1, 'confirmed', $2, $3::text[], $4, $5)
        ON CONFLICT (entity_type, duplicate_key) DO UPDATE SET
          action = EXCLUDED.action,
          canonical_id = EXCLUDED.canonical_id,
          duplicate_ids = EXCLUDED.duplicate_ids,
          decided_by = EXCLUDED.decided_by,
          note = EXCLUDED.note,
          decided_at = NOW()
      `, [key, canonical, [canonical, ...duplicates], options.decided_by || 'system', options.note || 'Exact source identity merge'])
    }

    await pool.query('COMMIT')
    return { canonical_id: canonical, duplicate_ids: duplicates, merged: duplicates.length }
  } catch (err) {
    await pool.query('ROLLBACK')
    throw err
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
