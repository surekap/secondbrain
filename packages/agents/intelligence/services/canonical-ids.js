'use strict'

function normalizeEntityId(id) {
  if (id === null || id === undefined) return null
  const value = String(id).trim()
  return value ? value : null
}

function normalizeEntityType(type) {
  const value = String(type || '').trim().toLowerCase()
  if (value === 'contact' || value === 'organization') return value
  throw new Error('Invalid canonical entity type')
}

async function canonicalizeEntityId(pool, entityType, entityId) {
  const type = normalizeEntityType(entityType)
  const id = normalizeEntityId(entityId)
  if (!id) return null

  const { rows } = await pool.query(`
    SELECT canonical_id
    FROM intelligence.duplicate_decisions
    WHERE entity_type = $1
      AND action = 'confirmed'
      AND ($2 = canonical_id OR $2 = ANY(duplicate_ids))
    LIMIT 1
  `, [type, id])

  return rows[0]?.canonical_id ? String(rows[0].canonical_id) : id
}

async function canonicalizeEntityIds(pool, entityType, entityIds = []) {
  const type = normalizeEntityType(entityType)
  const ids = [...new Set((Array.isArray(entityIds) ? entityIds : [])
    .map(normalizeEntityId)
    .filter(Boolean))]
  if (!ids.length) return []

  const { rows } = await pool.query(`
    WITH input AS (
      SELECT id, ord
      FROM UNNEST($2::text[]) WITH ORDINALITY AS x(id, ord)
    ),
    mapped AS (
      SELECT input.id AS input_id,
             COALESCE(d.canonical_id, input.id) AS canonical_id,
             input.ord
      FROM input
      LEFT JOIN intelligence.duplicate_decisions d
        ON d.entity_type = $1
       AND d.action = 'confirmed'
       AND (input.id = d.canonical_id OR input.id = ANY(d.duplicate_ids))
    )
    SELECT DISTINCT ON (canonical_id) input_id, canonical_id, ord
    FROM mapped
    ORDER BY canonical_id, ord ASC
  `, [type, ids])

  const out = []
  const seen = new Set()
  for (const row of rows.sort((a, b) => Number(a.ord || 0) - Number(b.ord || 0))) {
    const canonicalId = String(row.canonical_id)
    if (seen.has(canonicalId)) continue
    seen.add(canonicalId)
    out.push(canonicalId)
  }
  return out
}

module.exports = {
  normalizeEntityId,
  normalizeEntityType,
  canonicalizeEntityId,
  canonicalizeEntityIds,
}
