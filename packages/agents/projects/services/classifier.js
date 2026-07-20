'use strict'

const crypto = require('crypto')
const llm = require('../../shared/llm')
const db = require('@secondbrain/db')

const CLASSIFIER_VERSION = 'project-canonical-episode-v3'
const MIN_RELEVANCE = 0.7
const PROJECT_ANCHOR_STOPWORDS = new Set([
  'active', 'business', 'development', 'family', 'hartex', 'implementation',
  'initiative', 'planning', 'project', 'strategy',
])

function parseJSON(text) {
  const clean = String(text || '').replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    const firstBracket = clean.indexOf('[')
    const lastBrace = clean.lastIndexOf('}')
    if (firstBracket === -1 || lastBrace < firstBracket) throw new Error('No JSON classification objects found')
    return JSON.parse(`${clean.slice(firstBracket, lastBrace + 1)}\n]`)
  }
}

function matchEnvelopeFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Classifier did not return a match envelope')
  }
  if (!Array.isArray(payload.matches)) throw new Error('Classifier did not return a matches array')
  return payload
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function compact(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function projectAnchorTerms(project) {
  const text = String(project?.name || '').toLowerCase()
  return [...new Set((text.match(/[a-z]{3,}/g) || []).filter(term => !PROJECT_ANCHOR_STOPWORDS.has(term)))]
}

function hasProjectAnchor(item, projects) {
  const text = `${item?.subject || ''} ${item?.snippet || ''}`.toLowerCase()
  return projects.some(project => projectAnchorTerms(project).some(term => text.includes(term)))
}

function projectCatalogHash(projects = []) {
  return hash(projects
    .map(project => `${project.id}:${project.name}`)
    .sort()
    .join('|'))
}

function contentHash(item) {
  return hash(`${item.subject || ''}\n${item.snippet || ''}`)
}

function pendingPage(items, decidedKeys = new Set(), limit = 1000) {
  return items
    .filter(item => !decidedKeys.has(`${item.source_id}:${item.content_hash || contentHash(item)}`))
    .slice(0, limit)
}

function whatsappEpisodeId(chatId, occurredAt, authorId = 'unknown') {
  const date = new Date(occurredAt)
  if (Number.isNaN(date.getTime())) throw new Error('WhatsApp episode requires a valid occurrence time')
  return `whatsapp:${chatId}:${date.toISOString().slice(0, 10)}:${authorId || 'unknown'}`
}

function normalizeDecision(raw, allowedProjectIds) {
  const projectId = raw.project_id == null ? null : Number(raw.project_id)
  const relevance = Number(raw.relevance)
  const validProject = Number.isFinite(projectId) && allowedProjectIds.has(projectId)
  const relevanceScore = Number.isFinite(relevance) ? Math.max(0, Math.min(1, relevance)) : 0
  const matched = validProject && relevanceScore >= MIN_RELEVANCE
  return {
    source_id: String(raw.id),
    project_id: matched ? projectId : null,
    relevance_score: relevanceScore,
    decision: matched ? 'matched' : 'no_match',
    rationale: compact(raw.rationale || raw.reason || (matched ? 'Clear project match' : 'No sufficiently strong project match'), 500),
  }
}

function classificationBatchId(items) {
  return hash(items.map(item => `${item.source_id}:${item.content_hash || contentHash(item)}`).join('|')).slice(0, 24)
}

function validateBatchResponse(parsed, items, expectedBatchId = classificationBatchId(items)) {
  const envelope = matchEnvelopeFromPayload(parsed)
  if (envelope.batch_id !== expectedBatchId) throw new Error('Classifier returned the wrong batch receipt')
  const expectedIds = new Set(items.map(item => String(item.source_id)))
  const byId = new Map()
  for (const result of envelope.matches) {
    const id = String(result?.id ?? '')
    if (!expectedIds.has(id)) {
      console.warn(`[classifier] dropping positive match for unknown episode: ${id || '(missing id)'}`)
      continue
    }
    const previous = byId.get(id)
    if (!previous || Number(result.relevance || 0) > Number(previous.relevance || 0)) byId.set(id, result)
  }
  return byId
}

/** Classify every episode; omitted sparse matches become durable no-match decisions. */
async function classifyBatch(items, projects) {
  if (!items.length || !projects.length) return []
  const projectList = projects.map(project =>
    `  id=${project.id}, name="${project.name}", outcome="${compact(project.description || '', 120)}", keywords=[${(project.keywords || []).join(', ')}]`
  ).join('\n')
  const commList = items.map(item =>
    `  id="${item.source_id}", source=${item.source}, date=${item.date || ''}, ${item.subject ? `subject="${compact(item.subject, 120)}", ` : ''}snippet="${compact(item.snippet, 500)}"`
  ).join('\n')
  const batchId = classificationBatchId(items)
  const prompt = `Classify each communication episode into one outcome-bearing project, or no match.

A project must have an intended outcome and lifecycle. A broad interest, recurring channel, person, or theme is not a project. Be precision-first: null is correct unless evidence clearly concerns delivery, a decision, or progress toward a listed outcome.

Projects:
${projectList}

Communication episodes:
${commList}

Return this batch receipt and only clear positive matches as JSON:
{"batch_id":"${batchId}","matches":[{"id":"source_id","project_id":N,"relevance":0.7_to_1.0,"rationale":"brief evidence-based reason"}]}

Omit an episode from matches when no listed project clears relevance 0.7. Do not emit null/no-match rows. The batch_id must be copied exactly. Return only JSON.`

  let byId = null
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await llm.create('projects', {
        profile: 'bulk_structured',
        task_type: 'project_episode_classification_json',
        workflow_name: 'project_classification',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
      })
      byId = validateBatchResponse(parseJSON(response.text || ''), items, batchId)
      break
    } catch (error) {
      lastError = error
      console.warn(`[classifier] malformed batch response (attempt ${attempt}/3): ${error.message}`)
    }
  }
  if (!byId) throw lastError || new Error('Classifier batch failed without a response')
  const allowedProjectIds = new Set(projects.map(project => Number(project.id)))
  return items.map(item => normalizeDecision(
    byId.get(String(item.source_id)) || {
      id: item.source_id,
      project_id: null,
      relevance: 0,
      rationale: 'No outcome-bearing project match returned by the batch verifier',
    },
    allowedProjectIds,
  ))
}

async function priorDecisions(source, items, catalogHash) {
  if (!items.length) return new Set()
  const episodeIds = items.map(item => item.source_id)
  const hashes = items.map(item => item.content_hash)
  const { rows } = await db.query(`
    SELECT episode_id, content_hash
    FROM projects.communication_classifications
    WHERE source = $1
      AND project_catalog_hash = $2
      AND classifier_version = $3
      AND is_current = TRUE
      AND (episode_id, content_hash) IN (SELECT * FROM UNNEST($4::text[], $5::text[]))
  `, [source, catalogHash, CLASSIFIER_VERSION, episodeIds, hashes])
  return new Set(rows.map(row => `${row.episode_id}:${row.content_hash}`))
}

async function persistDecision(decision, item, source, catalogHash) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      UPDATE projects.communication_classifications
      SET is_current = FALSE, updated_at = NOW()
      WHERE source = $1 AND episode_id = $2 AND is_current = TRUE
    `, [source, item.source_id])
    const inserted = await client.query(`
      INSERT INTO projects.communication_classifications (
        source, episode_id, content_hash, project_catalog_hash, classifier_version,
        decision, project_id, contact_id, relevance_score, rationale, is_current, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11::jsonb)
      ON CONFLICT (source, episode_id, content_hash, project_catalog_hash, classifier_version)
      DO UPDATE SET
        decision = EXCLUDED.decision,
        project_id = EXCLUDED.project_id,
        contact_id = EXCLUDED.contact_id,
        relevance_score = EXCLUDED.relevance_score,
        rationale = EXCLUDED.rationale,
        metadata = EXCLUDED.metadata,
        is_current = TRUE,
        updated_at = NOW()
      RETURNING id
    `, [
      source,
      item.source_id,
      item.content_hash,
      catalogHash,
      CLASSIFIER_VERSION,
      decision.decision,
      decision.project_id,
      item.contact_id || null,
      decision.relevance_score,
      decision.rationale,
      JSON.stringify({ subject: item.subject || null, canonical_source_refs: item.source_refs || [item.source_id] }),
    ])
    const decisionId = inserted.rows[0].id

    // Reconciliation is self-correcting: the current decision replaces stale
    // derived links but never edits raw communications.
    const removed = await client.query(`
      DELETE FROM projects.project_communications
      WHERE source = $1 AND COALESCE(episode_id, source_id) = $2
        AND ($3::bigint IS NULL OR project_id <> $3)
      RETURNING project_id
    `, [source, item.source_id, decision.project_id])
    if (decision.project_id) {
      await client.query(`
        INSERT INTO projects.project_communications (
          project_id, source, source_id, episode_id, contact_id, content_snippet,
          subject, occurred_at, relevance_score, content_hash, classification_decision_id
        ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (project_id, source, source_id) DO UPDATE SET
          contact_id = COALESCE(EXCLUDED.contact_id, projects.project_communications.contact_id),
          content_snippet = EXCLUDED.content_snippet,
          subject = EXCLUDED.subject,
          occurred_at = EXCLUDED.occurred_at,
          relevance_score = EXCLUDED.relevance_score,
          content_hash = EXCLUDED.content_hash,
          classification_decision_id = EXCLUDED.classification_decision_id,
          updated_at = NOW()
      `, [
        decision.project_id,
        source,
        item.source_id,
        item.contact_id || null,
        compact(item.snippet, 1000),
        item.subject || null,
        item.occurred_at || null,
        decision.relevance_score,
        item.content_hash,
        decisionId,
      ])
    }
    const affectedProjectIds = [...new Set([
      ...removed.rows.map(row => Number(row.project_id)),
      decision.project_id == null ? null : Number(decision.project_id),
    ].filter(Number.isFinite))]
    if (affectedProjectIds.length) {
      await client.query(`
        UPDATE projects.projects
        SET updated_at = NOW()
        WHERE id = ANY($1::bigint[])
      `, [affectedProjectIds])
    }
    await client.query('COMMIT')
    return decision.project_id ? 1 : 0
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function classifyItems(items, projects, source) {
  if (!items.length || !projects.length) return 0
  const catalogHash = projectCatalogHash(projects)
  for (const item of items) item.content_hash = contentHash(item)
  const seen = await priorDecisions(source, items, catalogHash)
  const pending = pendingPage(items, seen, items.length)
  let matched = 0
  // Email subjects/bodies normally repeat a stable project anchor. A measured
  // negative prefilter avoids asking the model to narrate obvious non-project
  // mail. Meeting transcripts and WhatsApp remain fully semantic because they
  // often refer to projects indirectly.
  const semanticPending = source === 'email'
    ? pending.filter(item => hasProjectAnchor(item, projects))
    : pending
  if (source === 'email') {
    const deterministicNegatives = pending.filter(item => !hasProjectAnchor(item, projects))
    for (const item of deterministicNegatives) {
      await persistDecision(normalizeDecision({
        id: item.source_id,
        project_id: null,
        relevance: 0,
        rationale: 'No stable project name or keyword anchor is present in the email episode',
      }, new Set(projects.map(project => Number(project.id)))), item, source, catalogHash)
    }
  }
  // Sparse positive-only output keeps this bounded batch within local context
  // while limiting the amount of durable work retried after malformed output.
  const batchSize = 80
  for (let offset = 0; offset < semanticPending.length; offset += batchSize) {
    const batch = semanticPending.slice(offset, offset + batchSize)
    const decisions = await classifyBatch(batch, projects)
    for (const decision of decisions) {
      const item = batch.find(candidate => candidate.source_id === decision.source_id)
      if (!item) continue
      matched += await persistDecision(decision, item, source, catalogHash)
    }
  }
  return matched
}

async function classifyEmails(projects, since = null) {
  try {
    const catalogHash = projectCatalogHash(projects)
    const { rows } = await db.query(`
      SELECT rc.source_id, rc.subject, SUBSTRING(rc.content_snippet, 1, 4000) AS snippet,
             rc.occurred_at, rc.contact_id
      FROM relationships.communications rc
      WHERE rc.source = 'email'
        AND NULLIF(rc.content_snippet, '') IS NOT NULL
        AND ($3::timestamptz IS NULL OR rc.occurred_at > $3)
        AND NOT EXISTS (
          SELECT 1 FROM projects.communication_classifications decision
          WHERE decision.source = 'email'
            AND decision.episode_id = rc.source_id
            AND decision.project_catalog_hash = $1
            AND decision.classifier_version = $2
            AND decision.is_current = TRUE
        )
      ORDER BY rc.occurred_at DESC NULLS LAST
      LIMIT 1000
    `, [catalogHash, CLASSIFIER_VERSION, since])
    return classifyItems(rows.map(email => ({
      source_id: email.source_id,
      source: 'email',
      subject: email.subject || '',
      snippet: compact(email.snippet || email.subject, 4000),
      date: email.occurred_at ? new Date(email.occurred_at).toLocaleDateString() : '',
      occurred_at: email.occurred_at || null,
      contact_id: email.contact_id || null,
      source_refs: [email.source_id],
    })), projects, 'email')
  } catch (error) {
    console.error('[classifier] classifyEmails error:', error.message)
    throw error
  }
}

async function classifyLifelogs(projects, since = null) {
  try {
    const catalogHash = projectCatalogHash(projects)
    const { rows } = await db.query(`
      SELECT rc.source_id, rc.subject, SUBSTRING(rc.content_snippet, 1, 4000) AS snippet,
             rc.occurred_at, rc.contact_id
      FROM relationships.communications rc
      WHERE rc.source = 'limitless'
        AND NULLIF(rc.content_snippet, '') IS NOT NULL
        AND ($3::timestamptz IS NULL OR rc.occurred_at > $3)
        AND NOT EXISTS (
          SELECT 1 FROM projects.communication_classifications decision
          WHERE decision.source = 'limitless'
            AND decision.episode_id = rc.source_id
            AND decision.project_catalog_hash = $1
            AND decision.classifier_version = $2
            AND decision.is_current = TRUE
        )
      ORDER BY rc.occurred_at DESC NULLS LAST
      LIMIT 600
    `, [catalogHash, CLASSIFIER_VERSION, since])
    return classifyItems(rows.map(log => ({
      source_id: log.source_id,
      source: 'limitless',
      subject: log.subject || '',
      snippet: compact(log.snippet || log.subject, 4000),
      date: log.occurred_at ? new Date(log.occurred_at).toLocaleDateString() : '',
      occurred_at: log.occurred_at || null,
      contact_id: log.contact_id || null,
      source_refs: [log.source_id],
    })), projects, 'limitless')
  } catch (error) {
    console.error('[classifier] classifyLifelogs error:', error.message)
    throw error
  }
}

async function classifyWhatsAppChats(projects, _since = null) {
  try {
    const catalogHash = projectCatalogHash(projects)
    const { rows } = await db.query(`
      WITH message_base AS (
        SELECT rc.chat_id,
               COALESCE(rc.metadata->>'author_jid', rc.contact_id::text,
                        CASE WHEN rc.direction = 'outbound' THEN 'self' ELSE rc.chat_id END) AS author_id,
               rc.content_snippet AS body,
               COALESCE(rc.metadata->>'author_name', rc.group_name, contact.display_name, rc.chat_id) AS notify_name,
               rc.occurred_at AS ts,
               rc.contact_id,
               rc.source_id AS canonical_source_id,
               'whatsapp:' || COALESCE(rc.chat_id, 'unknown') || ':' || TO_CHAR(rc.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':' ||
                 COALESCE(rc.metadata->>'author_jid', rc.contact_id::text,
                          CASE WHEN rc.direction = 'outbound' THEN 'self' ELSE rc.chat_id END) AS episode_id
        FROM relationships.communications rc
        LEFT JOIN relationships.contacts contact ON contact.id = rc.contact_id
        WHERE rc.source = 'whatsapp'
          AND NULLIF(rc.content_snippet, '') IS NOT NULL
          AND COALESCE(rc.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
      ), pending_episodes AS (
        SELECT mb.episode_id, MAX(mb.ts) AS last_at
        FROM message_base mb
        WHERE mb.ts >= DATE_TRUNC('day', NOW())
           OR NOT EXISTS (
             SELECT 1 FROM projects.communication_classifications decision
             WHERE decision.source = 'whatsapp'
               AND decision.episode_id = mb.episode_id
               AND decision.project_catalog_hash = $1
               AND decision.classifier_version = $2
               AND decision.is_current = TRUE
           )
        GROUP BY mb.episode_id
        ORDER BY MAX(mb.ts) DESC
        LIMIT 200
      )
      SELECT mb.episode_id,
             MAX(mb.notify_name) AS notify_name,
             MAX(mb.ts) AS ts,
             MAX(mb.contact_id) AS contact_id,
             STRING_AGG(mb.body, ' | ' ORDER BY mb.ts DESC) AS body,
             ARRAY_AGG(mb.canonical_source_id ORDER BY mb.ts DESC) AS source_refs
      FROM message_base mb
      JOIN pending_episodes pending ON pending.episode_id = mb.episode_id
      GROUP BY mb.episode_id, pending.last_at
      ORDER BY pending.last_at DESC
    `, [catalogHash, CLASSIFIER_VERSION])
    const items = rows.map(episode => ({
      source_id: episode.episode_id,
      source: 'whatsapp',
      subject: episode.notify_name || episode.episode_id,
      snippet: compact(episode.body, 4000),
      occurred_at: episode.ts,
      contact_id: episode.contact_id || null,
      source_refs: (episode.source_refs || []).slice(0, 50),
      date: new Date(episode.ts).toLocaleDateString(),
    }))
    return classifyItems(items, projects, 'whatsapp')
  } catch (error) {
    console.error('[classifier] classifyWhatsAppChats error:', error.message)
    throw error
  }
}

module.exports = {
  CLASSIFIER_VERSION,
  MIN_RELEVANCE,
  classifyBatch,
  classifyEmails,
  classifyLifelogs,
  classifyWhatsAppChats,
  classificationBatchId,
  contentHash,
  hasProjectAnchor,
  matchEnvelopeFromPayload,
  normalizeDecision,
  parseJSON,
  pendingPage,
  projectCatalogHash,
  projectAnchorTerms,
  validateBatchResponse,
  whatsappEpisodeId,
}
