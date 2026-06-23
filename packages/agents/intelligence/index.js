'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('@secondbrain/db')

let schemaReady = false

async function ensureSchema() {
  if (schemaReady) return
  const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
  await db.query(sql)
  schemaReady = true
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
])

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

function signalTypeForOpportunity(opportunityType) {
  if (opportunityType === 'risk') return 'risk'
  if (opportunityType === 'check_in') return 'event'
  if (opportunityType === 'meeting_action' || opportunityType === 'follow_up') return 'intent'
  if (opportunityType === 'project_match' || opportunityType === 'introduction') return 'capability'
  if (opportunityType && opportunityType.includes('opportunity')) return 'need'
  return 'other'
}

function sourceRefFromRelationshipInsight(insightId, insight) {
  return insight.source_ref || `relationships.insights:${insightId}`
}

function dedupeKeyFor(sourceSystem, sourceRef, title) {
  return `${sourceSystem}:${sourceRef || stableHash(title)}`
}

async function upsertOpportunity(input) {
  await ensureSchema()
  const scores = priorityScore(input.priority)
  const dedupeKey = input.dedupe_key || dedupeKeyFor(input.source_system, input.source_ref, input.title)

  const { rows } = await db.query(`
    INSERT INTO intelligence.opportunities (
      opportunity_type, title, description, recommended_next_action, why_now,
      status, priority, confidence, impact_score, urgency_score, relationship_score,
      expected_value_score, score_explanation, source_system, source_ref, source_hash,
      dedupe_key, primary_contact_id, primary_project_id, surfaced_insight_id,
      surfaced_project_insight_id, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      'open', $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19,
      $20, $21::jsonb
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
      primary_contact_id = COALESCE(EXCLUDED.primary_contact_id, intelligence.opportunities.primary_contact_id),
      primary_project_id = COALESCE(EXCLUDED.primary_project_id, intelligence.opportunities.primary_project_id),
      surfaced_insight_id = COALESCE(EXCLUDED.surfaced_insight_id, intelligence.opportunities.surfaced_insight_id),
      surfaced_project_insight_id = COALESCE(EXCLUDED.surfaced_project_insight_id, intelligence.opportunities.surfaced_project_insight_id),
      metadata = intelligence.opportunities.metadata || EXCLUDED.metadata,
      last_seen_at = NOW(),
      updated_at = NOW()
    RETURNING id
  `, [
    input.opportunity_type || 'other',
    input.title,
    input.description || null,
    input.recommended_next_action || null,
    input.why_now || null,
    input.priority || 'medium',
    input.confidence ?? null,
    input.impact_score ?? scores.impact,
    input.urgency_score ?? scores.urgency,
    input.relationship_score ?? null,
    input.expected_value_score ?? scores.expected,
    input.score_explanation || `Initial score derived from ${input.priority || 'medium'} priority until richer scoring is available.`,
    input.source_system || 'relationships',
    input.source_ref || null,
    input.source_hash || stableHash(`${input.source_system}:${input.source_ref}:${input.title}:${input.description || ''}`),
    dedupeKey,
    input.primary_contact_id || null,
    input.primary_project_id || null,
    input.surfaced_insight_id || null,
    input.surfaced_project_insight_id || null,
    JSON.stringify(input.metadata || {}),
  ])

  const opportunityId = rows[0]?.id || null
  await recordSignalForOpportunity(opportunityId, input)
  return opportunityId
}

async function recordSignalForOpportunity(opportunityId, input) {
  if (!opportunityId) return
  try {
    const signalType = signalTypeForOpportunity(input.opportunity_type)
    await db.query(`
      INSERT INTO intelligence.signals (
        signal_type, title, description, contact_id, project_id,
        source_table, source_id, source_ref, occurred_at, confidence, strength, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'intelligence.opportunities', $6, $7, NOW(), $8, $9, $10::jsonb)
      ON CONFLICT (source_table, source_id, signal_type) WHERE source_table IS NOT NULL AND source_id IS NOT NULL DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        contact_id = COALESCE(EXCLUDED.contact_id, intelligence.signals.contact_id),
        project_id = COALESCE(EXCLUDED.project_id, intelligence.signals.project_id),
        confidence = COALESCE(EXCLUDED.confidence, intelligence.signals.confidence),
        strength = COALESCE(EXCLUDED.strength, intelligence.signals.strength),
        metadata = intelligence.signals.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `, [
      signalType,
      input.title,
      input.description || null,
      input.primary_contact_id || null,
      input.primary_project_id || null,
      opportunityId,
      input.source_ref || null,
      input.confidence ?? null,
      input.expected_value_score ?? priorityScore(input.priority).expected,
      JSON.stringify({ opportunity_type: input.opportunity_type || 'other' }),
    ])
  } catch (err) {
    console.error('[intelligence] signal upsert failed:', err.message)
  }
}

async function linkContacts(opportunityId, contactIds, primaryContactId) {
  const unique = Array.from(new Set((contactIds || []).filter(Boolean).map(id => Number(id)).filter(Number.isFinite)))
  if (primaryContactId && !unique.includes(Number(primaryContactId))) unique.unshift(Number(primaryContactId))
  for (const contactId of unique) {
    await db.query(`
      INSERT INTO intelligence.opportunity_contacts (opportunity_id, contact_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `, [opportunityId, contactId, contactId === Number(primaryContactId) ? 'primary' : 'mentioned'])
  }
}

async function linkProject(opportunityId, projectId, role = 'primary') {
  if (!projectId) return
  await db.query(`
    INSERT INTO intelligence.opportunity_projects (opportunity_id, project_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
  `, [opportunityId, projectId, role])
}

async function addEvidence(opportunityId, evidence) {
  if (!evidence?.source_table || !evidence?.source_id) return
  await db.query(`
    INSERT INTO intelligence.opportunity_evidence (
      opportunity_id, source_table, source_id, source_ref, occurred_at, quote, relevance, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (opportunity_id, source_table, source_id) DO UPDATE SET
      source_ref = COALESCE(EXCLUDED.source_ref, intelligence.opportunity_evidence.source_ref),
      quote = COALESCE(EXCLUDED.quote, intelligence.opportunity_evidence.quote),
      relevance = COALESCE(EXCLUDED.relevance, intelligence.opportunity_evidence.relevance),
      metadata = intelligence.opportunity_evidence.metadata || EXCLUDED.metadata
  `, [
    opportunityId,
    evidence.source_table,
    String(evidence.source_id),
    evidence.source_ref || null,
    evidence.occurred_at || null,
    evidence.quote || null,
    evidence.relevance ?? null,
    JSON.stringify(evidence.metadata || {}),
  ])
}

async function upsertFromRelationshipInsight(insightId, contactId, insight) {
  if (!insightId || !RELATIONSHIP_INSIGHT_TYPES.has(insight.insight_type)) return null
  try {
    const contactIds = Array.isArray(insight.contact_ids) ? insight.contact_ids : []
    const sourceRef = sourceRefFromRelationshipInsight(insightId, insight)
    const opportunityId = await upsertOpportunity({
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
      },
    })
    await linkContacts(opportunityId, contactIds, contactId)
    await addEvidence(opportunityId, {
      source_table: 'relationships.insights',
      source_id: insightId,
      source_ref: sourceRef,
      quote: insight.description || null,
      relevance: 1,
      metadata: { title: insight.title, insight_type: insight.insight_type },
    })
    return opportunityId
  } catch (err) {
    console.error('[intelligence] relationship opportunity upsert failed:', err.message)
    return null
  }
}

async function upsertFromProjectInsight(projectInsightId, projectId, insight) {
  if (!projectInsightId || !PROJECT_INSIGHT_TYPES.has(insight.insight_type)) return null
  try {
    const sourceRef = `projects.project_insights:${projectInsightId}`
    const opportunityId = await upsertOpportunity({
      opportunity_type: projectOpportunityType(insight.insight_type),
      title: insight.content?.slice(0, 100) || 'Project opportunity',
      description: insight.content || null,
      priority: insight.priority || 'medium',
      source_system: 'projects',
      source_ref: sourceRef,
      dedupe_key: dedupeKeyFor('projects', sourceRef, insight.content),
      primary_project_id: projectId,
      surfaced_project_insight_id: projectInsightId,
      metadata: { project_insight_type: insight.insight_type },
    })
    await linkProject(opportunityId, projectId)
    await addEvidence(opportunityId, {
      source_table: 'projects.project_insights',
      source_id: projectInsightId,
      source_ref: sourceRef,
      quote: insight.content || null,
      relevance: 1,
      metadata: { insight_type: insight.insight_type },
    })
    return opportunityId
  } catch (err) {
    console.error('[intelligence] project opportunity upsert failed:', err.message)
    return null
  }
}

module.exports = {
  ensureSchema,
  upsertOpportunity,
  recordSignalForOpportunity,
  upsertFromRelationshipInsight,
  upsertFromProjectInsight,
  relationshipOpportunityType,
  projectOpportunityType,
}
