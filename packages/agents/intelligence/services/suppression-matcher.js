'use strict'

const crypto = require('crypto')

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizedTitleHash(title) {
  const normalized = compact(title).toLowerCase()
  if (!normalized) return null
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

function candidateContext(input = {}) {
  return {
    opportunityId: input.opportunity_id ? String(input.opportunity_id) : null,
    sourceRef: compact(input.source_ref),
    sourceSystem: compact(input.source_system) || null,
    titleHash: normalizedTitleHash(input.title),
    contactId: input.primary_contact_id == null ? null : String(input.primary_contact_id),
    projectId: input.primary_project_id == null ? null : String(input.primary_project_id),
    title: compact(input.title),
    description: compact(input.description),
  }
}

async function matchOpportunitySuppression(pool, input = {}) {
  if (!pool) return null
  const candidate = candidateContext(input)
  const { rows } = await pool.query(`
    SELECT id, scope_type, scope_id, match_type, match_value, detector, source_system, reason_code, note, created_by, expires_at, active, metadata, created_at, updated_at
    FROM intelligence.opportunity_suppressions s
    WHERE s.active = true
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND (
        ($1::text IS NOT NULL AND s.scope_type = 'opportunity' AND s.scope_id = $1::text)
        OR ($2::text <> '' AND s.scope_type = 'source_ref' AND s.match_type = 'exact' AND s.match_value = $2::text)
        OR ($3::text IS NOT NULL AND s.scope_type = 'contact' AND s.match_type = 'exact' AND s.scope_id = $3::text)
        OR ($4::text IS NOT NULL AND s.scope_type = 'project' AND s.match_type = 'exact' AND s.scope_id = $4::text)
        OR ($5::text IS NOT NULL AND s.match_type = 'normalized_title_hash' AND s.match_value = $5::text)
        OR (s.match_type = 'pattern' AND (
          ($6::text <> '' AND $6::text ILIKE s.match_value)
          OR ($7::text <> '' AND $7::text ILIKE s.match_value)
          OR ($2::text <> '' AND $2::text ILIKE s.match_value)
        ))
      )
    ORDER BY
      CASE s.match_type WHEN 'exact' THEN 0 WHEN 'normalized_title_hash' THEN 1 ELSE 2 END,
      s.created_at DESC
    LIMIT 1
  `, [candidate.opportunityId, candidate.sourceRef, candidate.contactId, candidate.projectId, candidate.titleHash, candidate.title, candidate.description])
  return rows[0] || null
}

async function createOpportunitySuppression(pool, suppression = {}) {
  if (!pool) return null
  const scopeType = suppression.scope_type || suppression.scopeType
  const matchType = suppression.match_type || suppression.matchType || 'exact'
  const matchValue = compact(suppression.match_value || suppression.matchValue)
  if (!scopeType || !matchValue) {
    throw new Error('scope_type and match_value are required for suppression')
  }
  const scopeId = suppression.scope_id == null ? null : String(suppression.scope_id)
  const { rows } = await pool.query(`
    INSERT INTO intelligence.opportunity_suppressions (
      scope_type, scope_id, match_type, match_value, detector, source_system, reason_code,
      note, created_by, expires_at, active, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, true), $12::jsonb)
    RETURNING *
  `, [
    scopeType,
    scopeId,
    matchType,
    matchValue,
    suppression.detector || null,
    suppression.source_system || null,
    suppression.reason_code || 'not_useful',
    suppression.note || null,
    suppression.created_by || 'user',
    suppression.expires_at || null,
    suppression.active,
    JSON.stringify(suppression.metadata || {}),
  ])
  return rows[0] || null
}

function suppressionDecisionLabel(row) {
  if (!row) return null
  return `${row.scope_type}:${row.match_type}:${row.reason_code}`
}

module.exports = {
  normalizedTitleHash,
  matchOpportunitySuppression,
  createOpportunitySuppression,
  suppressionDecisionLabel,
}
