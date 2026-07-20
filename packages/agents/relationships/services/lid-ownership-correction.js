'use strict'

const crypto = require('crypto')

const CORRECTION_VERSION = '2026-07-20-lid-ownership-v1'
// This boundary makes the destructive interpretation deliberately finite: a
// future system/manual merge cannot accidentally be reclassified as legacy
// name matching merely because it retained old display-name metadata.
const LEGACY_PROVENANCE_CUTOFF = '2026-07-20T06:35:00.000Z'

function cleanDisplayName(value, jid) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  if (!name || name === jid || /^\d{6,20}(?:@lid)?$/.test(name)) return null
  return name
}

function syntheticLidName(jid) {
  const suffix = crypto.createHash('sha256').update(jid).digest('hex').slice(0, 8)
  return `WhatsApp participant ${suffix}`
}

function emptyStats() {
  return {
    version: CORRECTION_VERSION,
    split_candidates: 0,
    legacy_name_only_lids_split: 0,
    provisional_extra_lids_split: 0,
    provider_profiles_created: 0,
    nameless_lid_profiles_created: 0,
    identities_moved: 0,
    exact_owners_reconciled: 0,
    communications_audited: 0,
    communications_reassigned: 0,
    null_links_reassigned: 0,
    stale_links_reassigned: 0,
    profiles_recency_enriched: 0,
  }
}

async function loadSplitCandidates(client, cutoff) {
  const { rows } = await client.query(`
    /* lid-ownership:load-split-candidates */
    WITH provisional_lids AS (
      SELECT identity.id AS identity_id,
             identity.contact_id AS previous_contact_id,
             identity.identity_value AS jid,
             identity.metadata->>'display_name' AS provider_display_name,
             identity.created_at,
             ROW_NUMBER() OVER (
               PARTITION BY identity.contact_id
               ORDER BY identity.created_at ASC, identity.id ASC
             ) AS owner_ordinal
      FROM relationships.contact_identities identity
      JOIN relationships.contacts contact ON contact.id = identity.contact_id
      WHERE identity.source = 'whatsapp'
        AND identity.identity_type = 'wa_jid'
        AND identity.identity_value ~ '^[1-9][0-9]{6,20}@lid$'
        AND identity.is_active = TRUE
        AND identity.verified_by = 'system'
        AND identity.confidence = 1
        AND identity.metadata->>'source' = 'chat_metadata'
        AND identity.metadata->>'privacy_preserving_lid' = 'true'
        AND contact.raw_data->>'source' = 'whatsapp_lid'
        AND contact.raw_data->>'provisional_identity' = 'true'
        AND contact.raw_data->>'reason' = 'unmatched_exact_name'
    ), legacy_name_only AS (
      SELECT identity.id AS identity_id,
             identity.contact_id AS previous_contact_id,
             identity.identity_value AS jid,
             identity.metadata->>'display_name' AS provider_display_name,
             'legacy_name_only'::text AS correction_kind
      FROM relationships.contact_identities identity
      JOIN relationships.contacts contact ON contact.id = identity.contact_id
      LEFT JOIN relationships.contact_merge_redirects redirect
        ON redirect.from_contact_id = contact.id
      WHERE identity.source = 'whatsapp'
        AND identity.identity_type = 'wa_jid'
        AND identity.identity_value ~ '^[1-9][0-9]{6,20}@lid$'
        AND identity.is_active = TRUE
        AND identity.verified_by = 'system'
        AND identity.confidence = 1
        AND identity.metadata->>'source' = 'chat_metadata'
        AND identity.metadata->>'privacy_preserving_lid' = 'true'
        AND NULLIF(identity.metadata->>'display_name', '') IS NOT NULL
        AND LOWER(REGEXP_REPLACE(BTRIM(identity.metadata->>'display_name'), '[[:space:]]+', ' ', 'g')) =
            COALESCE(contact.normalized_name,
              LOWER(REGEXP_REPLACE(BTRIM(contact.display_name), '[[:space:]]+', ' ', 'g')))
        AND identity.updated_at < $1::timestamptz
        AND contact.raw_data->>'source' IS DISTINCT FROM 'whatsapp_lid'
        AND contact.is_noise IS DISTINCT FROM TRUE
        AND redirect.from_contact_id IS NULL
        AND COALESCE(identity.metadata->>'person_level_corroboration', 'false') <> 'true'
        AND NOT (COALESCE(identity.metadata, '{}'::jsonb) ? 'corroborated_by')
        AND NOT (COALESCE(identity.metadata, '{}'::jsonb) ? 'corrected_name_only_link')
        AND identity.metadata->>'correction_version' IS DISTINCT FROM $2
    )
    SELECT identity_id, previous_contact_id, jid, provider_display_name, correction_kind
    FROM legacy_name_only
    UNION ALL
    SELECT identity_id, previous_contact_id, jid, provider_display_name,
           'provisional_extra_lid'::text AS correction_kind
    FROM provisional_lids
    WHERE owner_ordinal > 1
    ORDER BY previous_contact_id, identity_id
  `, [cutoff, CORRECTION_VERSION])
  return rows || []
}

async function createProviderProfile(client, { jid, displayName, reason, previousContactId = null }) {
  const providerDisplayName = cleanDisplayName(displayName, jid)
  const name = providerDisplayName || syntheticLidName(jid)
  const rawData = {
    source: 'whatsapp_lid',
    provisional_identity: true,
    reason,
    display_name_is_synthetic: !providerDisplayName,
    lid_ownership_correction_version: CORRECTION_VERSION,
    lid_jid: jid,
  }
  if (previousContactId != null) {
    rawData.previous_contact_id = String(previousContactId)
    rawData.repaired_from_name_only_link = true
  }
  const { rows } = await client.query(`
    /* lid-ownership:create-provider-profile */
    INSERT INTO relationships.contacts (
      display_name, normalized_name, wa_jids, relationship_type,
      relationship_strength, raw_data
    ) VALUES ($1, $2, ARRAY[$3]::text[], 'unknown', 'weak', $4::jsonb)
    RETURNING id
  `, [name, name.toLowerCase().replace(/\s+/g, ' ').trim(), jid, JSON.stringify(rawData)])
  if (!rows?.[0]?.id) throw new Error(`failed to create provider-scoped profile for ${jid}`)
  return { contactId: rows[0].id, providerDisplayName, synthetic: !providerDisplayName }
}

async function splitIdentity(client, candidate, correctedAt) {
  const profile = await createProviderProfile(client, {
    jid: candidate.jid,
    displayName: candidate.provider_display_name,
    reason: 'provider_identity_without_person_level_corroboration',
    previousContactId: candidate.previous_contact_id,
  })
  const { rows } = await client.query(`
    /* lid-ownership:move-split-identity */
    UPDATE relationships.contact_identities identity
    SET contact_id = $2::bigint,
        metadata = COALESCE(identity.metadata, '{}'::jsonb) || jsonb_build_object(
          'corrected_name_only_link', TRUE,
          'previous_contact_id', $3::bigint,
          'correction_reason', 'split unsupported name-only LID ownership',
          'correction_kind', $4::text,
          'correction_version', $5::text,
          'corrected_at', COALESCE(NULLIF(identity.metadata->>'corrected_at', ''), $6::text)
        ),
        updated_at = NOW()
    WHERE identity.id = $1::bigint
      AND identity.contact_id = $3::bigint
      AND identity.is_active = TRUE
    RETURNING identity.id
  `, [
    candidate.identity_id,
    profile.contactId,
    candidate.previous_contact_id,
    candidate.correction_kind,
    CORRECTION_VERSION,
    correctedAt,
  ])
  if (!rows?.length) throw new Error(`LID ownership changed concurrently for ${candidate.jid}`)

  await client.query(`
    /* lid-ownership:remove-previous-contact-array-alias */
    UPDATE relationships.contacts
    SET wa_jids = ARRAY_REMOVE(COALESCE(wa_jids, ARRAY[]::text[]), $2),
        updated_at = NOW()
    WHERE id = $1::bigint
  `, [candidate.previous_contact_id, candidate.jid])
  return profile
}

async function loadMissingCanonicalLids(client) {
  const { rows } = await client.query(`
    /* lid-ownership:load-missing-canonical-lids */
    WITH participant_lids AS (
      SELECT communication.chat_id AS jid, NULL::text AS provider_display_name
      FROM relationships.communications communication
      WHERE communication.source = 'whatsapp'
        AND communication.is_group = FALSE
        AND communication.chat_id ~ '^[1-9][0-9]{6,20}@lid$'
      UNION ALL
      SELECT communication.metadata->>'author_jid' AS jid,
             NULLIF(communication.metadata->>'author_name', '') AS provider_display_name
      FROM relationships.communications communication
      WHERE communication.source = 'whatsapp'
        AND communication.is_group = TRUE
        AND communication.metadata->>'author_jid' ~ '^[1-9][0-9]{6,20}@lid$'
    )
    SELECT participant.jid,
           MAX(participant.provider_display_name) AS provider_display_name
    FROM participant_lids participant
    LEFT JOIN relationships.contact_identities identity
      ON identity.source = 'whatsapp'
     AND identity.identity_type = 'wa_jid'
     AND identity.identity_value = participant.jid
     AND identity.is_active = TRUE
    WHERE identity.id IS NULL
    GROUP BY participant.jid
    ORDER BY participant.jid
  `)
  return rows || []
}

async function createMissingIdentityProfiles(client, candidates) {
  if (!candidates.length) return []
  const input = candidates.map(candidate => {
    const providerDisplayName = cleanDisplayName(candidate.provider_display_name, candidate.jid)
    const name = providerDisplayName || syntheticLidName(candidate.jid)
    return {
      jid: candidate.jid,
      display_name: name,
      normalized_name: name.toLowerCase().replace(/\s+/g, ' ').trim(),
      synthetic: !providerDisplayName,
      raw_data: {
        source: 'whatsapp_lid',
        provisional_identity: true,
        reason: 'provider_identity_without_person_level_corroboration',
        display_name_is_synthetic: !providerDisplayName,
        lid_ownership_correction_version: CORRECTION_VERSION,
        lid_jid: candidate.jid,
      },
      identity_metadata: {
        source: providerDisplayName ? 'chat_metadata' : 'stable_provider_identity',
        display_name: providerDisplayName,
        privacy_preserving_lid: true,
        ownership_version: CORRECTION_VERSION,
      },
    }
  })
  const { rows } = await client.query(`
    /* lid-ownership:create-missing-identity-profiles */
    WITH candidate AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS value(
        jid text, display_name text, normalized_name text, synthetic boolean,
        raw_data jsonb, identity_metadata jsonb
      )
    ), created AS (
      INSERT INTO relationships.contacts (
        display_name, normalized_name, wa_jids, relationship_type,
        relationship_strength, raw_data
      )
      SELECT display_name, normalized_name, ARRAY[jid]::text[],
             'unknown', 'weak', raw_data
      FROM candidate
      RETURNING id, raw_data->>'lid_jid' AS jid
    ), inserted_identity AS (
      INSERT INTO relationships.contact_identities (
        contact_id, source, identity_type, identity_value,
        confidence, verified_by, metadata
      )
      SELECT created.id, 'whatsapp', 'wa_jid', created.jid,
             1, 'system', candidate.identity_metadata
      FROM created
      JOIN candidate ON candidate.jid = created.jid
      ON CONFLICT (source, identity_type, identity_value) WHERE is_active
      DO NOTHING
      RETURNING contact_id
    )
    SELECT created.id AS contact_id, candidate.synthetic,
           inserted_identity.contact_id IS NOT NULL AS identity_created
    FROM created
    JOIN candidate ON candidate.jid = created.jid
    LEFT JOIN inserted_identity ON inserted_identity.contact_id = created.id
  `, [JSON.stringify(input)])
  const racedIds = (rows || []).filter(row => !row.identity_created).map(row => row.contact_id)
  if (racedIds.length) {
    // A live importer can win the exact-identity race. Remove only profiles
    // created by this transaction; immutable source evidence is never touched.
    await client.query(`
      /* lid-ownership:discard-raced-profiles */
      DELETE FROM relationships.contacts contact
      WHERE contact.id = ANY($1::bigint[])
        AND NOT EXISTS (
          SELECT 1 FROM relationships.contact_identities identity
          WHERE identity.contact_id = contact.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM relationships.communications communication
          WHERE communication.contact_id = contact.id
        )
    `, [racedIds])
  }
  return (rows || []).filter(row => row.identity_created)
}

async function reconcileCanonicalOwners(client) {
  const affectedSql = `
    WITH exact_owner AS MATERIALIZED (
      SELECT identity.identity_value AS jid, identity.contact_id
      FROM relationships.contact_identities identity
      WHERE identity.source = 'whatsapp'
        AND identity.identity_type = 'wa_jid'
        AND identity.identity_value ~ '^[1-9][0-9]{6,20}@lid$'
        AND identity.is_active = TRUE
    )
    SELECT communication.id, communication.source, communication.source_id,
           communication.contact_id AS previous_contact_id,
           exact_owner.contact_id AS resolved_contact_id,
           exact_owner.jid
    FROM exact_owner
    JOIN relationships.communications communication
      ON communication.source = 'whatsapp'
     AND communication.is_group = FALSE
     AND communication.chat_id = exact_owner.jid
     AND communication.contact_id IS DISTINCT FROM exact_owner.contact_id
    UNION ALL
    SELECT communication.id, communication.source, communication.source_id,
           communication.contact_id AS previous_contact_id,
           exact_owner.contact_id AS resolved_contact_id,
           exact_owner.jid
    FROM exact_owner
    JOIN relationships.communications communication
      ON communication.source = 'whatsapp'
     AND communication.is_group = TRUE
     AND communication.metadata->>'author_jid' = exact_owner.jid
     AND communication.contact_id IS DISTINCT FROM exact_owner.contact_id
  `
  const audit = await client.query(`
    /* lid-ownership:audit-exact-canonical-owners */
    WITH affected AS MATERIALIZED (${affectedSql})
    INSERT INTO relationships.communication_identity_conflicts (
      source, source_id, previous_contact_id, resolved_contact_id, metadata
    )
    SELECT affected.source, affected.source_id, affected.previous_contact_id,
           affected.resolved_contact_id,
           jsonb_build_object(
             'resolution', 'reconciled exact LID participant owner',
             'correction_version', $1::text,
             'lid_jid', affected.jid,
             'previous_contact_was_null', affected.previous_contact_id IS NULL
           )
    FROM affected
    WHERE NOT EXISTS (
      SELECT 1
      FROM relationships.communication_identity_conflicts existing
      WHERE existing.source = affected.source
        AND existing.source_id = affected.source_id
        AND existing.previous_contact_id IS NOT DISTINCT FROM affected.previous_contact_id
        AND existing.resolved_contact_id = affected.resolved_contact_id
        AND existing.metadata->>'correction_version' = $1::text
    )
    ON CONFLICT (source, source_id, previous_contact_id, resolved_contact_id)
    DO UPDATE SET
      metadata = relationships.communication_identity_conflicts.metadata || EXCLUDED.metadata,
      last_seen_at = NOW()
    WHERE relationships.communication_identity_conflicts.metadata->>'correction_version'
          IS DISTINCT FROM EXCLUDED.metadata->>'correction_version'
    RETURNING previous_contact_id, metadata->>'lid_jid' AS jid
  `, [CORRECTION_VERSION])

  const updated = await client.query(`
    /* lid-ownership:reassign-exact-canonical-owners */
    WITH affected AS MATERIALIZED (${affectedSql})
    UPDATE relationships.communications communication
    SET contact_id = affected.resolved_contact_id
    FROM affected
    WHERE communication.id = affected.id
    RETURNING affected.previous_contact_id, affected.jid
  `)
  const previous = updated.rows || []
  return {
    audited: Number(audit.rowCount ?? audit.rows?.length ?? 0),
    reassigned: Number(updated.rowCount ?? previous.length ?? 0),
    nullLinks: previous.filter(row => row.previous_contact_id == null).length,
    staleLinks: previous.filter(row => row.previous_contact_id != null).length,
    owners: new Set(previous.map(row => row.jid).filter(Boolean)).size,
  }
}

async function enrichProfileRecency(client, contactIds) {
  if (!contactIds.length) return 0
  const { rowCount = 0 } = await client.query(`
    /* lid-ownership:enrich-profile-recency */
    WITH bounds AS (
      SELECT communication.contact_id,
             MIN(communication.occurred_at) AS first_at,
             MAX(communication.occurred_at) AS last_at
      FROM relationships.communications communication
      WHERE communication.contact_id = ANY($1::bigint[])
      GROUP BY communication.contact_id
    )
    UPDATE relationships.contacts contact
    SET first_interaction_at = CASE
          WHEN contact.first_interaction_at IS NULL THEN bounds.first_at
          ELSE LEAST(contact.first_interaction_at, bounds.first_at)
        END,
        last_interaction_at = CASE
          WHEN contact.last_interaction_at IS NULL THEN bounds.last_at
          ELSE GREATEST(contact.last_interaction_at, bounds.last_at)
        END,
        updated_at = NOW()
    FROM bounds
    WHERE contact.id = bounds.contact_id
  `, [contactIds])
  return Number(rowCount || 0)
}

async function runLidOwnershipCorrection(pool, options = {}) {
  const ownsConnection = typeof pool.connect === 'function' && typeof pool.release !== 'function'
  const client = ownsConnection ? await pool.connect() : pool
  const shouldRelease = client !== pool && typeof client.release === 'function'
  const stats = emptyStats()
  const correctedAt = options.correctedAt || new Date().toISOString()
  const cutoff = options.legacyProvenanceCutoff || LEGACY_PROVENANCE_CUTOFF
  const createdContactIds = []

  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('relationships.lid_ownership_correction'))`)

    const candidates = await loadSplitCandidates(client, cutoff)
    stats.split_candidates = candidates.length
    for (const candidate of candidates) {
      const profile = await splitIdentity(client, candidate, correctedAt)
      createdContactIds.push(profile.contactId)
      stats.provider_profiles_created++
      stats.identities_moved++
      if (profile.synthetic) stats.nameless_lid_profiles_created++
      if (candidate.correction_kind === 'legacy_name_only') stats.legacy_name_only_lids_split++
      if (candidate.correction_kind === 'provisional_extra_lid') stats.provisional_extra_lids_split++
    }

    const missing = await loadMissingCanonicalLids(client)
    const missingProfiles = await createMissingIdentityProfiles(client, missing)
    createdContactIds.push(...missingProfiles.map(profile => profile.contact_id))
    stats.provider_profiles_created += missingProfiles.length
    stats.nameless_lid_profiles_created += missingProfiles.filter(profile => profile.synthetic).length

    const reconciled = await reconcileCanonicalOwners(client)
    stats.exact_owners_reconciled = reconciled.owners
    stats.communications_audited = reconciled.audited
    stats.communications_reassigned = reconciled.reassigned
    stats.null_links_reassigned = reconciled.nullLinks
    stats.stale_links_reassigned = reconciled.staleLinks
    stats.profiles_recency_enriched = await enrichProfileRecency(client, [...new Set(createdContactIds)])

    await client.query('COMMIT')
    return stats
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (shouldRelease) client.release()
  }
}

module.exports = {
  CORRECTION_VERSION,
  LEGACY_PROVENANCE_CUTOFF,
  cleanDisplayName,
  syntheticLidName,
  runLidOwnershipCorrection,
}
