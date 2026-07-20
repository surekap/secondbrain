'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('@secondbrain/db')
const { extractSignals } = require('./services/signal-extractor')
const guidance = require('./services/guidance')
const { extractOrganizations } = require('./services/organization-extractor')
const { checkDormancy } = require('./services/dormancy-monitor')
const { buildSignalClusters, shouldPromoteCluster, opportunityFromCluster, clusterPromotionPlan, verifyCluster } = require('./services/signal-clusterer')
const { recommendContactTiers } = require('./services/contact-tierer')
const { extractAliases, normalized: normalizeAlias } = require('./services/alias-extractor')
const { canonicalizeEntityId, canonicalizeEntityIds } = require('./services/canonical-ids')
const { matchOpportunitySuppression } = require('./services/suppression-matcher')
const { detectStaleEmailThreads } = require('./services/stale-email-thread-detector')
const { detectCrossChannelProjectSignals } = require('./services/cross-channel-project-detector')
const { detectRelationshipOpenLoops } = require('./services/relationship-open-loop-detector')
const { detectHomeImprovementOpportunities } = require('./services/home-improvement-detector')
const { backfillCommunicationEvents } = require('./services/communication-event-extractor')
const { extractRelationshipFactsFromText, inferContactMention } = require('../relationships/services/fact-extractor')

const schemaReadyByPool = new WeakMap()

async function ensureSchema(pool = db) {
  if (!pool || (typeof pool !== 'object' && typeof pool !== 'function')) throw new Error('A database query interface is required')
  if (schemaReadyByPool.has(pool)) return schemaReadyByPool.get(pool)
  const readiness = (async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
    await pool.query(sql)
  })()
  schemaReadyByPool.set(pool, readiness)
  try {
    await readiness
  } catch (error) {
    schemaReadyByPool.delete(pool)
    throw error
  }
}

const RELATIONSHIP_INSIGHT_TYPES = new Set([
  'opportunity',
  'cross_source_opportunity',
  'project_match',
  'action_needed',
  'awaiting_reply',
  'cold_email',
  'unread_group',
])

const PROJECT_INSIGHT_TYPES = new Set([
  'opportunity',
  'risk',
  'blocker',
  'next_action',
  'decision',
  'status',
])
const DIRECT_EVIDENCE_TABLES = new Set([
  'relationships.communications',
  'email.emails',
  'public.messages',
  'limitless.lifelogs',
])
const CANONICAL_ITEM_EVIDENCE_TABLE = 'relationships.communications'
const DIRECT_EVIDENCE_EXISTS_SQL = `(
  e.source_table = 'relationships.communications' AND EXISTS (
    SELECT 1 FROM relationships.communications x
    WHERE x.id = CASE WHEN e.source_id ~ '^[0-9]+$' THEN e.source_id::bigint ELSE -1 END
      AND COALESCE(x.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
  )
)`
const DAILY_ATTENTION_LIMIT = 10

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24)
}

function priorityScore(priority) {
  switch (priority) {
    case 'high': return { impact: 80, urgency: 80, expected: 80 }
    case 'low': return { impact: 30, urgency: 30, expected: 30 }
    case 'medium':
    default: return { impact: 55, urgency: 55, expected: 55 }
  }
}

function relationshipOpportunityType(insightType, sourceRef) {
  if (insightType === 'project_match') return 'project_match'
  if (insightType === 'cross_source_opportunity') return 'introduction'
  if (insightType === 'action_needed') return 'meeting_action'
  if (insightType === 'awaiting_reply' || insightType === 'cold_email') return 'follow_up'
  if (insightType === 'unread_group') return 'group_opportunity'
  if (sourceRef && sourceRef.startsWith('research:')) return 'research_opportunity'
  return 'other'
}

function projectOpportunityType(insightType) {
  if (insightType === 'opportunity') return 'project_opportunity'
  if (insightType === 'risk' || insightType === 'blocker') return 'risk'
  if (insightType === 'next_action') return 'meeting_action'
  return 'other'
}

function projectInsightItemType(insightType) {
  if (insightType === 'opportunity') return 'opportunity'
  if (insightType === 'risk') return 'risk'
  if (insightType === 'blocker') return 'issue'
  if (insightType === 'next_action') return 'action'
  if (insightType === 'decision') return 'decision'
  return 'insight'
}

function itemTypeFor(input = {}) {
  if (input.item_type) return input.item_type
  const type = input.opportunity_type || 'other'
  if (type === 'risk') return 'risk'
  if (type === 'meeting_action' || type === 'follow_up' || type === 'email_response_gap' || type === 'urgent_message' || type === 'check_in') return 'action'
  if (type === 'project_opportunity' || type === 'project_match' || type === 'introduction' || type === 'research_opportunity' || type === 'group_opportunity') return 'opportunity'
  return 'insight'
}


function compactText(value, max = 140) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function deriveRecommendedNextAction(input = {}) {
  if (input.recommended_next_action && String(input.recommended_next_action).trim()) {
    return compactText(input.recommended_next_action, 220)
  }
  const type = input.opportunity_type || 'other'
  const title = compactText(input.title, 120) || 'this opportunity'

  if (/^re-engage\b/i.test(title)) {
    return `Send a lightweight check-in referencing the last known context; ask one specific question before investing more time.`
  }

  switch (type) {
    case 'follow_up':
    case 'email_response_gap':
      return `Send a concise follow-up on "${title}" and ask for the next concrete response or decision.`
    case 'introduction':
    case 'project_match':
      return `Identify the best-fit person or project owner, then send a short intro note explaining the specific mutual value.`
    case 'meeting_action':
      return `Turn "${title}" into a concrete task with owner, deadline, and the next message/meeting required.`
    case 'urgent_message':
      return `Review the source message now and either reply, delegate, or dismiss it as no longer urgent.`
    case 'relationship_health':
    case 'check_in':
      return `Send a low-friction check-in that references shared context and offers one useful next step.`
    case 'research_opportunity':
      return `Send a targeted note or save a research task tying "${title}" to a concrete collaboration angle.`
    case 'group_opportunity':
      return `Use the relevant group thread to ask one specific question or make one useful introduction tied to this signal.`
    case 'project_opportunity':
      return `Review the linked project and convert this into the next owner/action/date if it is still valuable.`
    case 'risk':
      return `Assess the risk, name the owner, and decide whether to mitigate, monitor, or dismiss it.`
    default:
      return `Review the evidence for "${title}" and decide: act, delegate, snooze, or dismiss.`
  }
}

function sourceRefFromRelationshipInsight(insightId, insight) {
  return insight.source_ref || `relationships.insights:${insightId}`
}

function sourceRefFromProjectInsight(projectInsightId) {
  return `projects.project_insights:${projectInsightId}`
}

function sourceRefFromGroupOpportunity(groupId, opportunity, index = 0) {
  const title = opportunity?.title || 'Group opportunity'
  const description = opportunity?.description || ''
  return `relationships.groups:${groupId}:opportunity:${index}:${stableHash(`${title}:${description}`)}`
}

function dedupeKeyFor(sourceSystem, sourceRef, title) {
  return `${sourceSystem}:${sourceRef || stableHash(title)}`
}

function canonicalCommunicationReferenceCandidates(refs = []) {
  const sourceKinds = new Set(['email', 'whatsapp', 'limitless'])
  const candidates = []
  for (const value of Array.isArray(refs) ? refs : []) {
    const raw = String(value || '').trim()
    if (!raw) continue
    candidates.push(raw)

    const relationPrefix = raw.match(/^relationships\.communications?:/)
    if (relationPrefix) candidates.push(raw.slice(relationPrefix[0].length))

    const separator = raw.indexOf(':')
    if (separator < 1) continue
    const kind = raw.slice(0, separator)
    const remainder = raw.slice(separator + 1)
    // Recover references emitted by the previous prompt, which prepended the
    // channel to an already-canonical source_id (for example email:email:123).
    if (sourceKinds.has(kind) && remainder.startsWith(`${kind}:`)) candidates.push(remainder)
  }
  return [...new Set(candidates)].slice(0, 100)
}

async function resolveCanonicalCommunicationRefs(pool, refs = []) {
  const candidates = canonicalCommunicationReferenceCandidates(refs)
  if (!candidates.length) return []
  const { rows } = await pool.query(`
    SELECT id, source, source_id, occurred_at, content_snippet, subject
    FROM relationships.communications
    WHERE source_id = ANY($1::text[])
  `, [candidates])
  const order = new Map(candidates.map((sourceId, index) => [sourceId, index]))
  return rows
    .filter(row => order.has(String(row.source_id)))
    .sort((left, right) => order.get(String(left.source_id)) - order.get(String(right.source_id)))
}

async function upsertOpportunity(input) {
  await ensureSchema()
  const suppression = await matchOpportunitySuppression(db, input)
  if (suppression) {
    console.log('[intelligence] opportunity suppressed', {
      title: input.title,
      source_ref: input.source_ref || null,
      reason_code: suppression.reason_code,
      match_type: suppression.match_type,
    })
    return null
  }
  const scores = priorityScore(input.priority)
  let dedupeKey = input.dedupe_key || dedupeKeyFor(input.source_system, input.source_ref, input.title)
  const itemFingerprint = input.item_fingerprint || stableHash(dedupeKey)
  const fingerprintMatch = await db.query(`
    SELECT id, dedupe_key, source_ref
    FROM intelligence.opportunities
    WHERE item_fingerprint = $1
    LIMIT 1
  `, [itemFingerprint])
  if (fingerprintMatch.rows[0]) {
    const match = fingerprintMatch.rows[0]
    if (!match.dedupe_key) {
      await db.query(`
        UPDATE intelligence.opportunities
        SET dedupe_key = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
        WHERE id = $1
      `, [match.id, dedupeKey, JSON.stringify({ source_aliases: [input.source_ref].filter(Boolean) })])
    }
    dedupeKey = match.dedupe_key || dedupeKey
    input.metadata = {
      ...(input.metadata || {}),
      source_aliases: [...new Set([match.source_ref, input.source_ref].filter(Boolean))],
    }
  }
  const itemType = itemTypeFor(input)
  const recommendedNextAction = deriveRecommendedNextAction(input)
  const canonicalPrimaryContactId = await canonicalizeEntityId(db, 'contact', input.primary_contact_id)
  const expectedValueScore = input.expected_value_score ?? computeExpectedValue({ ...input, primary_contact_id: canonicalPrimaryContactId, recommended_next_action: recommendedNextAction })

  const { rows } = await db.query(`
    INSERT INTO intelligence.opportunities (
      opportunity_type, title, description, recommended_next_action, why_now,
      status, priority, confidence, impact_score, urgency_score, relationship_score,
      expected_value_score, score_explanation, source_system, source_ref, source_hash,
      dedupe_key, primary_contact_id, primary_project_id, surfaced_insight_id,
      surfaced_project_insight_id, metadata, item_type, item_fingerprint,
      lifecycle_state, first_corroborated_at, last_corroborated_at, detector_version
    ) VALUES (
      $1, $2, $3, $4, $5,
      'open', $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19,
      $20, $21::jsonb, $22, $23,
      'candidate', NULL, NULL, $24
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      recommended_next_action = COALESCE(EXCLUDED.recommended_next_action, intelligence.opportunities.recommended_next_action),
      why_now = COALESCE(EXCLUDED.why_now, intelligence.opportunities.why_now),
      priority = EXCLUDED.priority,
      confidence = COALESCE(EXCLUDED.confidence, intelligence.opportunities.confidence),
      impact_score = EXCLUDED.impact_score,
      urgency_score = EXCLUDED.urgency_score,
      relationship_score = COALESCE(EXCLUDED.relationship_score, intelligence.opportunities.relationship_score),
      expected_value_score = EXCLUDED.expected_value_score,
      score_explanation = EXCLUDED.score_explanation,
      primary_contact_id = CASE
        WHEN EXCLUDED.primary_contact_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM intelligence.opportunity_feedback_events feedback_event
          WHERE feedback_event.opportunity_id = intelligence.opportunities.id
            AND feedback_event.action = 'wrong_person'
            AND feedback_event.metadata #>> '{link_correction,removed_contact_id}' = EXCLUDED.primary_contact_id::text
        ) THEN intelligence.opportunities.primary_contact_id
        ELSE COALESCE(EXCLUDED.primary_contact_id, intelligence.opportunities.primary_contact_id)
      END,
      primary_project_id = CASE
        WHEN EXCLUDED.primary_project_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM intelligence.opportunity_feedback_events feedback_event
          WHERE feedback_event.opportunity_id = intelligence.opportunities.id
            AND feedback_event.action = 'wrong_project'
            AND feedback_event.metadata #>> '{link_correction,removed_project_id}' = EXCLUDED.primary_project_id::text
        ) THEN intelligence.opportunities.primary_project_id
        ELSE COALESCE(EXCLUDED.primary_project_id, intelligence.opportunities.primary_project_id)
      END,
      surfaced_insight_id = COALESCE(EXCLUDED.surfaced_insight_id, intelligence.opportunities.surfaced_insight_id),
      surfaced_project_insight_id = COALESCE(EXCLUDED.surfaced_project_insight_id, intelligence.opportunities.surfaced_project_insight_id),
      metadata = intelligence.opportunities.metadata || EXCLUDED.metadata,
      item_type = EXCLUDED.item_type,
      item_fingerprint = COALESCE(intelligence.opportunities.item_fingerprint, EXCLUDED.item_fingerprint),
      status = intelligence.opportunities.status,
      lifecycle_state = intelligence.opportunities.lifecycle_state,
      detector_version = COALESCE(EXCLUDED.detector_version, intelligence.opportunities.detector_version),
      last_seen_at = NOW(),
      updated_at = NOW()
    RETURNING id
  `, [
    input.opportunity_type || 'other',
    input.title,
    input.description || null,
    recommendedNextAction || null,
    input.why_now || null,
    input.priority || 'medium',
    input.confidence ?? null,
    input.impact_score ?? scores.impact,
    input.urgency_score ?? scores.urgency,
    input.relationship_score ?? null,
    input.expected_value_score ?? expectedValueScore,
    input.score_explanation || `Expected attention score from impact, urgency, relationship leverage, actionability, confidence, and evidence penalties.`,
    input.source_system || 'relationships',
    input.source_ref || null,
    input.source_hash || stableHash(`${input.source_system}:${input.source_ref}:${input.title}:${input.description || ''}`),
    dedupeKey,
    canonicalPrimaryContactId || null,
    input.primary_project_id || null,
    input.surfaced_insight_id || null,
    input.surfaced_project_insight_id || null,
    JSON.stringify(input.metadata || {}),
    itemType,
    itemFingerprint,
    input.detector_version || input.metadata?.detector || input.metadata?.source || null,
  ])

  const opportunityId = rows[0]?.id || null
  return opportunityId
}

async function wasOpportunityLinkRejected(pool, opportunityId, entityType, entityId) {
  const action = entityType === 'contact' ? 'wrong_person'
    : entityType === 'project' ? 'wrong_project'
    : null
  const metadataField = entityType === 'contact' ? 'removed_contact_id'
    : entityType === 'project' ? 'removed_project_id'
    : null
  if (!action || !metadataField || entityId == null) return false
  const { rows } = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM intelligence.opportunity_feedback_events
      WHERE opportunity_id = $1
        AND action = $2
        AND metadata #>> ARRAY['link_correction', $3::text] = $4
    ) AS rejected
  `, [opportunityId, action, metadataField, String(entityId)])
  return rows[0]?.rejected === true
}

async function linkContacts(opportunityId, contactIds, primaryContactId) {
  const rawUnique = Array.from(new Set((contactIds || []).filter(Boolean).map(id => Number(id)).filter(Number.isFinite)))
  const canonicalPrimaryContactId = await canonicalizeEntityId(db, 'contact', primaryContactId)
  const unique = await canonicalizeEntityIds(db, 'contact', rawUnique)
  if (canonicalPrimaryContactId && !unique.includes(String(canonicalPrimaryContactId))) unique.unshift(String(canonicalPrimaryContactId))
  for (const contactId of unique) {
    const numericContactId = Number(contactId)
    if (!Number.isFinite(numericContactId)) continue
    if (await wasOpportunityLinkRejected(db, opportunityId, 'contact', numericContactId)) continue
    await db.query(`
      INSERT INTO intelligence.opportunity_contacts (opportunity_id, contact_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [opportunityId, numericContactId, String(contactId) === String(canonicalPrimaryContactId) ? 'primary' : 'mentioned'])
  }
}

async function linkProject(opportunityId, projectId, role = 'primary') {
  if (!projectId) return
  if (await wasOpportunityLinkRejected(db, opportunityId, 'project', projectId)) return
  await db.query(`
    INSERT INTO intelligence.opportunity_projects (opportunity_id, project_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
  `, [opportunityId, projectId, role])
}

async function directEvidenceExists(pool, sourceTable, sourceId) {
  const id = String(sourceId || '')
  if (!DIRECT_EVIDENCE_TABLES.has(sourceTable) || !id) return false
  if (['relationships.communications', 'email.emails'].includes(sourceTable) && !/^\d+$/.test(id)) return false
  const queries = {
    'relationships.communications': `SELECT 1 FROM relationships.communications
      WHERE id = $1::bigint
        AND COALESCE(metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
      LIMIT 1`,
    'email.emails': 'SELECT 1 FROM email.emails WHERE id = $1::integer LIMIT 1',
    'limitless.lifelogs': 'SELECT 1 FROM limitless.lifelogs WHERE id = $1 LIMIT 1',
    'public.messages': `SELECT 1 FROM public.messages
      WHERE id = CASE WHEN $1 ~ '^[0-9]+$' THEN $1::bigint ELSE -1 END
         OR wa_msg_id = $1 OR data->'id'->>'_serialized' = $1 LIMIT 1`,
  }
  const { rows } = await pool.query(queries[sourceTable], [id])
  return rows.length > 0
}

async function canonicalItemEvidenceExists(pool, sourceId) {
  return directEvidenceExists(pool, CANONICAL_ITEM_EVIDENCE_TABLE, sourceId)
}

async function validateCanonicalItemEvidence(pool, evidence) {
  if (!evidence?.source_id || evidence.source_table !== CANONICAL_ITEM_EVIDENCE_TABLE) {
    throw new Error(`Item evidence must reference ${CANONICAL_ITEM_EVIDENCE_TABLE}`)
  }
  if (!(await canonicalItemEvidenceExists(pool, evidence.source_id))) {
    throw new Error(`Canonical item evidence does not resolve: ${evidence.source_table}:${evidence.source_id}`)
  }
  return {
    ...evidence,
    source_table: CANONICAL_ITEM_EVIDENCE_TABLE,
    source_id: String(evidence.source_id),
  }
}

async function expireOpportunityAfterPersistenceFailure(pool, opportunityId, error) {
  if (!opportunityId) return
  const reason = compactText(error?.message || error || 'unknown persistence failure', 500)
  await pool.query(`
    UPDATE intelligence.opportunities
    SET status = 'expired', lifecycle_state = 'expired',
        expires_at = COALESCE(expires_at, NOW()),
        feedback_note = COALESCE(feedback_note, 'System-expired: canonical evidence persistence failed'),
        metadata = metadata || $2::jsonb,
        updated_at = NOW()
    WHERE id = $1 AND status = 'open'
  `, [opportunityId, JSON.stringify({
    lifecycle_reason: 'canonical_evidence_persistence_failed',
    persistence_error: reason,
  })]).catch(() => {})
}

async function addEvidence(opportunityId, evidence, pool = db) {
  let canonicalEvidence
  try {
    canonicalEvidence = await validateCanonicalItemEvidence(pool, evidence)
  } catch (error) {
    await expireOpportunityAfterPersistenceFailure(pool, opportunityId, error)
    throw error
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await canonicalItemEvidenceExists(client, canonicalEvidence.source_id))) {
      throw new Error(`Canonical item evidence does not resolve: ${canonicalEvidence.source_table}:${canonicalEvidence.source_id}`)
    }
    const write = await client.query(`
      INSERT INTO intelligence.opportunity_evidence (
        opportunity_id, source_table, source_id, source_ref, occurred_at, quote, relevance, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (opportunity_id, source_table, source_id) DO UPDATE SET
        source_ref = COALESCE(EXCLUDED.source_ref, intelligence.opportunity_evidence.source_ref),
        occurred_at = COALESCE(EXCLUDED.occurred_at, intelligence.opportunity_evidence.occurred_at),
        quote = COALESCE(EXCLUDED.quote, intelligence.opportunity_evidence.quote),
        relevance = COALESCE(EXCLUDED.relevance, intelligence.opportunity_evidence.relevance),
        metadata = intelligence.opportunity_evidence.metadata || EXCLUDED.metadata
      RETURNING (xmax = 0) AS inserted
    `, [
      opportunityId,
      canonicalEvidence.source_table,
      canonicalEvidence.source_id,
      canonicalEvidence.source_ref || null,
      canonicalEvidence.occurred_at || null,
      canonicalEvidence.quote || null,
      canonicalEvidence.relevance ?? null,
      JSON.stringify(canonicalEvidence.metadata || {}),
    ])
    if (write.rows[0]?.inserted === true) {
      const { rows: before } = await client.query(
        'SELECT status, lifecycle_state FROM intelligence.opportunities WHERE id = $1 FOR UPDATE',
        [opportunityId],
      )
      if (before[0]?.status === 'open' && ['candidate', 'active'].includes(before[0]?.lifecycle_state)) {
        await client.query("SELECT set_config('secondbrain.lifecycle_actor','system',true), set_config('secondbrain.lifecycle_producer','intelligence_pipeline',true), set_config('secondbrain.lifecycle_version','evidence-v1',true), set_config('secondbrain.lifecycle_reason','Activated by new direct evidence',true), set_config('secondbrain.lifecycle_evidence_refs',$1,true)", [
          JSON.stringify([`${canonicalEvidence.source_table}:${canonicalEvidence.source_id}`]),
        ])
        await client.query(`
          UPDATE intelligence.opportunities
          SET lifecycle_state = 'active',
              first_corroborated_at = COALESCE(first_corroborated_at, NOW()),
              last_corroborated_at = GREATEST(
                COALESCE(last_corroborated_at, '-infinity'::timestamptz),
                COALESCE($2::timestamptz, NOW())
              ),
              updated_at = NOW()
          WHERE id = $1
        `, [opportunityId, canonicalEvidence.occurred_at || null])
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    await expireOpportunityAfterPersistenceFailure(pool, opportunityId, error)
    throw error
  } finally {
    client.release()
  }
}

async function reopenOpportunityFromContradictoryEvidence(pool, opportunityId, evidence, decision = {}) {
  if (!decision.reason || Number(decision.confidence || 0) < 0.8) {
    throw new Error('Reopening requires an explicit reason and confidence >= 0.8')
  }
  if (!evidence?.occurred_at || evidence.source_table !== CANONICAL_ITEM_EVIDENCE_TABLE) {
    throw new Error('Reopening requires dated canonical communication evidence')
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await directEvidenceExists(client, evidence.source_table, evidence.source_id))) {
      throw new Error(`Direct evidence does not resolve: ${evidence.source_table}:${evidence.source_id}`)
    }
    const itemResult = await client.query(`
      SELECT id, status, lifecycle_state,
             COALESCE(actioned_at, dismissed_at, expires_at, updated_at, created_at) AS terminal_at
      FROM intelligence.opportunities
      WHERE id = $1
      FOR UPDATE
    `, [opportunityId])
    const item = itemResult.rows[0]
    if (!item || !['actioned', 'dismissed', 'expired'].includes(item.status)) {
      throw new Error('Only a terminal item can be explicitly reopened')
    }
    if (new Date(evidence.occurred_at).getTime() <= new Date(item.terminal_at).getTime()) {
      throw new Error('Reopening evidence must be newer than the terminal decision')
    }
    const write = await client.query(`
      INSERT INTO intelligence.opportunity_evidence (
        opportunity_id, source_table, source_id, source_ref, occurred_at, quote, relevance, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (opportunity_id, source_table, source_id) DO NOTHING
      RETURNING id
    `, [
      opportunityId, evidence.source_table, String(evidence.source_id), evidence.source_ref || null,
      evidence.occurred_at, evidence.quote || null, evidence.relevance ?? decision.confidence,
      JSON.stringify({
        ...(evidence.metadata || {}),
        terminal_reopen_kind: decision.kind || 'contradiction',
        contradictory_terminal_evidence: decision.kind !== 'recurrence',
      }),
    ])
    if (!write.rows[0]) throw new Error('Reopening requires previously unseen contradictory evidence')
    await client.query("SELECT set_config('secondbrain.lifecycle_actor',$1,true), set_config('secondbrain.lifecycle_producer','explicit_reopen_service',true), set_config('secondbrain.lifecycle_version','reopen-v1',true), set_config('secondbrain.lifecycle_reason',$2,true), set_config('secondbrain.lifecycle_evidence_refs',$3,true)", [
      decision.actor || 'system',
      decision.reason,
      JSON.stringify([`${evidence.source_table}:${evidence.source_id}`]),
    ])
    await client.query(`
      UPDATE intelligence.opportunities
      SET status = 'open', lifecycle_state = 'active',
          actioned_at = NULL, dismissed_at = NULL, expires_at = NULL,
          first_corroborated_at = COALESCE(first_corroborated_at, $2::timestamptz),
          last_corroborated_at = $2::timestamptz,
          metadata = metadata || $3::jsonb,
          updated_at = NOW()
      WHERE id = $1
    `, [opportunityId, evidence.occurred_at, JSON.stringify({
      reopened_by: decision.actor || 'system',
      reopen_confidence: Number(decision.confidence),
      reopen_reason: decision.reason,
    })])
    await client.query('COMMIT')
    return true
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw error
  } finally {
    client.release()
  }
}

function evidenceKey(evidence = {}) {
  return `${evidence.source_table || ''}:${evidence.source_id || ''}`
}

function selectNewerRecurrenceEvidence(item, evidenceRows = [], seenEvidenceKeys = new Set()) {
  if (!item || !['actioned', 'dismissed', 'expired'].includes(item.status)) return null
  const terminalAt = new Date(item.terminal_at || 0).getTime()
  if (!Number.isFinite(terminalAt) || terminalAt <= 0) return null
  return evidenceRows
    .filter(evidence => evidence?.source_table === CANONICAL_ITEM_EVIDENCE_TABLE)
    .filter(evidence => !seenEvidenceKeys.has(evidenceKey(evidence)))
    .filter(evidence => {
      const occurredAt = new Date(evidence.occurred_at || 0).getTime()
      return Number.isFinite(occurredAt) && occurredAt > terminalAt
    })
    .sort((left, right) => new Date(right.occurred_at) - new Date(left.occurred_at))[0] || null
}

async function persistCanonicalItemEvidence(pool, opportunityId, evidenceRows = [], options = {}) {
  const evidence = []
  for (const row of evidenceRows || []) evidence.push(await validateCanonicalItemEvidence(pool, row))
  if (!evidence.length) throw new Error('An intelligence item requires canonical communication evidence')

  const { rows } = await pool.query(`
    SELECT id, status, lifecycle_state,
           COALESCE(actioned_at, dismissed_at, expires_at, updated_at, created_at) AS terminal_at
    FROM intelligence.opportunities
    WHERE id = $1
  `, [opportunityId])
  const item = rows[0]
  if (!item) throw new Error(`Intelligence item ${opportunityId} does not exist`)

  try {
    if (['actioned', 'dismissed', 'expired'].includes(item.status)) {
      if (!options.reopen?.reason) return { active: false, reopened: false, terminal: true }
      const existing = await pool.query(`
        SELECT source_table, source_id
        FROM intelligence.opportunity_evidence
        WHERE opportunity_id = $1
      `, [opportunityId])
      const seen = new Set(existing.rows.map(evidenceKey))
      const recurrenceEvidence = selectNewerRecurrenceEvidence(item, evidence, seen)
      if (!recurrenceEvidence) return { active: false, reopened: false, terminal: true }
      await reopenOpportunityFromContradictoryEvidence(pool, opportunityId, recurrenceEvidence, {
        actor: options.reopen.actor || 'system',
        confidence: options.reopen.confidence,
        reason: options.reopen.reason,
        kind: options.reopen.kind || 'recurrence',
      })
      seen.add(evidenceKey(recurrenceEvidence))
      for (const row of evidence) {
        if (!seen.has(evidenceKey(row))) await addEvidence(opportunityId, row, pool)
      }
      return { active: true, reopened: true, terminal: false }
    }

    for (const row of evidence) await addEvidence(opportunityId, row, pool)
    return { active: true, reopened: false, terminal: false }
  } catch (error) {
    await expireOpportunityAfterPersistenceFailure(pool, opportunityId, error)
    throw error
  }
}

async function persistOpportunityCandidate({
  input,
  evidence = [],
  contactIds = [],
  primaryContactId = null,
  projectId = null,
  projectRole = 'primary',
  reopen = null,
}) {
  // Validate before inserting the item so a malformed/noncanonical candidate
  // cannot leave an open row behind.
  for (const row of evidence) await validateCanonicalItemEvidence(db, row)
  if (!evidence.length) throw new Error('Candidate has no canonical communication evidence')

  const opportunityId = await upsertOpportunity(input)
  if (!opportunityId) return null
  try {
    const persisted = await persistCanonicalItemEvidence(db, opportunityId, evidence, { reopen })
    if (!persisted.active) return null
    if (projectId) await linkProject(opportunityId, projectId, projectRole)
    if (primaryContactId || contactIds.length) await linkContacts(opportunityId, contactIds, primaryContactId)
    return opportunityId
  } catch (error) {
    await expireOpportunityAfterPersistenceFailure(db, opportunityId, error)
    throw error
  }
}

async function upsertSignal(pool, signal) {
  if (!signal?.source_table || !signal?.source_id || !signal?.signal_type) return null
  const sourceId = String(signal.source_id)
  const canonicalContactId = await canonicalizeEntityId(pool, 'contact', signal.contact_id)
  const existing = await pool.query(`
    UPDATE intelligence.signals
    SET title = $1,
        description = $2,
        contact_id = COALESCE($3, contact_id),
        project_id = COALESCE($4, project_id),
        source_ref = COALESCE($5, source_ref),
        occurred_at = COALESCE($6, occurred_at),
        confidence = COALESCE($7, confidence),
        strength = COALESCE($8, strength),
        metadata = metadata || $9::jsonb,
        updated_at = NOW()
    WHERE source_table = $10 AND source_id = $11 AND signal_type = $12
    RETURNING id
  `, [
    signal.title || signal.signal_type,
    signal.description || signal.content || null,
    canonicalContactId || null,
    signal.project_id || null,
    signal.source_ref || null,
    signal.occurred_at || null,
    signal.confidence ?? null,
    signal.strength ?? null,
    JSON.stringify(signal.metadata || {}),
    signal.source_table,
    sourceId,
    signal.signal_type,
  ])
  if (existing.rows[0]?.id) return existing.rows[0].id

  const inserted = await pool.query(`
    INSERT INTO intelligence.signals (
      signal_type, title, description, contact_id, project_id,
      source_table, source_id, source_ref, occurred_at, confidence, strength, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    RETURNING id
  `, [
    signal.signal_type,
    signal.title || signal.signal_type,
    signal.description || signal.content || null,
    canonicalContactId || null,
    signal.project_id || null,
    signal.source_table,
    sourceId,
    signal.source_ref || null,
    signal.occurred_at || null,
    signal.confidence ?? null,
    signal.strength ?? null,
    JSON.stringify(signal.metadata || {}),
  ])
  return inserted.rows[0]?.id || null
}

async function upsertClaim(pool, claim) {
  if (!claim?.claim_key || !claim?.evidence) return null
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function' ? () => client.release() : () => {}
  try {
    await client.query('BEGIN')
    if (DIRECT_EVIDENCE_TABLES.has(claim.evidence.source_table)
      && !(await directEvidenceExists(client, claim.evidence.source_table, claim.evidence.source_id))) {
      throw new Error(`Claim evidence does not resolve: ${claim.evidence.source_table}:${claim.evidence.source_id}`)
    }
    const { rows } = await client.query(`
    INSERT INTO intelligence.claims (
      claim_key, claim_type, subject_type, subject_id, predicate,
      object_type, object_id, polarity, lifecycle_state, valid_from,
      valid_until, confidence, extractor_version, last_contradicted_at, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
      CASE WHEN $8 = 'negative' THEN COALESCE($10, NOW()) ELSE NULL END,
      $14::jsonb)
    ON CONFLICT (claim_key) DO UPDATE SET
      predicate = EXCLUDED.predicate,
      polarity = EXCLUDED.polarity,
      lifecycle_state = EXCLUDED.lifecycle_state,
      valid_from = COALESCE(EXCLUDED.valid_from, intelligence.claims.valid_from),
      valid_until = EXCLUDED.valid_until,
      confidence = GREATEST(COALESCE(intelligence.claims.confidence, 0), COALESCE(EXCLUDED.confidence, 0)),
      last_seen_at = NOW(),
      last_contradicted_at = CASE
        WHEN EXCLUDED.polarity = 'negative' THEN COALESCE(EXCLUDED.valid_from, NOW())
        ELSE intelligence.claims.last_contradicted_at
      END,
      metadata = intelligence.claims.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id
  `, [
    claim.claim_key,
    claim.claim_type || 'other',
    claim.subject_type || 'unknown',
    claim.subject_id || null,
    claim.predicate,
    claim.object_type || null,
    claim.object_id || null,
    claim.polarity || 'uncertain',
    claim.lifecycle_state || 'unknown',
    claim.valid_from || null,
    claim.valid_until || null,
    claim.confidence ?? null,
    claim.extractor_version || 'unknown',
    JSON.stringify(claim.metadata || {}),
  ])
    const claimId = rows[0]?.id
    if (!claimId) throw new Error('Claim upsert did not return an id')
    await client.query(`
    INSERT INTO intelligence.claim_evidence (
      claim_id, source_table, source_id, source_ref, occurred_at,
      quote, content_hash, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT (claim_id, source_table, source_id, content_hash) DO UPDATE SET
      source_ref = COALESCE(EXCLUDED.source_ref, intelligence.claim_evidence.source_ref),
      occurred_at = COALESCE(EXCLUDED.occurred_at, intelligence.claim_evidence.occurred_at),
      metadata = intelligence.claim_evidence.metadata || EXCLUDED.metadata
  `, [
    claimId,
    claim.evidence.source_table,
    String(claim.evidence.source_id),
    claim.evidence.source_ref || null,
    claim.evidence.occurred_at || null,
    claim.evidence.quote,
    claim.evidence.content_hash,
    JSON.stringify(claim.evidence.metadata || {}),
  ])
    await client.query('COMMIT')
    return claimId
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw error
  } finally {
    release()
  }
}

async function reconcileEvidenceLifecycle(pool, cutoff = new Date()) {
  const activated = await pool.query(`
    UPDATE intelligence.opportunities o
    SET lifecycle_state = 'active',
        first_corroborated_at = COALESCE(first_corroborated_at, NOW()),
        last_corroborated_at = COALESCE(last_corroborated_at, NOW()),
        updated_at = NOW()
    WHERE o.status = 'open'
      AND o.lifecycle_state = 'candidate'
      AND EXISTS (
        SELECT 1 FROM intelligence.opportunity_evidence e
        WHERE e.opportunity_id = o.id
          AND ${DIRECT_EVIDENCE_EXISTS_SQL}
      )
  `)
  const expired = await pool.query(`
    UPDATE intelligence.opportunities o
    SET status = 'expired', lifecycle_state = 'expired',
        expires_at = COALESCE(expires_at, NOW()),
        feedback_note = COALESCE(feedback_note, 'System-expired: no inspectable evidence'),
        metadata = metadata || $2::jsonb,
        updated_at = NOW()
    WHERE o.status = 'open'
      AND o.lifecycle_state IN ('active','candidate')
      AND o.created_at < $1
      AND NOT EXISTS (
        SELECT 1 FROM intelligence.opportunity_evidence e
        WHERE e.opportunity_id = o.id
          AND ${DIRECT_EVIDENCE_EXISTS_SQL}
      )
  `, [cutoff, JSON.stringify({
    lifecycle_reason: 'missing_inspectable_evidence',
    lifecycle_provenance: 'intelligence_evidence_reconciliation',
  })])
  return { activated: activated.rowCount || 0, expired_unsupported: expired.rowCount || 0 }
}

async function upsertOrganizationGraph(pool, extracted) {
  const orgIdByHash = new Map()
  let organizationCount = 0
  let contactLinkCount = 0
  let topicCount = 0

  for (const org of extracted.organizations || []) {
    const result = await pool.query(`
      INSERT INTO intelligence.organizations (name, domain, metadata)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (normalized_name) DO UPDATE SET
        domain = COALESCE(intelligence.organizations.domain, EXCLUDED.domain),
        metadata = intelligence.organizations.metadata || EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING id
    `, [org.name, org.domain || null, JSON.stringify({ source: org.source || 'extracted', source_ref: org.source_ref || null })])
    const orgId = result.rows[0]?.id
    if (orgId) {
      const canonicalOrgId = await canonicalizeEntityId(pool, 'organization', orgId)
      orgIdByHash.set(org.org_id_hash, canonicalOrgId || orgId)
      organizationCount++
    }
  }

  for (const link of extracted.contactLinks || []) {
    const orgId = orgIdByHash.get(link.org_id_hash)
    if (!orgId || !link.contact_id || !Number.isFinite(Number(link.contact_id))) continue
    const canonicalContactId = await canonicalizeEntityId(pool, 'contact', link.contact_id)
    const numericContactId = Number(canonicalContactId)
    const numericOrgId = Number(orgId)
    if (!Number.isFinite(numericContactId) || !Number.isFinite(numericOrgId)) continue
    await pool.query(`
      INSERT INTO intelligence.contact_organizations (contact_id, organization_id, role, relationship, confidence, source_ref)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (contact_id, organization_id, (COALESCE(relationship, 'other'))) DO UPDATE SET
        role = COALESCE(EXCLUDED.role, intelligence.contact_organizations.role),
        confidence = COALESCE(EXCLUDED.confidence, intelligence.contact_organizations.confidence),
        source_ref = COALESCE(EXCLUDED.source_ref, intelligence.contact_organizations.source_ref),
        updated_at = NOW()
    `, [numericContactId, numericOrgId, link.role || null, link.relationship || 'employee', link.confidence || null, link.source_ref || null])
    contactLinkCount++
  }

  for (const topic of extracted.topics || []) {
    if (!topic.name || !topic.object_id) continue
    const result = await pool.query(`
      INSERT INTO intelligence.topics (name, topic_type)
      VALUES ($1, $2)
      ON CONFLICT (normalized_name) DO UPDATE SET
        topic_type = COALESCE(intelligence.topics.topic_type, EXCLUDED.topic_type),
        updated_at = NOW()
      RETURNING id
    `, [topic.name, topic.topic_type || 'other'])
    const topicId = result.rows[0]?.id
    if (!topicId) continue
    await pool.query(`
      INSERT INTO intelligence.object_topics (topic_id, object_type, object_id, role, confidence, source_ref)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (topic_id, object_type, object_id, (COALESCE(role, 'mentioned'))) DO UPDATE SET
        confidence = COALESCE(EXCLUDED.confidence, intelligence.object_topics.confidence),
        source_ref = COALESCE(EXCLUDED.source_ref, intelligence.object_topics.source_ref)
    `, [topicId, topic.object_type, String(topic.object_id), topic.role || 'mentioned', topic.confidence || null, topic.source_ref || null])
    topicCount++
  }

  return { organizationCount, contactLinkCount, topicCount }
}

async function upsertAliases(pool, contacts, organizations) {
  const deduped = []
  const seen = new Set()
  for (const alias of extractAliases(contacts || [], organizations || [])) {
    if (!alias.entity_type || alias.entity_id == null || !alias.alias) continue
    const key = `${alias.entity_type}:${alias.entity_id}:${normalizeAlias(alias.alias)}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(alias)
  }

  if (!deduped.length) return { aliasCount: 0 }

  const result = await pool.query(`
    INSERT INTO intelligence.entity_aliases (entity_type, entity_id, alias, source, confidence)
    SELECT *
    FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[])
      AS incoming(entity_type, entity_id, alias, source, confidence)
    ON CONFLICT (entity_type, entity_id, normalized_alias) DO UPDATE SET
      source = COALESCE(EXCLUDED.source, intelligence.entity_aliases.source),
      confidence = COALESCE(EXCLUDED.confidence, intelligence.entity_aliases.confidence)
  `, [
    deduped.map(alias => alias.entity_type),
    deduped.map(alias => String(alias.entity_id)),
    deduped.map(alias => alias.alias),
    deduped.map(alias => alias.source || null),
    deduped.map(alias => alias.confidence ?? null),
  ])

  return { aliasCount: result.rowCount || 0 }
}

function computeExpectedValue(input = {}) {
  const priority = priorityScore(input.priority)
  const impact = Number(input.impact_score ?? priority.impact)
  const urgency = Number(input.urgency_score ?? priority.urgency)
  const relationship = Number(input.relationship_score ?? (input.primary_contact_id ? 60 : 45))
  const confidence = input.confidence == null ? 0.55 : Number(input.confidence)
  const actionability = input.recommended_next_action ? 70 : 50
  const evidence = Array.isArray(input.evidence) ? input.evidence.length : 1
  const evidencePenalty = evidence === 0 ? 20 : evidence === 1 ? 6 : 0
  const groupPenalty = input.opportunity_type === 'group_opportunity' && evidence < 2 ? 16 : 0
  return Math.max(0, Math.min(100, (
    impact * 0.28 + urgency * 0.22 + relationship * 0.18 + actionability * 0.17 + confidence * 100 * 0.15
  ) - evidencePenalty - groupPenalty)).toFixed(2)
}

async function upsertFromRelationshipInsight(insightId, contactId, insight) {
  if (!insightId || !RELATIONSHIP_INSIGHT_TYPES.has(insight.insight_type)) return null
  try {
    const contactIds = Array.isArray(insight.contact_ids) ? insight.contact_ids : []
    const sourceRef = sourceRefFromRelationshipInsight(insightId, insight)
    const canonicalCommunications = await resolveCanonicalCommunicationRefs(db, insight.source_refs || [])
    if (!canonicalCommunications.length) {
      // Legacy generated insights without inspectable canonical evidence are
      // preserved but retired so migration converges instead of retrying them
      // on every intelligence refresh.
      await db.query(`
        UPDATE relationships.insights
        SET is_dismissed = TRUE, updated_at = NOW()
        WHERE id = $1 AND COALESCE(is_dismissed, FALSE) = FALSE
      `, [insightId])
      return null
    }
    return persistOpportunityCandidate({
      input: {
        opportunity_type: relationshipOpportunityType(insight.insight_type, sourceRef),
        title: insight.title || 'Relationship opportunity',
        description: insight.description || null,
        priority: insight.priority || 'medium',
        source_system: 'relationships',
        source_ref: sourceRef,
        dedupe_key: dedupeKeyFor('relationships', sourceRef, insight.title),
        primary_contact_id: contactId || contactIds[0] || null,
        surfaced_insight_id: insightId,
        metadata: {
          relationship_insight_type: insight.insight_type,
          source_refs: insight.source_refs || [],
          derived_from_relationship_insight_id: insightId,
        },
      },
      evidence: canonicalCommunications.map(communication => ({
        source_table: 'relationships.communications',
        source_id: communication.id,
        source_ref: `relationships.communication:${communication.id}`,
        occurred_at: communication.occurred_at || insight.created_at || null,
        quote: communication.content_snippet || communication.subject || insight.description || null,
        relevance: 1,
        metadata: {
          relationship_insight_id: insightId,
          canonical_source_ref: communication.source_id,
          source_kind: communication.source,
        },
      })),
      contactIds,
      primaryContactId: contactId,
    })
  } catch (err) {
    console.error('[intelligence] relationship opportunity upsert failed:', err.message)
    throw err
  }
}

async function upsertFromProjectInsight(projectInsightId, projectId, insight) {
  if (!projectInsightId || !PROJECT_INSIGHT_TYPES.has(insight.insight_type)) return null
  try {
    const canonicalCommunications = await resolveCanonicalCommunicationRefs(db, insight.evidence_refs || [])
    if (!canonicalCommunications.length) {
      console.warn(`[intelligence] project insight ${projectInsightId} has no canonical communication evidence; not promoting`)
      return null
    }
    const sourceRef = sourceRefFromProjectInsight(projectInsightId)
    const dedupeKey = dedupeKeyFor('projects', sourceRef, insight.content)
    await db.query(`
      UPDATE intelligence.opportunities
      SET dedupe_key = $2, source_ref = $3, item_fingerprint = COALESCE(item_fingerprint, $4), updated_at = NOW()
      WHERE surfaced_project_insight_id = $1
        AND dedupe_key IS DISTINCT FROM $2
        AND NOT EXISTS (SELECT 1 FROM intelligence.opportunities existing WHERE existing.dedupe_key = $2)
    `, [projectInsightId, dedupeKey, sourceRef, insight.insight_fingerprint || stableHash(dedupeKey)])
    return persistOpportunityCandidate({
      input: {
        opportunity_type: projectOpportunityType(insight.insight_type),
        item_type: projectInsightItemType(insight.insight_type),
        title: insight.content?.slice(0, 100) || 'Project opportunity',
        description: insight.content || null,
        priority: insight.priority || 'medium',
        source_system: 'projects',
        source_ref: sourceRef,
        dedupe_key: dedupeKey,
        primary_project_id: projectId,
        surfaced_project_insight_id: projectInsightId,
        item_fingerprint: insight.insight_fingerprint || null,
        metadata: {
          project_insight_type: insight.insight_type,
          evidence_refs: insight.evidence_refs || [],
          derived_from_project_insight_id: projectInsightId,
        },
      },
      evidence: canonicalCommunications.map(communication => ({
        source_table: 'relationships.communications',
        source_id: communication.id,
        source_ref: `relationships.communication:${communication.id}`,
        occurred_at: communication.occurred_at || insight.evidence_occurred_at || null,
        quote: communication.content_snippet || communication.subject || insight.content || null,
        relevance: 1,
        metadata: {
          project_insight_id: projectInsightId,
          canonical_source_ref: communication.source_id,
          source_kind: communication.source,
        },
      })),
      projectId,
    })
  } catch (err) {
    console.error('[intelligence] project opportunity upsert failed:', err.message)
    throw err
  }
}

async function reconcileProjectItems(projectId, activeProjectInsightIds = []) {
  const activeIds = activeProjectInsightIds.map(Number).filter(Number.isFinite)
  const result = await db.query(`
    UPDATE intelligence.opportunities
    SET status = 'expired', lifecycle_state = 'expired', expires_at = COALESCE(expires_at, NOW()),
        feedback_note = COALESCE(feedback_note, 'Resolved: no longer supported by current project analysis'),
        last_contradicted_at = NOW(), updated_at = NOW()
    WHERE source_system = 'projects'
      AND primary_project_id = $1
      AND status = 'open'
      AND (COALESCE(array_length($2::bigint[], 1), 0) = 0 OR COALESCE(surfaced_project_insight_id = ANY($2::bigint[]), FALSE) = FALSE)
  `, [projectId, activeIds])
  return result.rowCount || 0
}

async function upsertFromGroupOpportunity(groupId, group, opportunity, index = 0) {
  if (!groupId || !opportunity) return null
  try {
    const canonicalCommunications = await resolveCanonicalCommunicationRefs(db, opportunity.evidence_refs || [])
    if (!canonicalCommunications.length) return null
    const sourceRef = sourceRefFromGroupOpportunity(groupId, opportunity, index)
    const title = opportunity.title || 'Group opportunity'
    const description = opportunity.description || null
    return persistOpportunityCandidate({
      input: {
        opportunity_type: 'group_opportunity',
        title,
        description,
        priority: opportunity.priority || 'medium',
        source_system: 'groups',
        source_ref: sourceRef,
        dedupe_key: dedupeKeyFor('groups', sourceRef, title),
        why_now: group?.last_activity_at ? `Group activity last seen at ${group.last_activity_at}` : null,
        metadata: {
          group_id: groupId,
          group_name: group?.name || null,
          wa_chat_id: group?.wa_chat_id || null,
          group_type: group?.group_type || null,
          my_role: group?.my_role || null,
          source: 'relationships.groups.opportunities',
          index,
        },
      },
      evidence: canonicalCommunications.map(communication => ({
        source_table: 'relationships.communications',
        source_id: communication.id,
        source_ref: `relationships.communication:${communication.id}`,
        occurred_at: communication.occurred_at || group?.last_activity_at || null,
        quote: communication.content_snippet || communication.subject || description || title,
        relevance: 0.9,
        metadata: { group_id: groupId, canonical_source_ref: communication.source_id },
      })),
    })
  } catch (err) {
    console.error('[intelligence] group opportunity upsert failed:', err.message)
    throw err
  }
}

async function upsertContactFact(pool, fact) {
  if (!fact?.contact_id || !fact?.fact_type || !fact?.fact) return null
  const contactId = await canonicalizeEntityId(pool, 'contact', fact.contact_id)
  if (!contactId) return null
  const params = [
    Number(contactId),
    fact.fact_type,
    fact.fact,
    fact.source || 'import',
    fact.source_ref || null,
    fact.confidence ?? 0.7,
    fact.sentiment || 'neutral',
    fact.occurred_at || null,
    JSON.stringify(fact.metadata || {}),
  ]
  const updated = await pool.query(`
    UPDATE relationships.contact_facts
    SET source = $4,
        confidence = GREATEST(COALESCE(confidence, 0), COALESCE($6, confidence)),
        sentiment = COALESCE($7, sentiment),
        occurred_at = COALESCE($8, occurred_at),
        last_seen_at = NOW(),
        metadata = metadata || $9::jsonb,
        updated_at = NOW()
    WHERE contact_id = $1
      AND fact_type = $2
      AND fact = $3
      AND COALESCE(source_ref, '') = COALESCE($5, '')
    RETURNING id
  `, params)
  if (updated.rows[0]?.id) return updated.rows[0].id
  const inserted = await pool.query(`
    INSERT INTO relationships.contact_facts (
      contact_id, fact_type, fact, source, source_ref, confidence, sentiment, occurred_at, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    RETURNING id
  `, params)
  return inserted.rows[0]?.id || null
}

async function upsertFromStaleEmailThread(thread) {
  if (!thread?.latest_action_email_id || !thread?.latest_action_canonical_communication_id) {
    throw new Error('Stale email candidate is missing canonical communication evidence')
  }
  const contactId = await resolveContactFromEmail(db, thread.latest_action_email_id)
  return persistOpportunityCandidate({
    input: {
      opportunity_type: 'email_response_gap',
      title: thread.title,
      description: thread.description,
      recommended_next_action: thread.recommended_next_action,
      why_now: thread.why_now,
      priority: thread.age_days >= 30 ? 'high' : 'medium',
      confidence: 0.82,
      impact_score: thread.age_days >= 30 ? 75 : 60,
      urgency_score: Math.min(90, 45 + Math.floor(thread.age_days / 2)),
      relationship_score: contactId ? 70 : 50,
      source_system: 'signals',
      source_ref: `email_thread:${thread.thread_key}`,
      dedupe_key: `email_thread:${thread.thread_key}`,
      primary_contact_id: contactId || null,
      metadata: {
        ...(thread.metadata || {}),
        raw_latest_email_id: thread.latest_email_id,
        raw_latest_action_email_id: thread.latest_action_email_id,
      },
    },
    evidence: [{
      source_table: 'relationships.communications',
      source_id: thread.latest_action_canonical_communication_id,
      source_ref: `relationships.communication:${thread.latest_action_canonical_communication_id}`,
      occurred_at: thread.latest_action_at || thread.latest_at || null,
      quote: thread.quote,
      relevance: 0.9,
      metadata: {
        thread_key: thread.thread_key,
        latest_email_id: thread.latest_email_id,
        pending_direction: thread.pending_direction,
        age_days: thread.age_days,
        canonical_source_ref: `email:${thread.latest_action_email_id}`,
      },
    }],
    contactIds: contactId ? [contactId] : [],
    primaryContactId: contactId,
    reopen: {
      kind: 'recurrence',
      confidence: 0.9,
      reason: 'Stale email thread recurred with a newer canonical action request',
    },
  })
}

async function runIntelligenceServices(pool, options = {}) {
  await ensureSchema(pool)
  const runStartedAt = options.started_at || new Date()
  const log = typeof options.log === 'function'
    ? options.log
    : (level, message, meta) => {
        const line = `[intelligence] ${message}`
        if (level === 'error') console.error(line, meta || '')
        else if (level === 'warn') console.warn(line, meta || '')
        else console.log(line, meta || '')
      }
  const stats = {
    relationship_insights_backfilled: 0,
    relationship_insights_not_promoted: 0,
    organizations_upserted: 0,
    contact_organization_links: 0,
    topic_links: 0,
    signals_recorded: 0,
    claims_recorded: 0,
    contacts_tiered: 0,
    contacts_with_next_touch: 0,
    dormancy_opportunities: 0,
    stale_email_threads_promoted: 0,
    cross_channel_project_opportunities: 0,
    relationship_open_loop_opportunities: 0,
    home_improvement_opportunities: 0,
    communication_events_backfilled: 0,
    relationship_facts_extracted: 0,
    archived_project_items_expired: 0,
  }
  log('info', 'Starting intelligence pipeline')

  try {
    // Preserve history while excluding items whose source was corrected from
    // a project into a topic, responsibility, or portfolio.
    const archivedProjectItems = await pool.query(`
      UPDATE intelligence.opportunities item
      SET status = 'expired', lifecycle_state = 'expired',
          expires_at = COALESCE(expires_at, NOW()),
          feedback_note = COALESCE(feedback_note, 'Source project was archived by the outcome-bearing catalog audit'),
          last_contradicted_at = COALESCE(last_contradicted_at, NOW()),
          updated_at = NOW()
      FROM projects.projects project
      WHERE item.primary_project_id = project.id
        AND project.is_archived = TRUE
        AND item.status = 'open'
      RETURNING item.id
    `)
    stats.archived_project_items_expired = archivedProjectItems.rowCount || 0

    // Step 1: Backfill existing insights into opportunities
    log('info', 'Backfilling relationships.insights')
    const insightsResult = await pool.query(`
      SELECT *
      FROM relationships.insights
      WHERE COALESCE(is_dismissed, FALSE) = FALSE
        AND COALESCE(is_actioned, FALSE) = FALSE
      ORDER BY created_at DESC
      LIMIT 5000
    `)
    log('info', 'Loaded relationship insights', { count: insightsResult.rows.length })
    let backfillCount = 0
    let rejectedRelationshipInsights = 0
    for (const insight of insightsResult.rows) {
      try {
        const opportunityId = await upsertFromRelationshipInsight(insight.id, insight.contact_id, insight)
        if (opportunityId) backfillCount++
        else rejectedRelationshipInsights++
      } catch (error) {
        log('error', `Failed to backfill insight ${insight.id}`, { error: error.message })
        throw error
      }
    }
    stats.relationship_insights_backfilled = backfillCount
    stats.relationship_insights_not_promoted = rejectedRelationshipInsights
    log('info', 'Backfilled relationship insights', { promoted: backfillCount, not_promoted: rejectedRelationshipInsights })

    // Step 2: Populate organization/topic graph from contacts, groups, and opportunities.
    log('info', 'Extracting organizations/topics')
    const contactsResult = await pool.query('SELECT * FROM relationships.contacts')
    const groupsResult = await pool.query('SELECT * FROM relationships.groups ORDER BY updated_at DESC NULLS LAST LIMIT 1000')
    const opportunitiesResult = await pool.query('SELECT * FROM intelligence.opportunities ORDER BY updated_at DESC LIMIT 2000')
    log('info', 'Loaded graph inputs', { contacts: contactsResult.rows.length, groups: groupsResult.rows.length, opportunities: opportunitiesResult.rows.length })
    const contactGraph = await extractOrganizations(contactsResult.rows, 'contacts')
    const groupGraph = await extractOrganizations(groupsResult.rows, 'groups')
    const opportunityGraph = await extractOrganizations(opportunitiesResult.rows, 'opportunities')
    log('info', 'Extracted graph candidates', {
      contact_orgs: contactGraph.organizations.length,
      group_orgs: groupGraph.organizations.length,
      opportunity_orgs: opportunityGraph.organizations.length,
      contact_links: contactGraph.contactLinks.length,
      topics: contactGraph.topics.length + groupGraph.topics.length + opportunityGraph.topics.length,
    })
    const graphStats = await upsertOrganizationGraph(pool, {
      organizations: [...contactGraph.organizations, ...groupGraph.organizations, ...opportunityGraph.organizations],
      contactLinks: contactGraph.contactLinks,
      topics: [...contactGraph.topics, ...groupGraph.topics, ...opportunityGraph.topics],
    })
    stats.organizations_upserted = graphStats.organizationCount
    stats.contact_organization_links = graphStats.contactLinkCount
    stats.topic_links = graphStats.topicCount
    log('info', 'Graph extraction complete', graphStats)

    // Step 2b: Extract entity aliases from contacts and organizations.
    log('info', 'Extracting entity aliases')
    const orgsForAliases = await pool.query('SELECT id, name FROM intelligence.organizations WHERE updated_at > NOW() - INTERVAL \'1 hour\'')
    const aliasStats = await upsertAliases(pool, contactsResult.rows, orgsForAliases.rows)
    stats.aliases_upserted = aliasStats.aliasCount
    log('info', 'Alias extraction complete', aliasStats)

    // Step 3: Extract durable weak signals from multiple sources.
    log('info', 'Extracting weak signals')
    const canonicalCommunicationsResult = await pool.query(`
      SELECT rc.id, rc.contact_id, rc.source, rc.source_id, rc.content_snippet,
             rc.subject, rc.occurred_at, rc.chat_id, rc.is_group, rc.group_name,
             rc.direction, rc.metadata, c.display_name
      FROM relationships.communications rc
      LEFT JOIN relationships.contacts c ON c.id = rc.contact_id
      WHERE (
          (rc.source = 'email' AND rc.occurred_at > NOW() - INTERVAL '120 days')
          OR (rc.source = 'whatsapp' AND rc.occurred_at > NOW() - INTERVAL '180 days')
          OR (rc.source = 'limitless' AND rc.occurred_at > NOW() - INTERVAL '45 days')
        )
        AND NULLIF(rc.content_snippet, '') IS NOT NULL
        AND COALESCE(rc.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
      ORDER BY rc.occurred_at DESC
      LIMIT 30000
    `)
    const canonicalRows = canonicalCommunicationsResult.rows.map(row => ({
      ...row,
      canonical_table: 'relationships.communications',
      from_address: row.metadata?.from_address || null,
      body_text: row.content_snippet,
      markdown: row.content_snippet,
      title: row.subject,
      date: row.occurred_at,
      start_time: row.occurred_at,
    }))
    const emailsResult = { rows: canonicalRows.filter(row => row.source === 'email') }
    const whatsappResult = { rows: canonicalRows.filter(row => row.source === 'whatsapp') }
    const lifelogResult = { rows: canonicalRows.filter(row => row.source === 'limitless') }
    log('info', 'Loaded canonical signal inputs', { canonical_emails: emailsResult.rows.length, canonical_whatsapp: whatsappResult.rows.length, canonical_lifelogs: lifelogResult.rows.length, groups: groupsResult.rows.length })

    const canonicalEmailsForThreadState = emailsResult.rows.map(row => ({
      id: String(row.source_id || '').replace(/^email:/, ''),
      canonical_communication_id: row.id,
      thread_id: row.metadata?.thread_id || null,
      subject: row.subject,
      body_text: row.content_snippet,
      from_address: row.metadata?.from_address || null,
      date: row.occurred_at,
    }))
    const staleThreads = detectStaleEmailThreads(canonicalEmailsForThreadState, { staleDays: 14 })
    log('info', 'Detected stale email thread candidates', { count: staleThreads.length })
    const activeEmailThreadRefs = new Set(staleThreads.map(thread => `email_thread:${thread.thread_key}`))
    const existingEmailThreads = await pool.query(`
      SELECT source_ref
      FROM intelligence.opportunities
      WHERE status = 'open'
        AND opportunity_type = 'email_response_gap'
        AND source_ref LIKE 'email_thread:%'
    `)
    const staleEmailThreadRefs = existingEmailThreads.rows
      .map(row => row.source_ref)
      .filter(ref => !activeEmailThreadRefs.has(ref))
    if (staleEmailThreadRefs.length) {
      await pool.query(`
        UPDATE intelligence.opportunities
        SET status = 'dismissed', lifecycle_state = 'dismissed',
            feedback = COALESCE(feedback, 'false_positive'),
            feedback_note = COALESCE(feedback_note, 'Auto-dismissed: stale-email detector no longer validates this thread'),
            dismissed_at = COALESCE(dismissed_at, NOW()),
            updated_at = NOW()
        WHERE source_ref = ANY($1::text[])
      `, [staleEmailThreadRefs])
    }
    let staleThreadCount = 0
    for (const thread of staleThreads) {
      try {
        const opportunityId = await upsertFromStaleEmailThread(thread)
        if (opportunityId) staleThreadCount++
      } catch (error) {
        log('error', 'Failed to promote stale email thread', { thread_key: thread.thread_key, error: error.message })
        throw error
      }
    }
    stats.stale_email_threads_promoted = staleThreadCount
    log('info', 'Stale email thread promotion complete', { count: staleThreadCount })

    log('info', 'Detecting cross-channel project signals')
    const projectsResult = await pool.query(`
      SELECT *
      FROM projects.projects
      WHERE NOT is_archived
        AND status IN ('active','stalled','on_hold','unknown')
      ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC NULLS LAST
      LIMIT 300
    `)
    const groupMessagesResult = { rows: whatsappResult.rows
      .filter(row => row.is_group)
      .map(row => ({
        chat_id: row.chat_id,
        ts: row.occurred_at,
        participant: row.metadata?.author_jid || null,
        body: row.content_snippet || row.subject || '',
        source_id: row.source_id,
        canonical_communication_id: row.id,
      })) }
    const directMessagesResult = { rows: whatsappResult.rows
      .filter(row => !row.is_group && row.contact_id)
      .map(row => ({
        contact_id: row.contact_id,
        display_name: row.display_name,
        chat_id: row.chat_id,
        ts: row.occurred_at,
        body: row.content_snippet || row.subject || '',
        source_id: row.source_id,
        canonical_communication_id: row.id,
        from_me: row.direction === 'outbound',
      })) }
    const relationshipDirectMessagesResult = directMessagesResult
    log('info', 'Loaded cross-channel inputs', {
      projects: projectsResult.rows.length,
      groups: groupsResult.rows.length,
      group_messages: groupMessagesResult.rows.length,
      direct_messages: directMessagesResult.rows.length,
      relationship_direct_messages: relationshipDirectMessagesResult.rows.length,
      contacts: contactsResult.rows.length,
    })
    const canonicalContactMapResult = await pool.query(`
      SELECT canonical_id, duplicate_ids
      FROM intelligence.duplicate_decisions
      WHERE entity_type = 'contact'
        AND action = 'confirmed'
        AND canonical_id IS NOT NULL
    `)
    const canonicalContactMap = {}
    for (const row of canonicalContactMapResult.rows) {
      const canonical = String(row.canonical_id)
      for (const id of row.duplicate_ids || []) canonicalContactMap[String(id)] = canonical
    }
    const crossChannel = detectCrossChannelProjectSignals({
      projects: projectsResult.rows,
      groups: groupsResult.rows,
      groupMessages: groupMessagesResult.rows,
      directMessages: directMessagesResult.rows,
      contacts: contactsResult.rows,
      canonicalContactMap,
    })
    log('info', 'Detected cross-channel project candidates', { count: crossChannel.length })
    const activeCrossChannelRefs = new Set(crossChannel.map(candidate => candidate.source_ref).filter(Boolean))
    const existingCrossChannel = await pool.query(`
      SELECT source_ref
      FROM intelligence.opportunities
      WHERE status = 'open'
        AND source_system = 'signals'
        AND (source_ref LIKE 'cross_channel_project:%' OR source_ref LIKE 'cross_channel_group_project:%')
    `)
    const staleCrossChannelRefs = existingCrossChannel.rows
      .map(row => row.source_ref)
      .filter(ref => !activeCrossChannelRefs.has(ref))
    if (staleCrossChannelRefs.length) {
      await pool.query(`
        UPDATE intelligence.opportunities
        SET status = 'dismissed', lifecycle_state = 'dismissed',
            feedback = COALESCE(feedback, 'false_positive'),
            feedback_note = COALESCE(feedback_note, 'Auto-dismissed: cross-channel detector no longer validates this group/direct/project match'),
            dismissed_at = COALESCE(dismissed_at, NOW()),
            updated_at = NOW()
        WHERE source_ref = ANY($1::text[])
      `, [staleCrossChannelRefs])
    }
    let crossChannelCount = 0
    for (const candidate of crossChannel) {
      try {
        const opportunityId = await persistOpportunityCandidate({
          input: candidate,
          evidence: candidate.evidence || [],
          contactIds: candidate.contact_ids || [],
          primaryContactId: candidate.primary_contact_id,
          projectId: candidate.primary_project_id,
        })
        if (!opportunityId) continue
        crossChannelCount++
      } catch (error) {
        log('error', 'Failed to promote cross-channel project signal', { source_ref: candidate.source_ref, error: error.message })
        throw error
      }
    }
    stats.cross_channel_project_opportunities = crossChannelCount
    const dismissedAdminCrossChannel = await pool.query(`
      UPDATE intelligence.opportunities
      SET status = 'dismissed', lifecycle_state = 'dismissed',
          feedback = COALESCE(feedback, 'too_low_value'),
          feedback_note = COALESCE(feedback_note, 'Auto-dismissed: visa/personal-needs cross-channel admin item is below strategic attention threshold'),
          dismissed_at = COALESCE(dismissed_at, NOW()),
          updated_at = NOW()
      WHERE status = 'open'
        AND source_system = 'signals'
        AND (source_ref LIKE 'cross_channel_project:%' OR source_ref LIKE 'cross_channel_group_project:%')
        AND (
          title ~* '(golden\\s+visa|personal\\s+needs|visa\\s+(application|documents?|process))'
          OR description ~* '(golden\\s+visa|personal\\s+needs|visa\\s+(application|documents?|process))'
          OR title ILIKE 'Family-office finance/compliance workflow:%'
          OR metadata->>'group_derived_project_label' = 'Family-office finance/compliance workflow'
        )
    `)
    if (dismissedAdminCrossChannel.rowCount) {
      log('info', 'Dismissed low-value admin cross-channel opportunities', { count: dismissedAdminCrossChannel.rowCount })
    }
    log('info', 'Cross-channel project promotion complete', { count: crossChannelCount })

    log('info', 'Detecting direct relationship open loops')
    const relationshipOpenLoops = detectRelationshipOpenLoops({ contacts: contactsResult.rows, directMessages: relationshipDirectMessagesResult.rows })
    log('info', 'Detected relationship open loop candidates', { count: relationshipOpenLoops.length })
    const activeOpenLoopRefs = new Set(relationshipOpenLoops.map(candidate => candidate.source_ref).filter(Boolean))
    const existingOpenLoops = await pool.query(`
      SELECT source_ref
      FROM intelligence.opportunities
      WHERE status = 'open'
        AND source_system = 'signals'
        AND source_ref LIKE 'relationship_open_loop:%'
    `)
    const staleOpenLoopRefs = existingOpenLoops.rows
      .map(row => row.source_ref)
      .filter(ref => !activeOpenLoopRefs.has(ref))
    if (staleOpenLoopRefs.length) {
      await pool.query(`
        UPDATE intelligence.opportunities
        SET status = 'dismissed', lifecycle_state = 'dismissed',
            feedback = COALESCE(feedback, 'false_positive'),
            feedback_note = COALESCE(feedback_note, 'Auto-dismissed: direct relationship open-loop detector no longer validates this item'),
            dismissed_at = COALESCE(dismissed_at, NOW()),
            updated_at = NOW()
        WHERE source_ref = ANY($1::text[])
      `, [staleOpenLoopRefs])
    }
    let relationshipOpenLoopCount = 0
    for (const candidate of relationshipOpenLoops) {
      try {
        const opportunityId = await persistOpportunityCandidate({
          input: candidate,
          evidence: candidate.evidence || [],
          contactIds: candidate.contact_ids || [],
          primaryContactId: candidate.primary_contact_id,
        })
        if (!opportunityId) continue
        relationshipOpenLoopCount++
      } catch (error) {
        log('error', 'Failed to promote relationship open loop', { source_ref: candidate.source_ref, error: error.message })
        throw error
      }
    }
    stats.relationship_open_loop_opportunities = relationshipOpenLoopCount
    log('info', 'Relationship open-loop promotion complete', { count: relationshipOpenLoopCount })

    log('info', 'Detecting home-improvement project opportunities')
    const homeImprovement = detectHomeImprovementOpportunities({ lifelogs: lifelogResult.rows, emails: emailsResult.rows })
    log('info', 'Detected home-improvement project candidates', { count: homeImprovement.length })
    const activeHomeImprovementRefs = new Set(homeImprovement.map(candidate => candidate.source_ref).filter(Boolean))
    const existingHomeImprovement = await pool.query(`
      SELECT source_ref
      FROM intelligence.opportunities
      WHERE status = 'open'
        AND source_system = 'signals'
        AND source_ref LIKE 'home_improvement_project:%'
    `)
    const staleHomeImprovementRefs = existingHomeImprovement.rows
      .map(row => row.source_ref)
      .filter(ref => !activeHomeImprovementRefs.has(ref))
    if (staleHomeImprovementRefs.length) {
      await pool.query(`
        UPDATE intelligence.opportunities
        SET status = 'dismissed', lifecycle_state = 'dismissed',
            feedback = COALESCE(feedback, 'false_positive'),
            feedback_note = COALESCE(feedback_note, 'Auto-dismissed: home-improvement detector no longer validates this item'),
            dismissed_at = COALESCE(dismissed_at, NOW()),
            updated_at = NOW()
        WHERE source_ref = ANY($1::text[])
      `, [staleHomeImprovementRefs])
    }
    let homeImprovementCount = 0
    for (const candidate of homeImprovement) {
      try {
        const opportunityId = await persistOpportunityCandidate({
          input: candidate,
          evidence: candidate.evidence || [],
          contactIds: candidate.contact_ids || [],
          primaryContactId: candidate.primary_contact_id,
        })
        if (!opportunityId) continue
        homeImprovementCount++
      } catch (error) {
        log('error', 'Failed to promote home-improvement project opportunity', { source_ref: candidate.source_ref, error: error.message })
        throw error
      }
    }
    stats.home_improvement_opportunities = homeImprovementCount
    log('info', 'Home-improvement project promotion complete', { count: homeImprovementCount })

    log('info', 'Backfilling communication events')
    const communicationEventStats = await backfillCommunicationEvents(pool, { days: 30, log })
    stats.communication_events_backfilled = communicationEventStats.inserted
    log('info', 'Communication event backfill complete', communicationEventStats)

    log('info', 'Extracting durable relationship facts')
    let relationshipFactCount = 0
    const factCandidates = []
    for (const dm of directMessagesResult.rows) {
      const facts = extractRelationshipFactsFromText(dm.body, {
        contact_id: dm.contact_id,
        source: 'whatsapp',
        source_ref: dm.source_id,
        occurred_at: dm.ts,
        metadata: { chat_id: dm.chat_id, direction: dm.from_me ? 'outbound' : 'inbound' },
      })
      factCandidates.push(...facts)
    }
    for (const email of emailsResult.rows.slice(0, 3000)) {
      const text = `${email.subject || ''}\n${email.content_snippet || ''}`
      const facts = extractRelationshipFactsFromText(text, {
        contact_id: email.contact_id,
        source: 'email',
        source_ref: email.source_id,
        occurred_at: email.occurred_at,
        metadata: { subject: email.subject || null, from_address: email.from_address || null },
      })
      factCandidates.push(...facts.filter(f => f.contact_id))
    }
    for (const lifelog of lifelogResult.rows.slice(0, 1000)) {
      const text = `${lifelog.subject || ''}\n${lifelog.content_snippet || ''}`
      const mentioned = inferContactMention(text, contactsResult.rows)
      if (!mentioned?.id) continue
      const facts = extractRelationshipFactsFromText(text, {
        contact_id: mentioned.id,
        source: 'limitless',
        source_ref: lifelog.source_id,
        occurred_at: lifelog.occurred_at,
        metadata: { title: lifelog.subject || null, inferred_contact_name: mentioned.display_name || null },
      })
      factCandidates.push(...facts)
    }
    log('info', 'Detected relationship fact candidates', { count: factCandidates.length })
    for (const fact of factCandidates) {
      try {
        const id = await upsertContactFact(pool, fact)
        if (id) relationshipFactCount++
      } catch (error) {
        log('error', 'Failed to upsert relationship fact', { fact_type: fact.fact_type, contact_id: fact.contact_id, error: error.message })
      }
    }
    stats.relationship_facts_extracted = relationshipFactCount
    log('info', 'Relationship fact extraction complete', { count: relationshipFactCount })

    const removedGeneratedSignals = await pool.query(`
      DELETE FROM intelligence.signals
      WHERE source_table IN ('opportunities', 'intelligence.opportunities')
      RETURNING id
    `)
    if (removedGeneratedSignals.rowCount) {
      log('info', 'Removed generated-opportunity feedback-loop signals', { count: removedGeneratedSignals.rowCount })
    }

    const signalInputs = [
      ...(await extractSignals(emailsResult.rows, 'email')),
      ...(await extractSignals(whatsappResult.rows, 'whatsapp')),
      ...(await extractSignals(lifelogResult.rows, 'limitless')),
    ]
    log('info', 'Extracted weak signal candidates', { count: signalInputs.length })
    let signalCount = 0
    for (const signal of signalInputs) {
      try {
        const signalId = await upsertSignal(pool, signal)
        if (signalId) {
          signal.id = signalId
          signalCount++
        }
      } catch (error) {
        log('error', 'Failed to record signal', { source_table: signal.source_table, source_id: signal.source_id, signal_type: signal.signal_type, error: error.message })
      }
    }
    stats.signals_recorded = signalCount
    log('info', 'Recorded/updated weak signals', { count: signalCount })

    // Regex signals are candidate routing only. Retire claims created by the
    // former keyword-to-claim shortcut; verified cluster claims are written in
    // promoteSignalClusters below.
    const supersededClaims = await pool.query(`
      UPDATE intelligence.claims
      SET lifecycle_state = 'unknown',
          metadata = metadata || '{"superseded_reason":"unverified_keyword_extractor"}'::jsonb,
          updated_at = NOW()
      WHERE extractor_version IS DISTINCT FROM 'signal-claim-verifier-v1'
        AND lifecycle_state = 'active'
    `)
    stats.unverified_claims_superseded = supersededClaims.rowCount || 0
    log('info', 'Retired unverified keyword claims', { count: stats.unverified_claims_superseded })

    // Step 3b: Promote only corroborated weak-signal clusters into attention-worthy opportunities.
    log('info', 'Clustering weak signals for promotion')
    const clusterStats = await promoteSignalClusters(pool)
    stats.signal_clusters_evaluated = clusterStats.evaluated
    stats.signal_clusters_promoted = clusterStats.promoted
    stats.signal_clusters_pruned = clusterStats.pruned
    log('info', 'Signal cluster promotion complete', clusterStats)

    // Step 4: Tier contacts and compute next-touch dates for dormancy/relationship intelligence.
    log('info', 'Tiering contacts')
    const tierStats = await tierContacts(pool)
    stats.contacts_tiered = tierStats.contacts_tiered
    stats.contacts_with_next_touch = tierStats.contacts_with_next_touch
    log('info', 'Contact tiering complete', tierStats)

    // Step 5: Check relationship dormancy using tier-aware thresholds.
    log('info', 'Checking dormancy')
    const dormantContactsResult = await pool.query(`
      SELECT contact.*,
             latest_communication.id AS canonical_communication_id,
             latest_communication.occurred_at AS canonical_communication_at
      FROM relationships.contacts contact
      LEFT JOIN LATERAL (
        SELECT communication.id, communication.occurred_at
        FROM relationships.communications communication
        WHERE communication.contact_id = contact.id
          AND COALESCE(communication.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
        ORDER BY communication.occurred_at DESC, communication.id DESC
        LIMIT 1
      ) latest_communication ON TRUE
    `)
    const dormantResult = await checkDormancy(dormantContactsResult.rows)
    log('info', 'Detected dormancy candidates', { count: dormantResult.length })
    const activeDormancyRefs = new Set(dormantResult.map(opp => `dormancy:${opp.contact_id}`))
    const existingDormancy = await pool.query(`
      SELECT source_ref
      FROM intelligence.opportunities
      WHERE status = 'open'
        AND source_system = 'signals'
        AND source_ref LIKE 'dormancy:%'
    `)
    const staleDormancyRefs = existingDormancy.rows
      .map(row => row.source_ref)
      .filter(ref => !activeDormancyRefs.has(ref))
    if (staleDormancyRefs.length) {
      await pool.query(`
        UPDATE intelligence.opportunities
        SET status = 'dismissed', lifecycle_state = 'dismissed',
            feedback = COALESCE(feedback, 'too_low_value'),
            feedback_note = COALESCE(feedback_note, 'Auto-dismissed: contact no longer has a strategic cadence obligation'),
            dismissed_at = COALESCE(dismissed_at, NOW()),
            updated_at = NOW()
        WHERE source_ref = ANY($1::text[])
      `, [staleDormancyRefs])
    }
    let dormancyCount = 0
    for (const opp of dormantResult) {
      try {
        const oppInput = {
          opportunity_type: 'check_in',
          source_system: 'signals',
          source_ref: `dormancy:${opp.contact_id}`,
          title: opp.title,
          description: opp.description,
          primary_contact_id: Number.isFinite(Number(opp.contact_id)) ? Number(opp.contact_id) : null,
          why_now: opp.why_now,
          confidence: 0.5,
          metadata: { source: 'dormancy', threshold_days: opp.threshold_days, days_since_contact: opp.days_since_contact },
        }
        const opportunityId = await persistOpportunityCandidate({
          input: oppInput,
          evidence: [{
            source_table: 'relationships.communications',
            source_id: opp.canonical_communication_id,
            source_ref: `relationships.communication:${opp.canonical_communication_id}`,
            occurred_at: opp.canonical_communication_at || opp.last_interaction_at || null,
            quote: opp.description || opp.title,
            relevance: 0.75,
            metadata: { detector: 'dormancy', threshold_days: opp.threshold_days, days_since_contact: opp.days_since_contact },
          }],
          contactIds: [opp.contact_id],
          primaryContactId: opp.contact_id,
          reopen: {
            kind: 'recurrence',
            confidence: 0.9,
            reason: 'Relationship became dormant again after a newer canonical interaction',
          },
        })
        if (!opportunityId) continue
        dormancyCount++
      } catch (error) {
        log('error', 'Failed to create dormancy check-in', { contact_id: opp.contact_id, error: error.message })
        throw error
      }
    }
    stats.dormancy_opportunities = dormancyCount
    log('info', 'Dormancy check complete', { count: dormancyCount })

    const evidenceLifecycleStats = await reconcileEvidenceLifecycle(pool, runStartedAt)
    stats.evidence_candidates_activated = evidenceLifecycleStats.activated
    stats.zero_evidence_items_expired = evidenceLifecycleStats.expired_unsupported
    log('info', 'Evidence lifecycle reconciliation complete', evidenceLifecycleStats)

    log('info', 'Pipeline complete', stats)
    return stats
  } catch (error) {
    log('error', 'Pipeline error', { error: error.message, stack: error.stack })
    throw error
  }
}

async function tierContacts(pool) {
  const { rows } = await pool.query(`
    WITH duplicate_members AS (
      SELECT d.canonical_id::bigint AS group_id,
             member.contact_id::bigint AS contact_id
      FROM intelligence.duplicate_decisions d
      CROSS JOIN LATERAL UNNEST(ARRAY[d.canonical_id] || COALESCE(d.duplicate_ids, ARRAY[]::text[])) member(contact_id)
      WHERE d.entity_type = 'contact'
        AND d.action = 'confirmed'
        AND d.canonical_id ~ '^[0-9]+$'
        AND member.contact_id ~ '^[0-9]+$'
    ), contact_groups AS (
      SELECT c.id AS contact_id, COALESCE(MIN(dm.group_id), c.id) AS group_id
      FROM relationships.contacts c
      LEFT JOIN duplicate_members dm ON dm.contact_id = c.id
      GROUP BY c.id
    ), communication_stats AS (
      SELECT contact_id, COUNT(*)::int AS comm_count, MAX(occurred_at) AS last_interaction_at
      FROM relationships.communications
      WHERE contact_id IS NOT NULL
      GROUP BY contact_id
    ), insight_stats AS (
      SELECT contact_id, COUNT(*)::int AS insight_count
      FROM relationships.insights
      WHERE contact_id IS NOT NULL AND COALESCE(is_dismissed, false) = false
      GROUP BY contact_id
    ), touch_stats AS (
      SELECT contact_id, MAX(touched_at) AS last_touch_at
      FROM relationships.contact_touches
      GROUP BY contact_id
    ), grouped_stats AS (
      SELECT cg.group_id,
             SUM(COALESCE(cs.comm_count, 0))::int AS comm_count,
             SUM(COALESCE(ins.insight_count, 0))::int AS insight_count,
             MAX(GREATEST(c2.last_interaction_at, cs.last_interaction_at, touch.last_touch_at)) AS effective_last_interaction_at
      FROM contact_groups cg
      JOIN relationships.contacts c2 ON c2.id = cg.contact_id
      LEFT JOIN communication_stats cs ON cs.contact_id = cg.contact_id
      LEFT JOIN insight_stats ins ON ins.contact_id = cg.contact_id
      LEFT JOIN touch_stats touch ON touch.contact_id = cg.contact_id
      GROUP BY cg.group_id
    )
    SELECT c.*,
           COALESCE(stats.effective_last_interaction_at, c.last_interaction_at) AS last_interaction_at,
           COALESCE(stats.comm_count, 0) AS comm_count,
           COALESCE(stats.insight_count, 0) AS insight_count
    FROM relationships.contacts c
    JOIN contact_groups cg ON cg.contact_id = c.id
    LEFT JOIN grouped_stats stats ON stats.group_id = cg.group_id
  `)

  const recommendations = recommendContactTiers(rows)
  if (!rows.length) return { contacts_tiered: 0, contacts_with_next_touch: 0 }

  const result = await pool.query(`
    UPDATE relationships.contacts contact
    SET relationship_tier = CASE WHEN COALESCE(contact.manual_overrides, '{}'::jsonb) ? 'relationship_tier' THEN contact.relationship_tier ELSE incoming.relationship_tier END,
        strategic_importance_score = CASE WHEN COALESCE(contact.manual_overrides, '{}'::jsonb) ? 'strategic_importance_score' THEN contact.strategic_importance_score ELSE incoming.strategic_importance_score END,
        preferred_cadence_days = CASE WHEN COALESCE(contact.manual_overrides, '{}'::jsonb) ? 'preferred_cadence_days' THEN contact.preferred_cadence_days ELSE incoming.preferred_cadence_days END,
        dormant_threshold_days = CASE WHEN COALESCE(contact.manual_overrides, '{}'::jsonb) ? 'dormant_threshold_days' THEN contact.dormant_threshold_days ELSE incoming.dormant_threshold_days END,
        next_suggested_touch_at = CASE WHEN COALESCE(contact.manual_overrides, '{}'::jsonb) ? 'next_suggested_touch_at' THEN contact.next_suggested_touch_at ELSE incoming.next_suggested_touch_at END,
        intro_sensitivity = CASE WHEN COALESCE(contact.manual_overrides, '{}'::jsonb) ? 'intro_sensitivity' THEN contact.intro_sensitivity ELSE incoming.intro_sensitivity END,
        updated_at = NOW()
    FROM UNNEST(
      $1::bigint[], $2::text[], $3::numeric[], $4::integer[],
      $5::integer[], $6::timestamptz[], $7::text[]
    ) AS incoming(
      id, relationship_tier, strategic_importance_score, preferred_cadence_days,
      dormant_threshold_days, next_suggested_touch_at, intro_sensitivity
    )
    WHERE contact.id = incoming.id
  `, [
    rows.map(contact => contact.id),
    recommendations.map(rec => rec.relationship_tier),
    recommendations.map(rec => rec.strategic_importance_score),
    recommendations.map(rec => rec.preferred_cadence_days),
    recommendations.map(rec => rec.dormant_threshold_days),
    recommendations.map(rec => rec.next_suggested_touch_at),
    recommendations.map(rec => rec.intro_sensitivity),
  ])

  return {
    contacts_tiered: result.rowCount || 0,
    contacts_with_next_touch: recommendations.filter(rec => rec.next_suggested_touch_at).length,
  }
}

async function promoteSignalClusters(pool) {
  const { rows } = await pool.query(`
    SELECT s.*,
           c.display_name AS contact_name,
           p.name AS project_name
    FROM intelligence.signals s
    LEFT JOIN relationships.contacts c ON c.id = s.contact_id
    LEFT JOIN projects.projects p ON p.id = s.project_id
    WHERE s.occurred_at > NOW() - INTERVAL '45 days'
      AND COALESCE((s.metadata->>'source') <> 'signal_cluster', true)
      AND s.source_table IS DISTINCT FROM 'intelligence.opportunities'
    ORDER BY s.occurred_at DESC NULLS LAST, s.updated_at DESC
    LIMIT 10000
  `)

  const clusters = buildSignalClusters(rows)
  const existing = await pool.query(`
    SELECT source_ref
    FROM intelligence.opportunities
    WHERE status = 'open'
      AND source_system = 'signals'
      AND source_ref LIKE 'signal_cluster:%'
  `)
  const { promotableClusters, staleSourceRefs } = clusterPromotionPlan(clusters, existing.rows.map(row => row.source_ref))

  let pruned = 0
  if (staleSourceRefs.length) {
    const result = await pool.query(`
      UPDATE intelligence.opportunities
      SET status = 'dismissed', lifecycle_state = 'dismissed',
          feedback = COALESCE(feedback, 'false_positive'),
          feedback_note = COALESCE(feedback_note, 'Auto-dismissed: cluster no longer meets promotion threshold'),
          dismissed_at = COALESCE(dismissed_at, NOW()),
          updated_at = NOW()
      WHERE status = 'open'
        AND source_system = 'signals'
        AND source_ref = ANY($1::text[])
    `, [staleSourceRefs])
    pruned = result.rowCount || 0
  }

  let promoted = 0
  let verifiedClaims = 0
  const verifiedRefs = new Set()
  const verificationErrors = []
  for (const cluster of promotableClusters.slice(0, DAILY_ATTENTION_LIMIT)) {
    try {
      const verification = await verifyCluster(cluster)
      if (!verification.promote) continue
      const opportunity = opportunityFromCluster(cluster)
      if (verification.title) opportunity.title = verification.title
      if (verification.description) opportunity.description = verification.description
      if (verification.recommended_next_action) opportunity.recommended_next_action = verification.recommended_next_action
      opportunity.detector_version = verification.verifier_version
      opportunity.metadata = { ...opportunity.metadata, verifier_version: verification.verifier_version }
      const verifiedEvidenceKeys = new Set(verification.claims.flatMap(claim => claim.evidence.map(item => item.ref)))
      opportunity.evidence = opportunity.evidence.filter(evidence => verifiedEvidenceKeys.has(`${evidence.source_table}:${evidence.source_id}`))
      if (!opportunity.evidence.length) continue
      const opportunityId = await persistOpportunityCandidate({
        input: opportunity,
        evidence: opportunity.evidence || [],
        contactIds: opportunity.primary_contact_id ? [opportunity.primary_contact_id] : [],
        primaryContactId: opportunity.primary_contact_id,
        projectId: opportunity.primary_project_id,
      })
      if (!opportunityId) continue
      const claimIds = new Set()
      for (const verified of verification.claims) {
        for (const evidence of verified.evidence) {
          const signal = evidence.signal
          const claimId = await upsertClaim(pool, {
            claim_key: stableHash(JSON.stringify({
              type: verified.claim_type,
              actor_type: verified.actor_type,
              actor_id: verified.actor_id,
              subject_type: verified.subject_type,
              subject_id: verified.subject_id,
              predicate: verified.predicate.toLowerCase(),
            })),
            claim_type: verified.claim_type,
            subject_type: verified.subject_type,
            subject_id: verified.subject_id,
            predicate: verified.predicate,
            polarity: verified.polarity,
            lifecycle_state: verified.lifecycle_state,
            valid_from: signal.occurred_at || null,
            confidence: cluster.max_confidence || 0.7,
            extractor_version: verification.verifier_version,
            metadata: {
              actor_type: verified.actor_type,
              actor_id: verified.actor_id,
              verifier_version: verification.verifier_version,
              cluster_key: cluster.cluster_key,
            },
            evidence: {
              source_table: signal.source_table,
              source_id: signal.source_id,
              source_ref: signal.source_ref || null,
              occurred_at: signal.occurred_at || null,
              quote: evidence.quote,
              content_hash: stableHash(evidence.quote),
              metadata: { verifier_version: verification.verifier_version, signal_id: signal.id },
            },
          })
          if (claimId) claimIds.add(claimId)
        }
      }
      for (const claimId of claimIds) {
        await pool.query(`
          INSERT INTO intelligence.item_claims (opportunity_id, claim_id, role)
          VALUES ($1,$2,'primary') ON CONFLICT DO NOTHING
        `, [opportunityId, claimId])
      }
      verifiedClaims += claimIds.size
      verifiedRefs.add(opportunity.source_ref)
      promoted++
    } catch (error) {
      console.error('[intelligence] signal cluster promotion failed:', cluster.cluster_key, error.message)
      verificationErrors.push(`${cluster.cluster_key}:${error.message}`)
    }
  }

  const rejectedExistingRefs = existing.rows
    .map(row => row.source_ref)
    .filter(ref => promotableClusters.some(cluster => `signal_cluster:${cluster.cluster_key}` === ref))
    .filter(ref => !verifiedRefs.has(ref))
  if (rejectedExistingRefs.length) {
    const rejected = await pool.query(`
      UPDATE intelligence.opportunities
      SET status = 'dismissed', lifecycle_state = 'dismissed',
          feedback = COALESCE(feedback, 'false_positive'),
          feedback_note = COALESCE(feedback_note, 'Auto-dismissed: schema verifier rejected keyword cluster'),
          dismissed_at = COALESCE(dismissed_at, NOW()), updated_at = NOW()
      WHERE status = 'open' AND source_ref = ANY($1::text[])
    `, [rejectedExistingRefs])
    pruned += rejected.rowCount || 0
  }
  if (verificationErrors.length) {
    throw new Error(`${verificationErrors.length} signal verification failure(s): ${verificationErrors.slice(0, 3).join('; ')}`)
  }

  return { evaluated: clusters.length, promoted, pruned, verified_claims: verifiedClaims }
}

async function resolveContactFromEmail(pool, emailId) {
  const result = await pool.query(`
    SELECT c.id
    FROM email.emails e
    LEFT JOIN relationships.email_senders s
      ON LOWER(s.parsed_email) = LOWER(REGEXP_REPLACE(COALESCE(e.from_address, ''), '^.*<([^>]+)>.*$', '\\1'))
      OR LOWER(s.raw_address) = LOWER(COALESCE(e.from_address, ''))
    LEFT JOIN relationships.contacts c
      ON c.id = s.contact_id
      OR LOWER(REGEXP_REPLACE(COALESCE(e.from_address, ''), '^.*<([^>]+)>.*$', '\\1')) = ANY(SELECT LOWER(x) FROM unnest(c.emails) AS x)
    WHERE e.id = $1
      AND c.id IS NOT NULL
    LIMIT 1
  `, [emailId])
  const contactId = result.rows[0]?.id || null
  return canonicalizeEntityId(pool, 'contact', contactId)
}

module.exports = {
  ensureSchema,
  CANONICAL_ITEM_EVIDENCE_TABLE,
  canonicalCommunicationReferenceCandidates,
  resolveCanonicalCommunicationRefs,
  validateCanonicalItemEvidence,
  selectNewerRecurrenceEvidence,
  persistCanonicalItemEvidence,
  upsertOpportunity,
  upsertClaim,
  upsertFromRelationshipInsight,
  upsertFromProjectInsight,
  reconcileProjectItems,
  upsertFromGroupOpportunity,
  relationshipOpportunityType,
  projectOpportunityType,
  deriveRecommendedNextAction,
  promoteSignalClusters,
  reconcileEvidenceLifecycle,
  reopenOpportunityFromContradictoryEvidence,
  wasOpportunityLinkRejected,
  tierContacts,
  upsertAliases,
  runIntelligenceServices,
  guidance,
}
