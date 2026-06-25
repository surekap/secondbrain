'use strict'

const DEFAULT_TYPES = ['contact', 'organization']

function normalizeQuery(query) {
  return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function sanitizeTypes(types) {
  const allowed = new Set(['contact', 'organization', 'topic', 'project', 'group', 'event', 'other'])
  const input = Array.isArray(types) ? types : DEFAULT_TYPES
  const out = input.map(t => String(t || '').trim()).filter(t => allowed.has(t))
  return out.length ? out : DEFAULT_TYPES
}

function capLimit(limit) {
  const n = Number(limit || 20)
  if (!Number.isFinite(n) || n < 1) return 20
  return Math.min(Math.floor(n), 50)
}

async function resolveEntityAlias(pool, query, options = {}) {
  const q = normalizeQuery(query)
  if (!q) return []
  const like = `%${q}%`
  const types = sanitizeTypes(options.types)
  const limit = capLimit(options.limit)

  const { rows } = await pool.query(`
    WITH alias_matches AS (
      SELECT a.entity_type,
             a.entity_id,
             a.alias AS matched_alias,
             CASE
               WHEN a.normalized_alias = $1 THEN 'alias_exact'
               WHEN a.normalized_alias LIKE $1 || '%' THEN 'alias_prefix'
               ELSE 'alias_contains'
             END AS match_kind,
             a.confidence,
             CASE
               WHEN a.normalized_alias = $1 THEN 100
               WHEN a.normalized_alias LIKE $1 || '%' THEN 85
               ELSE 65
             END * COALESCE(a.confidence, 0.7) AS score
      FROM intelligence.entity_aliases a
      WHERE a.entity_type = ANY($3::text[])
        AND a.normalized_alias LIKE $2
    ),
    contact_matches AS (
      SELECT 'contact'::text AS entity_type,
             c.id::text AS entity_id,
             c.display_name AS matched_alias,
             CASE WHEN LOWER(c.display_name) = $1 THEN 'canonical_exact' ELSE 'canonical_contains' END AS match_kind,
             1.0::numeric AS confidence,
             CASE WHEN LOWER(c.display_name) = $1 THEN 98 ELSE 60 END::numeric AS score
      FROM relationships.contacts c
      WHERE 'contact' = ANY($3::text[])
        AND LOWER(c.display_name) LIKE $2
    ),
    organization_matches AS (
      SELECT 'organization'::text AS entity_type,
             o.id::text AS entity_id,
             o.name AS matched_alias,
             CASE WHEN o.normalized_name = $1 THEN 'canonical_exact' ELSE 'canonical_contains' END AS match_kind,
             1.0::numeric AS confidence,
             CASE WHEN o.normalized_name = $1 THEN 98 ELSE 60 END::numeric AS score
      FROM intelligence.organizations o
      WHERE 'organization' = ANY($3::text[])
        AND (o.normalized_name LIKE $2 OR LOWER(COALESCE(o.domain, '')) LIKE $2)
    ),
    matches AS (
      SELECT * FROM alias_matches
      UNION ALL SELECT * FROM contact_matches
      UNION ALL SELECT * FROM organization_matches
    ),
    ranked AS (
      SELECT DISTINCT ON (m.entity_type, m.entity_id)
             m.entity_type,
             m.entity_id,
             m.matched_alias,
             m.match_kind,
             m.confidence,
             m.score
      FROM matches m
      ORDER BY m.entity_type, m.entity_id, m.score DESC, m.match_kind ASC
    ),
    resolved AS (
      SELECT r.entity_type,
             r.entity_id AS matched_entity_id,
             COALESCE(d.canonical_id, r.entity_id) AS canonical_entity_id,
             r.matched_alias,
             r.match_kind,
             r.confidence,
             r.score,
             d.id AS duplicate_decision_id,
             d.duplicate_key AS duplicate_key,
             d.duplicate_ids AS duplicate_ids,
             (d.id IS NOT NULL AND r.entity_id <> d.canonical_id) AS is_duplicate_entity
      FROM ranked r
      LEFT JOIN intelligence.duplicate_decisions d
        ON d.entity_type = r.entity_type
       AND d.action = 'confirmed'
       AND (r.entity_id = d.canonical_id OR r.entity_id = ANY(d.duplicate_ids))
    ),
    canonical_ranked AS (
      SELECT DISTINCT ON (entity_type, canonical_entity_id)
             entity_type,
             matched_entity_id,
             canonical_entity_id,
             canonical_entity_id AS entity_id,
             matched_alias,
             match_kind,
             confidence,
             score,
             duplicate_decision_id,
             duplicate_key,
             duplicate_ids,
             is_duplicate_entity
      FROM resolved
      ORDER BY entity_type, canonical_entity_id, score DESC, is_duplicate_entity ASC, matched_entity_id ASC
    )
    SELECT cr.*,
           c.display_name AS contact_name,
           c.company AS contact_company,
           c.job_title AS contact_job_title,
           c.relationship_tier AS contact_tier,
           o.name AS organization_name,
           o.domain AS organization_domain
    FROM canonical_ranked cr
    LEFT JOIN relationships.contacts c ON cr.entity_type = 'contact' AND c.id::text = cr.canonical_entity_id
    LEFT JOIN intelligence.organizations o ON cr.entity_type = 'organization' AND o.id::text = cr.canonical_entity_id
    ORDER BY cr.score DESC, cr.confidence DESC NULLS LAST, COALESCE(c.display_name, o.name, cr.matched_alias) ASC
    LIMIT $4
  `, [q, like, types, limit])

  return rows
}

module.exports = {
  normalizeQuery,
  resolveEntityAlias,
  sanitizeTypes,
  capLimit,
}
