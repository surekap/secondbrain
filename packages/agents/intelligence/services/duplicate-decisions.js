'use strict'

function capLimit(limit) {
  const n = Number(limit || 25)
  if (!Number.isFinite(n) || n < 1) return 25
  return Math.min(Math.floor(n), 100)
}

function normalizeDuplicateKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeAction(action) {
  const value = String(action || '').trim().toLowerCase()
  if (value === 'confirm' || value === 'confirmed') return 'confirmed'
  if (value === 'ignore' || value === 'ignored') return 'ignored'
  throw new Error('Invalid duplicate decision action')
}

function normalizeEntityType(type) {
  const value = String(type || '').trim().toLowerCase()
  if (value === 'contact' || value === 'organization') return value
  throw new Error('Invalid duplicate entity type')
}

function normalizeIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => String(id || '').trim())
    .filter(Boolean))]
}

async function upsertDuplicateDecision(pool, input = {}) {
  const entityType = normalizeEntityType(input.entity_type)
  const duplicateKey = normalizeDuplicateKey(input.duplicate_key)
  if (!duplicateKey) throw new Error('duplicate_key is required')
  const action = normalizeAction(input.action)
  const canonicalId = input.canonical_id == null || input.canonical_id === '' ? null : String(input.canonical_id)
  const duplicateIds = normalizeIds(input.duplicate_ids)
  const decidedBy = input.decided_by ? String(input.decided_by) : 'user'
  const note = input.note ? String(input.note) : null

  const { rows } = await pool.query(`
    INSERT INTO intelligence.duplicate_decisions (
      entity_type, duplicate_key, action, canonical_id, duplicate_ids, decided_by, note
    ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
    ON CONFLICT (entity_type, duplicate_key) DO UPDATE SET
      action = EXCLUDED.action,
      canonical_id = EXCLUDED.canonical_id,
      duplicate_ids = EXCLUDED.duplicate_ids,
      decided_by = EXCLUDED.decided_by,
      note = EXCLUDED.note,
      decided_at = NOW()
    RETURNING *
  `, [entityType, duplicateKey, action, canonicalId, duplicateIds, decidedBy, note])
  return rows[0]
}

async function listDuplicateDecisions(pool, options = {}) {
  const params = []
  const where = ['1=1']
  if (options.entity_type) {
    params.push(normalizeEntityType(options.entity_type))
    where.push(`entity_type = $${params.length}`)
  }
  if (options.action) {
    params.push(normalizeAction(options.action))
    where.push(`action = $${params.length}`)
  }
  params.push(capLimit(options.limit))
  const { rows } = await pool.query(`
    SELECT id, entity_type, duplicate_key, action, canonical_id, duplicate_ids, decided_by, decided_at, note
    FROM intelligence.duplicate_decisions
    WHERE ${where.join(' AND ')}
    ORDER BY decided_at DESC
    LIMIT $${params.length}
  `, params)
  return rows
}

module.exports = {
  capLimit,
  normalizeDuplicateKey,
  normalizeAction,
  normalizeEntityType,
  normalizeIds,
  upsertDuplicateDecision,
  listDuplicateDecisions,
}
