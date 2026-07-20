'use strict'

const crypto = require('crypto')

const DEFAULT_REPEAT_THRESHOLD = 3

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function guidanceKey(input) {
  return input.guidance_key || hash([
    input.scope_type || 'global',
    input.scope_id || '*',
    input.fact_type,
    JSON.stringify(input.fact_value),
    input.source_ref || 'user',
  ].join(':'))
}

function shouldAskClarification(ambiguity, repeatThreshold = DEFAULT_REPEAT_THRESHOLD) {
  return Boolean(
    ambiguity &&
    ambiguity.impact === 'high' &&
    ambiguity.status === 'pending' &&
    Number(ambiguity.occurrences || 0) >= repeatThreshold
  )
}

function formatGuidanceContext(facts = []) {
  const active = facts.filter(fact =>
    fact && fact.state === 'active' && fact.fact_value?.mode !== 'released'
  )
  if (!active.length) return ''
  const safe = active.map(fact => ({
    scope: `${fact.scope_type}:${fact.scope_id || '*'}`,
    fact_type: fact.fact_type,
    fact: fact.fact_value,
    confidence: fact.confidence,
    provenance: fact.provenance,
    valid_from: fact.valid_from,
    valid_until: fact.valid_until,
  }))
  return `\nUser clarification overlay (authoritative guidance, never source data; preserve contradictory source evidence and flag it):\n<guidance_facts_json>\n${JSON.stringify(safe)}\n</guidance_facts_json>\n`
}

async function insertGuidanceFact(client, input) {
  const key = guidanceKey(input)
  let supersedesId = input.supersedes_id || null
  if (!supersedesId && input.replace_active !== false) {
    const previous = await client.query(`
        SELECT id
        FROM intelligence.guidance_facts
        WHERE scope_type = $1
          AND COALESCE(scope_id, '') = COALESCE($2, '')
          AND fact_type = $3
          AND state = 'active'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
    `, [input.scope_type || 'global', input.scope_id || null, input.fact_type])
    supersedesId = previous.rows[0]?.id || null
  }
  const inserted = await client.query(`
      INSERT INTO intelligence.guidance_facts (
        guidance_key, scope_type, scope_id, fact_type, fact_value,
        provenance, source_ref, confidence, state, valid_from, valid_until,
        supersedes_id, metadata
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'active',$9,$10,$11,$12::jsonb)
      ON CONFLICT (guidance_key) DO UPDATE SET
        confidence = GREATEST(intelligence.guidance_facts.confidence, EXCLUDED.confidence),
        valid_until = EXCLUDED.valid_until,
        metadata = intelligence.guidance_facts.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
  `, [
      key,
      input.scope_type || 'global',
      input.scope_id || null,
      input.fact_type,
      JSON.stringify(input.fact_value),
      input.provenance || 'user_clarification',
      input.source_ref || null,
      input.confidence ?? 1,
      input.valid_from || new Date(),
      input.valid_until || null,
      supersedesId,
      JSON.stringify(input.metadata || {}),
  ])
  const row = inserted.rows[0]
  if (supersedesId && String(supersedesId) !== String(row.id)) {
    await client.query(`
        UPDATE intelligence.guidance_facts
        SET state = 'superseded', superseded_by_id = $2, updated_at = NOW()
        WHERE id = $1 AND state = 'active'
    `, [supersedesId, row.id])
  }
  return row
}

async function recordGuidanceFactInTransaction(client, input) {
  if (!client?.query) throw new Error('A database query interface is required')
  if (!input?.fact_type || input.fact_value === undefined) throw new Error('fact_type and fact_value are required')
  return insertGuidanceFact(client, input)
}

async function recordGuidanceFact(pool, input) {
  if (!pool?.query) throw new Error('A database query interface is required')
  if (!input?.fact_type || input.fact_value === undefined) throw new Error('fact_type and fact_value are required')
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function' ? () => client.release() : () => {}
  try {
    await client.query('BEGIN')
    const row = await recordGuidanceFactInTransaction(client, input)
    await client.query('COMMIT')
    return row
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw error
  } finally {
    release()
  }
}

async function getApplicableGuidance(pool, scopes = [], at = new Date()) {
  const normalized = [{ scope_type: 'global', scope_id: null }, ...scopes]
  const pairs = normalized.filter(scope => scope?.scope_type)
  const scopeTypes = pairs.map(scope => scope.scope_type)
  const scopeIds = pairs.map(scope => scope.scope_id == null ? '' : String(scope.scope_id))
  const { rows } = await pool.query(`
    SELECT *
    FROM intelligence.guidance_facts
    WHERE state = 'active'
      AND valid_from <= $3
      AND (valid_until IS NULL OR valid_until > $3)
      AND (scope_type, COALESCE(scope_id, '')) IN (
        SELECT * FROM UNNEST($1::text[], $2::text[])
      )
    ORDER BY CASE WHEN scope_type = 'global' THEN 0 ELSE 1 END, created_at
  `, [scopeTypes, scopeIds, at])
  return rows
}

function normalizeEvidenceObservations(input = {}) {
  const refs = []
  if (input.evidence_key) refs.push(input.evidence_key)
  if (Array.isArray(input.evidence_refs)) refs.push(...input.evidence_refs)
  if (Array.isArray(input.metadata?.evidence_refs)) refs.push(...input.metadata.evidence_refs)

  const observations = []
  const seen = new Set()
  for (const ref of refs) {
    let sourceRef = null
    let occurredAt = null
    let material
    if (typeof ref === 'string' || typeof ref === 'number') {
      sourceRef = String(ref).trim()
      material = sourceRef
    } else if (ref && typeof ref === 'object') {
      const source = ref.source_table || ref.source || null
      const sourceId = ref.source_id || ref.id || ref.episode_id || null
      sourceRef = ref.source_ref || (source && sourceId != null ? `${source}:${sourceId}` : null)
      occurredAt = ref.occurred_at || ref.date || null
      material = sourceRef || (sourceId != null ? String(sourceId) : null)
    }
    if (!material) continue
    const evidenceKey = hash(`clarification-evidence:${material}`)
    if (seen.has(evidenceKey)) continue
    seen.add(evidenceKey)
    observations.push({ evidence_key: evidenceKey, source_ref: sourceRef, occurred_at: occurredAt })
  }

  // A detector with no evidence identity may establish an ambiguity once, but
  // rerunning it can never manufacture the three successive communications
  // required to interrupt the user.
  if (!observations.length && input.ambiguity_key) {
    observations.push({
      evidence_key: hash(`clarification-unkeyed:${input.ambiguity_key}`),
      source_ref: null,
      occurred_at: null,
    })
  }
  return observations
}

async function observeAmbiguity(pool, input) {
  if (!input?.ambiguity_key || !input?.question) throw new Error('ambiguity_key and question are required')
  const observations = normalizeEvidenceObservations(input)
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function' ? () => client.release() : () => {}
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`
      INSERT INTO intelligence.clarification_questions (
        ambiguity_key, scope_type, scope_id, question, impact, status,
        occurrences, first_observed_at, last_observed_at, metadata
      ) VALUES ($1,$2,$3,$4,$5,'pending',0,NOW(),NOW(),$6::jsonb)
      ON CONFLICT (ambiguity_key) DO UPDATE SET
        question = EXCLUDED.question,
        impact = EXCLUDED.impact,
        metadata = intelligence.clarification_questions.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `, [
      input.ambiguity_key,
      input.scope_type || 'global',
      input.scope_id || null,
      input.question,
      input.impact || 'low',
      JSON.stringify(input.metadata || {}),
    ])
    const clarificationId = rows[0].id
    for (const observation of observations) {
      await client.query(`
        INSERT INTO intelligence.clarification_observations (
          clarification_id, evidence_key, source_ref, occurred_at, metadata
        ) VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (clarification_id, evidence_key) DO NOTHING
      `, [
        clarificationId,
        observation.evidence_key,
        observation.source_ref,
        observation.occurred_at,
        JSON.stringify({ detector: input.metadata?.source || null }),
      ])
    }
    const updated = await client.query(`
      UPDATE intelligence.clarification_questions q
      SET occurrences = observations.distinct_count,
          last_observed_at = observations.last_observed_at,
          updated_at = NOW()
      FROM (
        SELECT clarification_id, COUNT(*)::integer AS distinct_count,
               MAX(observed_at) AS last_observed_at
        FROM intelligence.clarification_observations
        WHERE clarification_id = $1
        GROUP BY clarification_id
      ) observations
      WHERE q.id = observations.clarification_id
      RETURNING q.*
    `, [clarificationId])
    await client.query('COMMIT')
    const ambiguity = updated.rows[0]
    return { ...ambiguity, should_ask: shouldAskClarification(ambiguity, input.repeat_threshold) }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw error
  } finally {
    release()
  }
}

async function listClarificationsToAsk(pool, limit = 5) {
  const boundedLimit = Math.max(1, Math.min(10, Number(limit) || 5))
  const { rows } = await pool.query(`
    SELECT *
    FROM intelligence.clarification_questions
    WHERE status = 'pending'
      AND impact = 'high'
      AND occurrences >= $1
    ORDER BY occurrences DESC, last_observed_at DESC
    LIMIT $2
  `, [DEFAULT_REPEAT_THRESHOLD, boundedLimit])
  return rows
}

async function answerClarification(pool, ambiguityKey, answer) {
  if (answer?.fact_value === undefined) throw new Error('fact_value is required')
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function' ? () => client.release() : () => {}
  try {
    await client.query('BEGIN')
    const ambiguity = await client.query(`
      SELECT * FROM intelligence.clarification_questions
      WHERE ambiguity_key = $1 AND status = 'pending'
      LIMIT 1
      FOR UPDATE
    `, [ambiguityKey])
    if (!ambiguity.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    const question = ambiguity.rows[0]
    const fact = await insertGuidanceFact(client, {
      scope_type: question.scope_type,
      scope_id: question.scope_id,
      fact_type: answer.fact_type || 'decision_rule',
      fact_value: answer.fact_value,
      provenance: 'user_clarification',
      source_ref: `clarification:${question.id}`,
      confidence: answer.confidence ?? 1,
      metadata: { ambiguity_key: ambiguityKey, ...(answer.metadata || {}) },
    })
    await client.query(`
      UPDATE intelligence.clarification_questions
      SET status = 'answered', answer_guidance_fact_id = $2, answered_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [question.id, fact.id])
    await client.query('COMMIT')
    return fact
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw error
  } finally {
    release()
  }
}

async function resolveAmbiguityAutomatically(pool, ambiguityKey, metadata = {}) {
  const { rows } = await pool.query(`
    UPDATE intelligence.clarification_questions
    SET status = 'auto_resolved', resolved_at = NOW(),
        metadata = metadata || $2::jsonb, updated_at = NOW()
    WHERE ambiguity_key = $1 AND status = 'pending'
    RETURNING *
  `, [ambiguityKey, JSON.stringify(metadata)])
  return rows[0] || null
}

module.exports = {
  DEFAULT_REPEAT_THRESHOLD,
  answerClarification,
  formatGuidanceContext,
  getApplicableGuidance,
  guidanceKey,
  listClarificationsToAsk,
  normalizeEvidenceObservations,
  observeAmbiguity,
  recordGuidanceFact,
  recordGuidanceFactInTransaction,
  resolveAmbiguityAutomatically,
  shouldAskClarification,
}
