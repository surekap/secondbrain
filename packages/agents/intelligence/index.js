'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('@secondbrain/db')
const { extractSignals } = require('./services/signal-extractor')
const { checkDormancy } = require('./services/dormancy-monitor')

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

function sourceRefFromProjectInsight(projectId, insight) {
  return `projects.project_insights:${projectId}:${insight.insight_type || 'unknown'}:${stableHash(insight.content || '')}`
}

function sourceRefFromGroupOpportunity(groupId, opportunity, index = 0) {
  const title = opportunity?.title || 'Group opportunity'
  const description = opportunity?.description || ''
  return `relationships.groups:${groupId}:opportunity:${index}:${stableHash(`${title}:${description}`)}`
}

function dedupeKeyFor(sourceSystem, sourceRef, title) {
  return `${sourceSystem}:${sourceRef || stableHash(title)}`
}

async function upsertOpportunity(input) {
  await ensureSchema()
  const scores = priorityScore(input.priority)
  const dedupeKey = input.dedupe_key || dedupeKeyFor(input.source_system, input.source_ref, input.title)
  const recommendedNextAction = deriveRecommendedNextAction(input)

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
    recommendedNextAction || null,
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
    const existing = await db.query(`
      UPDATE intelligence.signals
      SET title = $1,
          description = $2,
          contact_id = COALESCE($3, contact_id),
          project_id = COALESCE($4, project_id),
          source_ref = COALESCE($5, source_ref),
          confidence = COALESCE($6, confidence),
          strength = COALESCE($7, strength),
          metadata = metadata || $8::jsonb,
          updated_at = NOW()
      WHERE source_table = 'intelligence.opportunities'
        AND source_id = $9
        AND signal_type = $10
      RETURNING id
    `, [
      input.title,
      input.description || null,
      input.primary_contact_id || null,
      input.primary_project_id || null,
      input.source_ref || null,
      input.confidence ?? null,
      input.expected_value_score ?? priorityScore(input.priority).expected,
      JSON.stringify({ opportunity_type: input.opportunity_type || 'other' }),
      String(opportunityId),
      signalType,
    ])
    if (existing.rows.length) return

    await db.query(`
      INSERT INTO intelligence.signals (
        signal_type, title, description, contact_id, project_id,
        source_table, source_id, source_ref, occurred_at, confidence, strength, metadata
      ) VALUES ($1, $2, $3, $4, $5, 'intelligence.opportunities', $6, $7, NOW(), $8, $9, $10::jsonb)
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
      occurred_at = COALESCE(EXCLUDED.occurred_at, intelligence.opportunity_evidence.occurred_at),
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
      occurred_at: insight.created_at || null,
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
    const sourceRef = sourceRefFromProjectInsight(projectId, insight)
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
      occurred_at: insight.created_at || null,
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

async function upsertFromGroupOpportunity(groupId, group, opportunity, index = 0) {
  if (!groupId || !opportunity) return null
  try {
    const sourceRef = sourceRefFromGroupOpportunity(groupId, opportunity, index)
    const title = opportunity.title || 'Group opportunity'
    const description = opportunity.description || null
    const opportunityId = await upsertOpportunity({
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
    })
    await addEvidence(opportunityId, {
      source_table: 'relationships.groups',
      source_id: groupId,
      source_ref: sourceRef,
      occurred_at: group?.last_activity_at || group?.analyzed_at || null,
      quote: description || title,
      relevance: 1,
      metadata: {
        group_name: group?.name || null,
        wa_chat_id: group?.wa_chat_id || null,
        opportunity,
      },
    })
    return opportunityId
  } catch (err) {
    console.error('[intelligence] group opportunity upsert failed:', err.message)
    return null
  }
}

async function runIntelligenceServices(pool) {
  console.log('[intelligence] Starting intelligence pipeline')

  try {
    // Step 1: Backfill existing insights into opportunities
    console.log('[intelligence] Backfilling relationships.insights...')
    const insightsResult = await pool.query('SELECT * FROM relationships.insights ORDER BY created_at DESC LIMIT 1000')
    let backfillCount = 0
    for (const insight of insightsResult.rows) {
      try {
        await upsertFromRelationshipInsight(insight.id, insight.contact_id, insight)
        backfillCount++
      } catch (error) {
        console.error(`[intelligence] Failed to backfill insight ${insight.id}:`, error.message)
      }
    }
    console.log(`[intelligence] Backfilled ${backfillCount} insights`)

    // Step 2: Extract organizations — skipped; requires schema columns not yet available
    // (org_id_hash / contact_organizations are not in the current schema)
    console.log('[intelligence] Organization extraction skipped (schema support pending)')
    const contactsResult = await pool.query('SELECT * FROM relationships.contacts')

    // Step 3: Extract signals from emails
    console.log('[intelligence] Extracting signals from emails...')
    const emailsResult = await pool.query('SELECT * FROM email.emails WHERE created_at > NOW() - INTERVAL \'30 days\' LIMIT 5000')
    const emailSignals = await extractSignals(emailsResult.rows, 'email')
    let signalCount = 0
    for (const signal of emailSignals) {
      try {
        const contactId = signal.contact_id || (await resolveContactFromEmail(pool, signal.source_id))
        if (contactId) {
          const oppInput = {
            opportunity_type: 'research_opportunity',
            source_system: 'email',
            source_ref: `${signal.source_table}:${signal.source_id}:${signal.signal_type}`,
            title: signal.signal_type,
            description: signal.content,
            primary_contact_id: contactId,
            metadata: { signal_type: signal.signal_type, ...signal.metadata },
          }
          await upsertOpportunity(oppInput)
          signalCount++
        }
      } catch (error) {
        console.error(`[intelligence] Failed to record signal:`, error.message)
      }
    }
    console.log(`[intelligence] Recorded ${signalCount} email signals`)

    // Step 4: Check dormancy
    console.log('[intelligence] Checking dormancy...')
    const dormantResult = await checkDormancy(contactsResult.rows)
    let dormancyCount = 0
    for (const opp of dormantResult) {
      try {
        const oppInput = {
          opportunity_type: 'check_in',
          source_system: 'signals',
          source_ref: `dormancy:${opp.contact_id}`,
          title: opp.title,
          description: opp.description,
          primary_contact_id: opp.contact_id,
          why_now: opp.why_now,
          metadata: {},
        }
        await upsertOpportunity(oppInput)
        dormancyCount++
      } catch (error) {
        console.error(`[intelligence] Failed to create dormancy check-in:`, error.message)
      }
    }
    console.log(`[intelligence] Dormancy check complete (${dormancyCount} check-ins)`)

    console.log('[intelligence] Pipeline complete')
  } catch (error) {
    console.error('[intelligence] Pipeline error:', error.message)
    throw error
  }
}

async function resolveContactFromEmail(pool, emailId) {
  const result = await pool.query('SELECT from_addr FROM email.emails WHERE id = $1', [emailId])
  return result.rows[0]?.from_addr || null
}

module.exports = {
  ensureSchema,
  upsertOpportunity,
  recordSignalForOpportunity,
  upsertFromRelationshipInsight,
  upsertFromProjectInsight,
  upsertFromGroupOpportunity,
  relationshipOpportunityType,
  projectOpportunityType,
  deriveRecommendedNextAction,
  runIntelligenceServices,
}
