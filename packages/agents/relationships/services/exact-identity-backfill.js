'use strict'

const identity = require('./identity')

function chooseCanonicalContact(rows = []) {
  const sorted = rows.filter(row => row && row.is_noise !== true && row.is_noise !== 'true').sort((a, b) => {
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

/**
 * Resolve every requested contact through the current merge redirect graph.
 * Exact identity groups are discovered as one snapshot, so later groups in the
 * same batch may contain IDs merged by earlier groups. Cycles, missing targets,
 * and terminal noise rows are quarantined instead of becoming canonicals.
 */
async function resolveCurrentContactIds(pool, contactIds = []) {
  const requestedIds = [...new Set(contactIds.map(String).filter(Boolean))]
  if (!requestedIds.length) {
    return { current_ids: [], resolutions: [], stale_contact_ids: [], unresolved_ids: [], cycles: [] }
  }
  const { rows } = await pool.query(`
    WITH RECURSIVE requested(original_id) AS (
      SELECT DISTINCT value
      FROM unnest($1::text[]) value
    ), lineage(original_id, current_id, path, cycle) AS (
      SELECT original_id, original_id, ARRAY[original_id]::text[], FALSE
      FROM requested
      UNION ALL
      SELECT lineage.original_id,
             redirect.to_contact_id::text,
             lineage.path || redirect.to_contact_id::text,
             redirect.to_contact_id::text = ANY(lineage.path)
      FROM lineage
      JOIN relationships.contact_merge_redirects redirect
        ON redirect.from_contact_id::text = lineage.current_id
      WHERE lineage.cycle = FALSE
    ), terminal AS (
      SELECT DISTINCT ON (original_id)
             original_id, current_id, path, cycle
      FROM lineage
      ORDER BY original_id, cardinality(path) DESC
    )
    SELECT terminal.original_id,
           terminal.current_id,
           terminal.cycle,
           (contact.id IS NOT NULL) AS contact_exists,
           contact.is_noise,
           EXISTS (
             SELECT 1 FROM relationships.contact_merge_redirects redirect
             WHERE redirect.from_contact_id::text = terminal.current_id
           ) AS has_redirect
    FROM terminal
    LEFT JOIN relationships.contacts contact ON contact.id::text = terminal.current_id
    ORDER BY terminal.original_id
  `, [requestedIds])

  const resolutions = rows.map(row => ({
    original_id: String(row.original_id),
    current_id: String(row.current_id),
    cycle: row.cycle === true,
    contact_exists: row.contact_exists === true,
    is_noise: row.is_noise === true,
    has_redirect: row.has_redirect === true,
  }))
  const usable = resolutions.filter(row =>
    !row.cycle && row.contact_exists && !row.is_noise && !row.has_redirect
  )
  const unresolved = resolutions.filter(row =>
    row.cycle || !row.contact_exists || row.is_noise || row.has_redirect
  )
  return {
    current_ids: [...new Set(usable.map(row => row.current_id))],
    resolutions,
    stale_contact_ids: resolutions
      .filter(row => row.original_id !== row.current_id)
      .map(row => row.original_id),
    unresolved_ids: unresolved.map(row => row.original_id),
    cycles: resolutions.filter(row => row.cycle).map(row => row.original_id),
  }
}

function contradictoryStableIdentities(rows = [], sharedIdentity = {}) {
  const fields = {
    email: row => row.emails || [],
    phone: row => row.phone_numbers || [],
    wa_jid: row => row.wa_jids || [],
  }
  // apple_contact_id identifies an imported address-book card, not a person.
  // One person may legitimately have multiple Apple cards; preserve all card
  // IDs as source identities, but never treat their difference as person-level
  // counter-evidence to an exact phone/WhatsApp/email match.
  const contradictions = []
  for (const [identityType, valuesFor] of Object.entries(fields)) {
    if (identityType === sharedIdentity.identity_type) continue
    const populated = rows
      .map(row => new Set(valuesFor(row)
        .map(value => identity.normalizeIdentityValue(identityType, value))
        .filter(Boolean)))
      .filter(values => values.size > 0)
    if (populated.length < 2) continue
    const intersection = [...populated[0]].filter(value => populated.every(values => values.has(value)))
    if (intersection.length === 0) contradictions.push(identityType)
  }
  return contradictions
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
        AND LOWER(TRIM(w)) ~ '^[1-9][0-9]{6,14}@c\\.us$'

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
        AND REGEXP_REPLACE(TRIM(p), '[^0-9]', '', 'g') ~ '^[1-9][0-9]{6,14}$'
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
           apple_contact_id, manual_overrides, is_noise
    FROM relationships.contacts contact
    WHERE id::text = ANY($1::text[])
      AND is_noise IS DISTINCT FROM TRUE
      AND NOT EXISTS (
        SELECT 1 FROM relationships.contact_merge_redirects redirect
        WHERE redirect.from_contact_id = contact.id
      )
  `, [contactIds.map(String)])
  return rows
}

async function populateContactIdentities(pool, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 1000), 1), 10000)
  const afterId = Math.max(Number(options.afterId || 0), 0)
  await identity.ensureIdentitySchema(pool)
  const { rows } = await pool.query(`
    SELECT id, emails, phone_numbers, wa_jids, apple_contact_id
    FROM relationships.contacts contact
    WHERE contact.is_noise IS DISTINCT FROM TRUE
      AND NOT EXISTS (
        SELECT 1 FROM relationships.contact_merge_redirects redirect
        WHERE redirect.from_contact_id = contact.id
      )
      AND id > $1
    ORDER BY id ASC
    LIMIT $2
  `, [afterId, limit])
  let inserted = 0
  let conflicts = 0
  for (const row of rows) {
    for (const ident of identity.identitiesForContactLike(row)) {
      const result = await identity.upsertContactIdentity(pool, row.id, ident)
      if (result?.conflict) conflicts++
      else if (result) inserted++
    }
  }
  const nextAfterId = rows.length ? String(rows[rows.length - 1].id) : String(afterId)
  return {
    scanned_contacts: rows.length,
    identities_upserted: inserted,
    identity_conflicts: conflicts,
    next_after_id: nextAfterId,
    has_more: rows.length === limit,
  }
}

async function runExactIdentityMerge(pool, options = {}) {
  const write = options.write === true
  const limit = Math.min(Math.max(Number(options.limit || 50), 1), 500)
  await identity.ensureIdentitySchema(pool)

  const groups = await findExactIdentityDuplicateGroups(pool, { limit })
  const results = []
  const mergeContactRecords = options.mergeContactRecords || identity.mergeContactRecords
  const upsertContactIdentity = options.upsertContactIdentity || identity.upsertContactIdentity
  for (const group of groups) {
    // Re-resolve on every iteration because prior overlapping groups in this
    // same batch may already have redirected one or more snapshot IDs.
    const resolution = await resolveCurrentContactIds(pool, group.contact_ids)
    const contacts = await hydrateContacts(pool, resolution.current_ids)
    const canonicalId = chooseCanonicalContact(contacts)
    const duplicateIds = resolution.current_ids.map(String).filter(id => id !== canonicalId)
    const contradictions = contradictoryStableIdentities(contacts, group)
    const alreadyConverged = resolution.unresolved_ids.length === 0 && resolution.current_ids.length <= 1
    const reviewReasons = []
    if (resolution.cycles.length) reviewReasons.push('redirect_cycle')
    if (resolution.unresolved_ids.length) reviewReasons.push('unresolved_or_inactive_contact')
    if (contradictions.length) reviewReasons.push('contradictory_stable_identities')
    if (!canonicalId && !alreadyConverged) reviewReasons.push('no_active_canonical')
    const mergeEligible = !alreadyConverged && reviewReasons.length === 0 && duplicateIds.length > 0
    const record = {
      source: group.source,
      identity_type: group.identity_type,
      identity_value: group.identity_value,
      contact_ids: group.contact_ids,
      current_contact_ids: resolution.current_ids,
      identity_resolutions: resolution.resolutions,
      stale_contact_ids: resolution.stale_contact_ids,
      unresolved_contact_ids: resolution.unresolved_ids,
      canonical_id: canonicalId,
      duplicate_ids: duplicateIds,
      contacts,
      contradictions,
      already_converged: alreadyConverged,
      review_reasons: reviewReasons,
      merge_eligible: mergeEligible,
    }
    if (write && canonicalId && duplicateIds.length && record.merge_eligible) {
      record.preserved_apple_contact_ids = []
      // Register every source card before the merge. mergeContactRecords then
      // moves these identity rows to the canonical person, preserving multiple
      // Apple cards without forcing a lossy scalar apple_contact_id choice.
      const canonicalFirst = [...contacts].sort(contact => String(contact.id) === canonicalId ? -1 : 1)
      for (const contact of canonicalFirst) {
        if (!contact.apple_contact_id) continue
        const preserved = await upsertContactIdentity(pool, contact.id, {
          source: 'apple_contacts',
          identity_type: 'apple_contact_id',
          identity_value: contact.apple_contact_id,
          confidence: 1,
          metadata: { preserved_during_exact_merge: true },
        })
        if (preserved) record.preserved_apple_contact_ids.push(contact.apple_contact_id)
      }
      const merge = await mergeContactRecords(pool, canonicalId, duplicateIds, {
        duplicate_key: `exact_identity:${group.source}:${group.identity_type}:${group.identity_value}`,
        decided_by: options.decided_by || 'identity-backfill',
        note: `Exact ${group.source}/${group.identity_type} identity match: ${group.identity_value}`,
      })
      record.merge = merge
    }
    results.push(record)
  }

  const identityPopulation = write ? await populateContactIdentities(pool, {
    limit: options.identityLimit || 10000,
    afterId: options.identityAfterId || 0,
  }) : null
  return {
    mode: write ? 'write' : 'dry-run',
    duplicate_groups: results.length,
    merged_groups: results.filter(r => r.merge?.merged).length,
    already_converged_groups: results.filter(r => r.already_converged).length,
    review_groups: results.filter(r => r.review_reasons.length > 0).length,
    identity_population: identityPopulation,
    groups: results,
  }
}

module.exports = {
  chooseCanonicalContact,
  contradictoryStableIdentities,
  findExactIdentityDuplicateGroups,
  resolveCurrentContactIds,
  hydrateContacts,
  populateContactIdentities,
  runExactIdentityMerge,
}
