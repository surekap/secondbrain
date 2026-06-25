'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const db = require('@secondbrain/db')
const { extractSignals } = require('./services/signal-extractor')
const { extractOrganizations } = require('./services/organization-extractor')
const { checkDormancy } = require('./services/dormancy-monitor')
const { buildSignalClusters, shouldPromoteCluster, opportunityFromCluster, clusterPromotionPlan } = require('./services/signal-clusterer')

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
  const expectedValueScore = input.expected_value_score ?? computeExpectedValue({ ...input, recommended_next_action: recommendedNextAction })

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
    input.expected_value_score ?? expectedValueScore,
    input.score_explanation || `Expected attention score from impact, urgency, relationship leverage, actionability, confidence, and evidence penalties.`,
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

async function upsertSignal(pool, signal) {
  if (!signal?.source_table || !signal?.source_id || !signal?.signal_type) return null
  const sourceId = String(signal.source_id)
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
    signal.contact_id || null,
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
    signal.contact_id || null,
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
      orgIdByHash.set(org.org_id_hash, orgId)
      organizationCount++
    }
  }

  for (const link of extracted.contactLinks || []) {
    const orgId = orgIdByHash.get(link.org_id_hash)
    if (!orgId || !link.contact_id || !Number.isFinite(Number(link.contact_id))) continue
    await pool.query(`
      INSERT INTO intelligence.contact_organizations (contact_id, organization_id, role, relationship, confidence, source_ref)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (contact_id, organization_id, (COALESCE(relationship, 'other'))) DO UPDATE SET
        role = COALESCE(EXCLUDED.role, intelligence.contact_organizations.role),
        confidence = COALESCE(EXCLUDED.confidence, intelligence.contact_organizations.confidence),
        source_ref = COALESCE(EXCLUDED.source_ref, intelligence.contact_organizations.source_ref),
        updated_at = NOW()
    `, [Number(link.contact_id), orgId, link.role || null, link.relationship || 'employee', link.confidence || null, link.source_ref || null])
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

async function runIntelligenceServices(pool, options = {}) {
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
    organizations_upserted: 0,
    contact_organization_links: 0,
    topic_links: 0,
    signals_recorded: 0,
    dormancy_opportunities: 0,
  }
  log('info', 'Starting intelligence pipeline')

  try {
    // Step 1: Backfill existing insights into opportunities
    log('info', 'Backfilling relationships.insights')
    const insightsResult = await pool.query('SELECT * FROM relationships.insights ORDER BY created_at DESC LIMIT 1000')
    log('info', 'Loaded relationship insights', { count: insightsResult.rows.length })
    let backfillCount = 0
    for (const insight of insightsResult.rows) {
      try {
        await upsertFromRelationshipInsight(insight.id, insight.contact_id, insight)
        backfillCount++
      } catch (error) {
        log('error', `Failed to backfill insight ${insight.id}`, { error: error.message })
      }
    }
    stats.relationship_insights_backfilled = backfillCount
    log('info', 'Backfilled relationship insights', { count: backfillCount })

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

    // Step 3: Extract durable weak signals from multiple sources.
    log('info', 'Extracting weak signals')
    const emailsResult = await pool.query('SELECT * FROM email.emails WHERE COALESCE(date, received_at, created_at) > NOW() - INTERVAL \'45 days\' ORDER BY COALESCE(date, received_at, created_at) DESC LIMIT 5000')
    const whatsappResult = await pool.query('SELECT * FROM public.messages WHERE ts > NOW() - INTERVAL \'45 days\' ORDER BY ts DESC LIMIT 5000')
    const lifelogResult = await pool.query('SELECT * FROM limitless.lifelogs WHERE COALESCE(start_time, created_at) > NOW() - INTERVAL \'45 days\' ORDER BY COALESCE(start_time, created_at) DESC LIMIT 2000')
    log('info', 'Loaded signal inputs', { emails: emailsResult.rows.length, whatsapp: whatsappResult.rows.length, lifelogs: lifelogResult.rows.length, groups: groupsResult.rows.length, opportunities: opportunitiesResult.rows.length })
    const signalInputs = [
      ...(await extractSignals(emailsResult.rows, 'email')),
      ...(await extractSignals(whatsappResult.rows, 'whatsapp')),
      ...(await extractSignals(lifelogResult.rows, 'limitless')),
      ...(await extractSignals(groupsResult.rows, 'groups')),
      ...(await extractSignals(opportunitiesResult.rows, 'opportunities')),
    ]
    log('info', 'Extracted weak signal candidates', { count: signalInputs.length })
    let signalCount = 0
    for (const signal of signalInputs) {
      try {
        if (!signal.contact_id && signal.source_table === 'email') {
          signal.contact_id = await resolveContactFromEmail(pool, signal.source_id)
        }
        await upsertSignal(pool, signal)
        signalCount++
      } catch (error) {
        log('error', 'Failed to record signal', { source_table: signal.source_table, source_id: signal.source_id, signal_type: signal.signal_type, error: error.message })
      }
    }
    stats.signals_recorded = signalCount
    log('info', 'Recorded/updated weak signals', { count: signalCount })

    // Step 3b: Promote only corroborated weak-signal clusters into attention-worthy opportunities.
    log('info', 'Clustering weak signals for promotion')
    const clusterStats = await promoteSignalClusters(pool)
    stats.signal_clusters_evaluated = clusterStats.evaluated
    stats.signal_clusters_promoted = clusterStats.promoted
    stats.signal_clusters_pruned = clusterStats.pruned
    log('info', 'Signal cluster promotion complete', clusterStats)

    // Step 4: Check relationship dormancy using tier-aware thresholds.
    log('info', 'Checking dormancy')
    const dormantResult = await checkDormancy(contactsResult.rows)
    log('info', 'Detected dormancy candidates', { count: dormantResult.length })
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
        await upsertOpportunity(oppInput)
        dormancyCount++
      } catch (error) {
        log('error', 'Failed to create dormancy check-in', { contact_id: opp.contact_id, error: error.message })
      }
    }
    stats.dormancy_opportunities = dormancyCount
    log('info', 'Dormancy check complete', { count: dormancyCount })

    log('info', 'Pipeline complete', stats)
    return stats
  } catch (error) {
    log('error', 'Pipeline error', { error: error.message, stack: error.stack })
    throw error
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
      SET status = 'dismissed',
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
  for (const cluster of promotableClusters.slice(0, 50)) {
    try {
      const opportunity = opportunityFromCluster(cluster)
      const opportunityId = await upsertOpportunity(opportunity)
      if (!opportunityId) continue
      if (opportunity.primary_contact_id) await linkContacts(opportunityId, [opportunity.primary_contact_id], opportunity.primary_contact_id)
      if (opportunity.primary_project_id) await linkProject(opportunityId, opportunity.primary_project_id)
      for (const evidence of opportunity.evidence || []) await addEvidence(opportunityId, evidence)
      promoted++
    } catch (error) {
      console.error('[intelligence] signal cluster promotion failed:', cluster.cluster_key, error.message)
    }
  }

  return { evaluated: clusters.length, promoted, pruned }
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
  return result.rows[0]?.id || null
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
  promoteSignalClusters,
  runIntelligenceServices,
}
