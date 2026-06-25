'use strict'

function capLimit(limit) {
  const n = Number(limit || 25)
  if (!Number.isFinite(n) || n < 1) return 25
  return Math.min(Math.floor(n), 100)
}

function normalizeNameKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?|prof\.?|shri|smt\.?|sri)\s+/i, '')
    .replace(/\b(pvt\.?\s*ltd\.?|private\s+limited|pvt\.?|private|limited|ltd\.?|llp|inc\.?|corp\.?|corporation|gmbh|llc|plc)\b/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function suggestedCanonical(entities = []) {
  const sorted = [...entities].sort((a, b) => {
    const scoreA = Number(a.strategic_importance_score || a.importance_score || 0)
    const scoreB = Number(b.strategic_importance_score || b.importance_score || 0)
    if (scoreB !== scoreA) return scoreB - scoreA
    const touchA = a.next_suggested_touch_at ? 1 : 0
    const touchB = b.next_suggested_touch_at ? 1 : 0
    if (touchB !== touchA) return touchB - touchA
    const lastA = a.last_interaction_at ? new Date(a.last_interaction_at).getTime() : 0
    const lastB = b.last_interaction_at ? new Date(b.last_interaction_at).getTime() : 0
    if (lastB !== lastA) return lastB - lastA
    return Number(a.id || 0) - Number(b.id || 0)
  })
  return sorted[0]?.id || null
}

async function auditDuplicateContacts(pool, options = {}) {
  const limit = capLimit(options.limit)
  const { rows } = await pool.query(`
    WITH keyed AS (
      SELECT c.id,
             c.display_name,
             c.company,
             c.job_title,
             c.relationship_type,
             c.relationship_strength,
             c.relationship_tier,
             c.strategic_importance_score,
             c.last_interaction_at,
             c.next_suggested_touch_at,
             c.manual_overrides,
             TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(COALESCE(c.display_name, '')),
               '^(dr\\.?|mr\\.?|mrs\\.?|ms\\.?|prof\\.?|shri|smt\\.?|sri)\\s+', ''),
               '[^a-z0-9]+', ' ', 'g'), '\\s+', ' ', 'g')) AS duplicate_key
      FROM relationships.contacts c
      WHERE c.display_name IS NOT NULL AND LENGTH(TRIM(c.display_name)) >= 3
    ),
    grouped AS (
      SELECT duplicate_key,
             COUNT(*)::int AS duplicate_count,
             COUNT(DISTINCT COALESCE(relationship_tier, 'unknown'))::int AS tier_variants,
             COUNT(*) FILTER (WHERE next_suggested_touch_at IS NOT NULL)::int AS obligation_count,
             (ARRAY_AGG(id ORDER BY strategic_importance_score DESC NULLS LAST,
                                  (next_suggested_touch_at IS NOT NULL) DESC,
                                  last_interaction_at DESC NULLS LAST,
                                  id ASC))[1]::text AS suggested_canonical_id,
             JSON_AGG(JSON_BUILD_OBJECT(
               'id', id,
               'display_name', display_name,
               'company', company,
               'job_title', job_title,
               'relationship_type', relationship_type,
               'relationship_strength', relationship_strength,
               'relationship_tier', relationship_tier,
               'strategic_importance_score', strategic_importance_score,
               'last_interaction_at', last_interaction_at,
               'next_suggested_touch_at', next_suggested_touch_at,
               'manual_override_fields', COALESCE((SELECT ARRAY_AGG(key) FROM JSONB_OBJECT_KEYS(COALESCE(manual_overrides, '{}'::jsonb)) AS key), '{}')
             ) ORDER BY strategic_importance_score DESC NULLS LAST, id ASC) AS entities
      FROM keyed
      WHERE LENGTH(duplicate_key) >= 5
      GROUP BY duplicate_key
      HAVING COUNT(*) > 1
    )
    SELECT duplicate_key,
           duplicate_count,
           suggested_canonical_id,
           CASE
             WHEN duplicate_count >= 3 THEN 0.95
             WHEN tier_variants > 1 OR obligation_count > 0 THEN 0.90
             ELSE 0.80
           END::numeric(4,2) AS confidence,
           tier_variants,
           obligation_count,
           entities,
           d.action AS decision_action,
           d.canonical_id AS decided_canonical_id,
           d.duplicate_ids AS decided_duplicate_ids,
           JSON_BUILD_OBJECT('decision_action', d.action, 'canonical_id', d.canonical_id, 'duplicate_ids', d.duplicate_ids, 'decided_at', d.decided_at) AS decision,
           d.decided_at
    FROM grouped
    LEFT JOIN intelligence.duplicate_decisions d
      ON d.entity_type = 'contact' AND d.duplicate_key = grouped.duplicate_key
    WHERE d.action IS DISTINCT FROM 'ignored'
    ORDER BY confidence DESC, duplicate_count DESC, obligation_count DESC, duplicate_key ASC
    LIMIT $1
  `, [limit])
  return rows
}

async function auditDuplicateOrganizations(pool, options = {}) {
  const limit = capLimit(options.limit)
  const { rows } = await pool.query(`
    WITH keyed AS (
      SELECT o.id,
             o.name,
             o.domain,
             o.sector,
             o.strategic_importance_score,
             TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(LOWER(COALESCE(o.name, '')),
               '\\b(pvt\\.?\\s*ltd\\.?|private\\s+limited|pvt\\.?|private|limited|ltd\\.?|llp|inc\\.?|corp\\.?|corporation|gmbh|llc|plc)\\b', '', 'g'),
               '[^a-z0-9]+', ' ', 'g'), '\\s+', ' ', 'g')) AS duplicate_key
      FROM intelligence.organizations o
      WHERE o.name IS NOT NULL AND LENGTH(TRIM(o.name)) >= 3
    ),
    grouped AS (
      SELECT duplicate_key,
             COUNT(*)::int AS duplicate_count,
             (ARRAY_AGG(id ORDER BY strategic_importance_score DESC NULLS LAST, id ASC))[1]::text AS suggested_canonical_id,
             JSON_AGG(JSON_BUILD_OBJECT(
               'id', id,
               'name', name,
               'domain', domain,
               'sector', sector,
               'strategic_importance_score', strategic_importance_score
             ) ORDER BY strategic_importance_score DESC NULLS LAST, id ASC) AS entities
      FROM keyed
      WHERE LENGTH(duplicate_key) >= 5
      GROUP BY duplicate_key
      HAVING COUNT(*) > 1
    )
    SELECT duplicate_key,
           duplicate_count,
           suggested_canonical_id,
           CASE WHEN duplicate_count >= 3 THEN 0.95 ELSE 0.90 END::numeric(4,2) AS confidence,
           entities,
           d.action AS decision_action,
           d.canonical_id AS decided_canonical_id,
           d.duplicate_ids AS decided_duplicate_ids,
           JSON_BUILD_OBJECT('decision_action', d.action, 'canonical_id', d.canonical_id, 'duplicate_ids', d.duplicate_ids, 'decided_at', d.decided_at) AS decision,
           d.decided_at
    FROM grouped
    LEFT JOIN intelligence.duplicate_decisions d
      ON d.entity_type = 'organization' AND d.duplicate_key = grouped.duplicate_key
    WHERE d.action IS DISTINCT FROM 'ignored'
    ORDER BY confidence DESC, duplicate_count DESC, duplicate_key ASC
    LIMIT $1
  `, [limit])
  return rows
}

async function auditDuplicateSummary(pool, options = {}) {
  const limit = capLimit(options.limit || 10)
  const [contacts, organizations] = await Promise.all([
    auditDuplicateContacts(pool, { limit }),
    auditDuplicateOrganizations(pool, { limit }),
  ])
  return {
    contacts: {
      candidate_groups: contacts.length,
      duplicate_entities: contacts.reduce((sum, g) => sum + Number(g.duplicate_count || 0), 0),
      top: contacts.slice(0, limit),
    },
    organizations: {
      candidate_groups: organizations.length,
      duplicate_entities: organizations.reduce((sum, g) => sum + Number(g.duplicate_count || 0), 0),
      top: organizations.slice(0, limit),
    },
  }
}

module.exports = {
  capLimit,
  normalizeNameKey,
  suggestedCanonical,
  auditDuplicateContacts,
  auditDuplicateOrganizations,
  auditDuplicateSummary,
}
