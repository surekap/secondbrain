'use strict'

const identity = require('./identity')

function chooseCanonicalContact(rows = []) {
  const sorted = [...rows].sort((a, b) => {
    const scoreA = Number(a.strategic_importance_score || 0)
    const scoreB = Number(b.strategic_importance_score || 0)
    if (scoreB !== scoreA) return scoreB - scoreA
    const touchA = a.next_suggested_touch_at ? 1 : 0
    const touchB = b.next_suggested_touch_at ? 1 : 0
    if (touchB !== touchA) return touchB - touchA
    const lastA = a.last_interaction_at ? new Date(a.last_interaction_at).getTime() : 0
    const lastB = b.last_interaction_at ? new Date(b.last_interaction_at).getTime() : 0
    if (lastB !== lastA) return lastB - lastA
    return Number(a.id || 0) - Number(b.id || 0)
  })
  return sorted[0]?.id ? String(sorted[0].id) : null
}

async function findExactIdentityDuplicateGroups(pool, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 500)
  const { rows } = await pool.query(`
    WITH identity_values AS (
      SELECT c.id::text AS contact_id,
             c.display_name,
             'whatsapp'::text AS source,
             'wa_jid'::text AS identity_type,
             LOWER(TRIM(w)) AS identity_value
      FROM relationships.contacts c
      CROSS JOIN LATERAL unnest(COALESCE(c.wa_jids, '{}')) w
      WHERE c.is_noise IS DISTINCT FROM TRUE
        AND w IS NOT NULL AND TRIM(w) <> ''

      UNION ALL
      SELECT c.id::text AS contact_id,
             c.display_name,
             'email'::text AS source,
             'email'::text AS identity_type,
             LOWER(TRIM(e)) AS identity_value
      FROM relationships.contacts c
      CROSS JOIN LATERAL unnest(COALESCE(c.emails, '{}')) e
      WHERE c.is_noise IS DISTINCT FROM TRUE
        AND e IS NOT NULL AND TRIM(e) <> ''

      UNION ALL
      SELECT c.id::text AS contact_id,
             c.display_name,
             'phone'::text AS source,
             'phone'::text AS identity_type,
             REGEXP_REPLACE(TRIM(p), '[^0-9]', '', 'g') AS identity_value
      FROM relationships.contacts c
      CROSS JOIN LATERAL unnest(COALESCE(c.phone_numbers, '{}')) p
      WHERE c.is_noise IS DISTINCT FROM TRUE
        AND p IS NOT NULL AND TRIM(p) <> ''
    ), grouped AS (
      SELECT source,
             identity_type,
             identity_value,
             ARRAY_AGG(DISTINCT contact_id ORDER BY contact_id) AS contact_ids,
             COUNT(DISTINCT contact_id)::int AS contact_count
      FROM identity_values
      WHERE identity_value IS NOT NULL AND identity_value <> ''
      GROUP BY source, identity_type, identity_value
      HAVING COUNT(DISTINCT contact_id) > 1
    )
    SELECT source, identity_type, identity_value, contact_ids, contact_count
    FROM grouped
    ORDER BY CASE source WHEN 'whatsapp' THEN 0 WHEN 'email' THEN 1 ELSE 2 END,
             contact_count DESC,
             identity_value ASC
    LIMIT $1
  `, [limit])
  return rows
}

async function hydrateContacts(pool, contactIds = []) {
  if (!contactIds.length) return []
  const { rows } = await pool.query(`
    SELECT id, display_name, company, relationship_tier, strategic_importance_score,
           next_suggested_touch_at, last_interaction_at, emails, phone_numbers, wa_jids,
           manual_overrides
    FROM relationships.contacts
    WHERE id::text = ANY($1::text[])
  `, [contactIds.map(String)])
  return rows
}

async function populateContactIdentities(pool, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 1000), 1), 10000)
  await identity.ensureIdentitySchema(pool)
  const { rows } = await pool.query(`
    SELECT id, emails, phone_numbers, wa_jids, apple_contact_id
    FROM relationships.contacts
    WHERE is_noise IS DISTINCT FROM TRUE
       OR cardinality(COALESCE(emails, '{}')) > 0
       OR cardinality(COALESCE(phone_numbers, '{}')) > 0
       OR cardinality(COALESCE(wa_jids, '{}')) > 0
    ORDER BY id ASC
    LIMIT $1
  `, [limit])
  let inserted = 0
  let skipped = 0
  for (const row of rows) {
    for (const ident of identity.identitiesForContactLike(row)) {
      try {
        await identity.upsertContactIdentity(pool, row.id, ident)
        inserted++
      } catch (err) {
        // If the unique identity is already held by another active contact, leave it for merge audit.
        skipped++
      }
    }
  }
  return { scanned_contacts: rows.length, identities_upserted: inserted, identities_skipped: skipped }
}

async function runExactIdentityMerge(pool, options = {}) {
  const write = options.write === true
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 500)
  await identity.ensureIdentitySchema(pool)

  const groups = await findExactIdentityDuplicateGroups(pool, { limit })
  const results = []
  for (const group of groups) {
    const contacts = await hydrateContacts(pool, group.contact_ids)
    const canonicalId = chooseCanonicalContact(contacts)
    const duplicateIds = group.contact_ids.map(String).filter(id => id !== canonicalId)
    const record = {
      source: group.source,
      identity_type: group.identity_type,
      identity_value: group.identity_value,
      contact_ids: group.contact_ids,
      canonical_id: canonicalId,
      duplicate_ids: duplicateIds,
      contacts,
    }
    if (write && canonicalId && duplicateIds.length) {
      const merge = await identity.mergeContactRecords(pool, canonicalId, duplicateIds, {
        duplicate_key: `exact_identity:${group.source}:${group.identity_type}:${group.identity_value}`,
        decided_by: options.decided_by || 'identity-backfill',
        note: `Exact ${group.source}/${group.identity_type} identity match: ${group.identity_value}`,
      })
      record.merge = merge
    }
    results.push(record)
  }

  const identityPopulation = write ? await populateContactIdentities(pool, { limit: options.identityLimit || 10000 }) : null
  return {
    mode: write ? 'write' : 'dry-run',
    duplicate_groups: results.length,
    merged_groups: results.filter(r => r.merge?.merged).length,
    identity_population: identityPopulation,
    groups: results,
  }
}

module.exports = {
  chooseCanonicalContact,
  findExactIdentityDuplicateGroups,
  populateContactIdentities,
  runExactIdentityMerge,
}
