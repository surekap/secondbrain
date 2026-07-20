'use strict'

const llm = require('../../shared/llm')
const db        = require('@secondbrain/db')

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    // Recover complete project objects from a truncated top-level array or
    // { "projects": [...] } payload. Evidence validation below still rejects
    // any incomplete or invented rows.
    const firstBracket = clean.indexOf('[')
    const lastBrace = clean.lastIndexOf('}')
    if (firstBracket === -1 || lastBrace < firstBracket) throw new Error('No JSON project objects found')
    return JSON.parse(`${clean.slice(firstBracket, lastBrace + 1)}\n]`)
  }
}

function projectArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.projects)) return payload.projects
  throw new Error('Project discovery did not return a projects array')
}

const DISCOVERY_VERSION = 'canonical-project-discovery-v1'
const OUTCOME_MARKER = /\b(approve|approved|build|built|buy|close|complete|completed|deliver|delivered|deploy|deployed|finali[sz]e|fix|fixed|implement|implemented|launch|launched|migrate|migrated|organize|organized|prepare|prepared|renew|renewed|resolve|resolved|sell|sign|signed|submit|submitted|target|deadline|milestone)\b/i

function normalizeEvidenceText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function hasVerifiedOutcomeEvidence(raw, episodes) {
  const evidence = raw?.outcome_evidence
  const ref = String(evidence?.ref || '')
  const quote = normalizeEvidenceText(evidence?.quote)
  const completionTest = String(raw?.completion_test || '').trim()
  if (!ref || quote.length < 12 || completionTest.length < 12 || !OUTCOME_MARKER.test(quote)) return false
  const episode = episodes.find(candidate => String(candidate.source_id) === ref)
  return Boolean(episode && normalizeEvidenceText(episode.content_snippet).includes(quote))
}

/** Gather evidence-bearing canonical episodes, never channel/contact names. */
async function gatherDiscoveryData() {
  const { rows: episodes } = await db.query(`
    WITH eligible AS (
      SELECT id, source, source_id, subject, LEFT(content_snippet, 500) AS content_snippet,
             occurred_at, contact_id, chat_id, is_group,
             ROW_NUMBER() OVER (PARTITION BY source ORDER BY occurred_at DESC NULLS LAST) AS recent_rank,
             ROW_NUMBER() OVER (
               PARTITION BY source, DATE_TRUNC('week', occurred_at)
               ORDER BY occurred_at DESC NULLS LAST
             ) AS weekly_rank
      FROM relationships.communications
      WHERE occurred_at > NOW() - INTERVAL '180 days'
        AND NULLIF(content_snippet, '') IS NOT NULL
        AND COALESCE(metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
    )
    SELECT id, source, source_id, subject, content_snippet, occurred_at,
           contact_id, chat_id, is_group
    FROM eligible
    WHERE recent_rank <= 15 OR weekly_rank = 1
    ORDER BY occurred_at DESC NULLS LAST
  `)
  return { episodes }
}

function validateDiscoveredProjects(result, episodes, existingProjects) {
  result = projectArrayFromPayload(result)
  const allowedRefs = new Set(episodes.map(episode => String(episode.source_id)))
  const existingById = new Map(existingProjects.map(project => [Number(project.id), project]))
  const seen = new Set()
  const out = []
  for (const raw of result) {
    const evidenceRefs = [...new Set((Array.isArray(raw?.evidence_refs) ? raw.evidence_refs : [])
      .map(String)
      .filter(ref => allowedRefs.has(ref)))]
    if (!evidenceRefs.length) continue
    const existingId = raw.existing_project_id == null ? null : Number(raw.existing_project_id)
    const existing = Number.isFinite(existingId) ? existingById.get(existingId) : null
    if (raw.existing_project_id != null && !existing) continue
    if (!existing && !hasVerifiedOutcomeEvidence(raw, episodes)) continue
    const name = String(existing?.name || raw.name || '').trim()
    if (!name) continue
    const key = existing ? `id:${existing.id}` : `new:${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      ...raw,
      name,
      status: ['active', 'stalled', 'completed', 'unknown'].includes(raw.status) ? raw.status : 'unknown',
      health: ['on_track', 'at_risk', 'blocked', 'unknown'].includes(raw.health) ? raw.health : 'unknown',
      priority: ['high', 'medium', 'low'].includes(raw.priority) ? raw.priority : 'medium',
      existing_project_id: existing?.id || null,
      evidence_refs: evidenceRefs,
      discovery_version: DISCOVERY_VERSION,
    })
  }
  return out.slice(0, 20)
}

/**
 * Ask the configured reasoning model to discover projects from canonical data.
 * Returns array of project objects.
 */
async function discoverProjects(data) {
  const episodes = data.episodes || []

  // Load existing project names so the model can reuse them instead of creating variants
  const { rows: existingProjects } = await db.query(`
    SELECT id, name, description, status
    FROM projects.projects WHERE is_archived = FALSE ORDER BY name
  `)
  const episodeList = episodes.map(episode =>
    `- canonical_ref="${episode.source_id}" channel=${episode.source} date=${episode.occurred_at ? new Date(episode.occurred_at).toISOString() : 'unknown'} subject=${JSON.stringify(episode.subject || '')} text=${JSON.stringify(episode.content_snippet || '')}`
  ).join('\n')

  const existingList = existingProjects.length > 0
    ? `\nExisting projects (use existing_project_id only for an exact semantic continuation):\n${existingProjects.map(project => `- id=${project.id} name=${JSON.stringify(project.name)} outcome=${JSON.stringify(project.description || '')}`).join('\n')}\n`
    : ''

  const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
  const prompt = `You are analyzing communications for a business person. Today is ${today}. Based on these email subjects, meeting transcripts, and WhatsApp conversations, identify distinct outcome-bearing projects this person is managing.
${existingList}

Canonical communication episodes:
${episodeList || '(none)'}

Return one JSON object with a "projects" array. Each project in that array:
{
  "projects": [
{
  "name": "Short project name",
  "existing_project_id": "numeric existing id or null",
  "description": "1-2 sentence description of what this project is about",
  "status": "active|stalled|completed|unknown",
  "health": "on_track|at_risk|blocked|unknown",
  "priority": "high|medium|low",
  "tags": ["tag1"],
  "keywords": ["keyword1", "keyword2"],
  "evidence_refs": ["exact canonical_ref value"],
  "completion_test": "Concrete observable condition that would complete this project",
  "outcome_evidence": {"ref":"exact canonical_ref value","quote":"verbatim excerpt proving a deliverable, milestone, decision, deadline, or intended completion"}
}
  ]
}

Guidelines:
- Be specific — "Hartex SAP Implementation" not just "SAP"
- A project must have an intended outcome, owner or stakeholders, and a lifecycle. Treat broad themes, relationships, recurring channels, and general interests as topics, not projects.
- Merge very similar topics (e.g. "SAP HANA" and "SAP Implementation" are one project)
- Ignore noise (one-off unrelated messages)
- Max 10 projects
- Every project must cite direct supporting canonical_ref values. A channel name, contact name, or recurring topic alone is not evidence of a project.
- A genuinely new project must include a concrete completion_test and outcome_evidence. The quote must be copied verbatim from the cited episode and must itself show a deliverable, milestone, decision, deadline, or intended completion. Do not invent a target from general activity.
- For an existing project, return its exact numeric existing_project_id. Never infer identity from a similar name. Use null for genuinely new outcomes.
- keywords should be words or phrases that would appear in communications related to this project
- For status: use "active" only if there is evidence of recent activity (within the last few months relative to today's date); use "stalled" if activity has gone quiet; use "completed" if the matter appears to have concluded; use "unknown" if unclear
- For health: assess based on tone and recency of activity
- Projects where the most recent email activity is more than 1 year ago and there are no recent meeting transcripts or WhatsApp messages on the topic should be marked "stalled" or "completed", NOT "active"`

  try {
    const response = await llm.create('projects', {
      profile: 'reasoning_synthesis',
      task_type: 'project_discovery_json',
      workflow_name: 'project_discovery',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text || ''
    const result = parseJSON(text)
    return validateDiscoveredProjects(result, episodes, existingProjects)
  } catch (err) {
    console.error('[discoverer] discoverProjects error:', err.message)
    throw err
  }
}

module.exports = {
  DISCOVERY_VERSION,
  discoverProjects,
  gatherDiscoveryData,
  hasVerifiedOutcomeEvidence,
  parseJSON,
  projectArrayFromPayload,
  validateDiscoveredProjects,
}
