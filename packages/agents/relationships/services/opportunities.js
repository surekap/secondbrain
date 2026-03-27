'use strict'

/**
 * Opportunity detection swarm — four specialised agents run in parallel.
 *
 *  Agent 1 · Meeting Intelligence   — extracts action items from Limitless transcripts
 *  Agent 2 · Urgency Scanner        — flags high-urgency unread WhatsApp messages
 *  Agent 3 · Relationship Health    — detects important relationships going cold
 *  Agent 4 · Email Response Gap     — finds emails you read but never replied to
 *
 * All agents are side-effect free: they return arrays of insight objects.
 * The caller (index.js) decides how to persist them.
 */

const llm = require('../../shared/llm')
const db        = require('@secondbrain/db')
const { buildCrossSourceDigest } = require('./extractor')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  try { return JSON.parse(clean) } catch {
    const last = clean.lastIndexOf('}')
    if (last === -1) throw new Error('No JSON found')
    return JSON.parse(clean.slice(0, last + 1) + '\n]')
  }
}

// ── Agent 1: Meeting Intelligence ─────────────────────────────────────────────
// Reads Limitless transcripts and extracts action items, commitments, follow-ups.

async function extractMeetingActionItems(lastRunAt) {
  const insights = []
  try {
    // Fetch lifelogs newer than last run that haven't already generated insights
    const { rows: lifelogs } = await db.query(`
      SELECT l.id, l.title, l.start_time, l.markdown
      FROM limitless.lifelogs l
      WHERE l.markdown IS NOT NULL
        AND l.markdown != ''
        AND length(l.markdown) > 200
        AND ($1::timestamptz IS NULL OR l.start_time > $1)
        AND NOT EXISTS (
          SELECT 1 FROM relationships.insights i
          WHERE i.source_ref = 'lifelog:' || l.id::text
            AND i.is_actioned = false
            AND i.is_dismissed = false
        )
      ORDER BY l.start_time DESC
      LIMIT 25
    `, [lastRunAt || null])

    console.log(`   [meeting-intel] ${lifelogs.length} new lifelogs to process`)

    for (const log of lifelogs) {
      try {
        const date = log.start_time
          ? new Date(log.start_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
          : 'unknown date'

        const prompt = `You are extracting action items from a meeting transcript for a senior business executive.

Meeting: "${log.title || 'Untitled'}" on ${date}

Transcript:
${(log.markdown || '').slice(0, 3500)}

Extract action items where:
1. The executive ("You" or "Me") committed to do something
2. Something was decided that requires a follow-up
3. Someone directly asked the executive for a response or decision
4. A follow-up meeting/call/document was discussed but not confirmed

Return ONLY valid JSON:
{
  "action_items": [
    {
      "title": "Short action title (max 8 words)",
      "description": "What needs to be done, with enough context to act on it",
      "priority": "high|medium|low",
      "contact_name": "Name of person this involves, or null"
    }
  ]
}

Rules:
- Max 4 action items per meeting
- Only include clear, actionable items — not vague discussion points
- high = time-sensitive or explicitly committed; medium = should follow up; low = nice-to-have
- Return {"action_items": []} if no clear action items exist`

        const response = await llm.create('relationships', {
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        })

        const text   = response.text || ''
        const result = parseJSON(text)
        const items  = Array.isArray(result.action_items) ? result.action_items : []

        for (const item of items) {
          if (!item.title) continue
          // Look up contact_id by name if provided
          let contactId = null
          if (item.contact_name) {
            const { rows } = await db.query(`
              SELECT id FROM relationships.contacts
              WHERE normalized_name = LOWER(TRIM($1))
                 OR display_name    ILIKE $1
              LIMIT 1
            `, [item.contact_name])
            contactId = rows[0]?.id || null
          }

          insights.push({
            contact_id:   contactId,
            insight_type: 'action_needed',
            title:        `[Meeting] ${item.title}`,
            description:  `${log.title ? `"${log.title}" · ` : ''}${item.description || ''}`,
            priority:     item.priority || 'medium',
            source_ref:   `lifelog:${log.id}`,
          })
        }

        if (items.length) {
          console.log(`   [meeting-intel] "${log.title}" → ${items.length} action item(s)`)
        }
        await sleep(500)
      } catch (err) {
        console.error(`   [meeting-intel] error on log ${log.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[meeting-intel] fatal error:', err.message)
  }
  return insights
}

// ── Agent 2: Urgency Scanner ──────────────────────────────────────────────────
// Scans recent inbound WhatsApp messages from important contacts for urgency.

async function detectUrgentMessages(lastRunAt) {
  const insights = []
  try {
    const since = lastRunAt || new Date(Date.now() - 48 * 3600 * 1000)

    // Most recent inbound message per important contact, newer than lastRunAt
    const { rows: messages } = await db.query(`
      SELECT DISTINCT ON (m.chat_id)
        m.chat_id,
        m.data->>'body'                     AS body,
        m.data->'_data'->>'notifyName'      AS notify_name,
        m.ts,
        c.id                                AS contact_id,
        c.display_name,
        c.relationship_strength
      FROM public.messages m
      JOIN relationships.contacts c ON c.wa_jids @> ARRAY[m.chat_id]::text[]
      WHERE m.event IN ('message','message_create','message_historical')
        AND (m.data->'id'->>'fromMe')::boolean = false
        AND m.msg_type = 'chat'
        AND m.ts > $1
        AND c.is_noise = false
        AND c.relationship_strength IN ('strong','moderate')
        AND m.data->>'body' IS NOT NULL
        AND length(m.data->>'body') > 10
        AND NOT EXISTS (
          SELECT 1 FROM relationships.insights i
          WHERE i.source_ref = 'wa:' || m.chat_id || ':' || EXTRACT(EPOCH FROM m.ts)::bigint::text
            AND i.is_actioned = false
            AND i.is_dismissed = false
        )
      ORDER BY m.chat_id, m.ts DESC
      LIMIT 40
    `, [since])

    if (!messages.length) {
      console.log('   [urgency-scan] no new messages from important contacts')
      return insights
    }

    console.log(`   [urgency-scan] scanning ${messages.length} messages for urgency`)

    // Batch 20 at a time
    const BATCH = 20
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH)

      const msgList = batch.map(m =>
        `id="${m.chat_id}", name="${m.notify_name || m.display_name}", strength="${m.relationship_strength}", ` +
        `date="${m.ts ? new Date(m.ts).toLocaleDateString('en-GB') : ''}", ` +
        `message="${(m.body || '').slice(0, 250)}"`
      ).join('\n')

      const prompt = `For each WhatsApp message below, assess urgency and whether a reply is needed.

Messages:
${msgList}

Return ONLY valid JSON array:
[
  {
    "chat_id": "...",
    "urgency": "high|medium|low",
    "needs_response": true|false,
    "reason": "one-sentence reason"
  }
]

urgency=high when: explicit question, deadline mentioned, request for decision, concern/problem raised, "please", "urgent", "ASAP", or message from a strong-relationship contact with clear expectation of reply.
needs_response=true only if the message clearly expects a reply.
Return low urgency / needs_response=false for casual statements, FYI messages, or one-sided updates.`

      try {
        const response = await llm.create('relationships', {
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        })

        const text    = response.text || ''
        const results = parseJSON(text)
        if (!Array.isArray(results)) continue

        for (const r of results) {
          if (!r.needs_response || r.urgency === 'low') continue

          const msg = batch.find(m => m.chat_id === r.chat_id)
          if (!msg) continue

          const tsEpoch = msg.ts ? Math.round(new Date(msg.ts).getTime() / 1000) : Date.now()
          const name    = msg.notify_name || msg.display_name || msg.chat_id.replace('@c.us', '')

          insights.push({
            contact_id:   msg.contact_id || null,
            insight_type: 'action_needed',
            title:        `${r.urgency === 'high' ? '🔴' : '🟡'} Reply to ${name}`,
            description:  `${r.reason} — "${(msg.body || '').slice(0, 150)}"`,
            priority:     r.urgency === 'high' ? 'high' : 'medium',
            source_ref:   `wa:${msg.chat_id}:${tsEpoch}`,
          })
        }
      } catch (err) {
        console.error('[urgency-scan] batch error:', err.message)
      }

      if (i + BATCH < messages.length) await sleep(800)
    }

    console.log(`   [urgency-scan] flagged ${insights.length} urgent messages`)
  } catch (err) {
    console.error('[urgency-scan] fatal error:', err.message)
  }
  return insights
}

// ── Agent 3: Relationship Health Monitor ─────────────────────────────────────
// Detects strong/moderate relationships going silent across ALL channels.

async function detectColdRelationships() {
  const insights = []
  try {
    const { rows: contacts } = await db.query(`
      SELECT
        c.id,
        c.display_name,
        c.relationship_type,
        c.relationship_strength,
        c.last_interaction_at,
        c.company,
        EXTRACT(DAYS FROM NOW() - c.last_interaction_at)::int AS days_silent
      FROM relationships.contacts c
      WHERE c.is_noise = false
        AND c.relationship_strength IN ('strong','moderate')
        AND c.last_interaction_at < NOW() - INTERVAL '21 days'
        AND c.last_interaction_at > NOW() - INTERVAL '90 days'
        AND NOT EXISTS (
          SELECT 1 FROM relationships.insights i
          WHERE i.contact_id = c.id
            AND i.source_ref LIKE 'contact:cold:%'
            AND i.is_actioned = false
            AND i.is_dismissed = false
            AND i.created_at > NOW() - INTERVAL '7 days'
        )
      ORDER BY c.relationship_strength DESC, c.last_interaction_at ASC
      LIMIT 15
    `)

    console.log(`   [rel-health] ${contacts.length} relationships going cold`)

    for (const c of contacts) {
      const strengthLabel = c.relationship_strength === 'strong' ? 'Close contact' : 'Regular contact'
      const context = [c.relationship_type, c.company].filter(Boolean).join(' · ')

      insights.push({
        contact_id:   c.id,
        insight_type: 'opportunity',
        title:        `Re-engage ${c.display_name}`,
        description:  `${strengthLabel}${context ? ` (${context})` : ''} — no interaction in ${c.days_silent} days. Consider reaching out to maintain the relationship.`,
        priority:     c.relationship_strength === 'strong' && c.days_silent > 30 ? 'high' : 'medium',
        source_ref:   `contact:cold:${c.id}`,
      })
    }
  } catch (err) {
    console.error('[rel-health] fatal error:', err.message)
  }
  return insights
}

// ── Agent 4: Email Response Gap Detector ─────────────────────────────────────
// Finds emails you've read where the sender has sent no follow-up —
// a proxy for "they're waiting for a reply that never came".

async function findReadEmailsWithNoResponse() {
  const insights = []
  try {
    const { rows: emails } = await db.query(`
      SELECT
        e.id,
        e.subject,
        e.from_address,
        e.date,
        SUBSTRING(e.body_text, 1, 300) AS snippet,
        es.contact_id,
        es.parsed_name AS sender_name
      FROM email.emails e
      JOIN relationships.email_senders es ON es.raw_address = e.from_address
      WHERE e.is_read = true
        AND e.date > NOW() - INTERVAL '60 days'
        AND e.date < NOW() - INTERVAL '3 days'
        AND es.is_noise = false
        AND es.contact_id IS NOT NULL
        -- Sender never sent a follow-up (they're waiting)
        AND NOT EXISTS (
          SELECT 1 FROM email.emails e2
          WHERE e2.from_address = e.from_address
            AND e2.date > e.date
        )
        -- Not already flagged
        AND NOT EXISTS (
          SELECT 1 FROM relationships.insights i
          WHERE i.source_ref = 'email:' || e.id::text
            AND i.is_actioned = false
            AND i.is_dismissed = false
        )
      ORDER BY e.date DESC
      LIMIT 25
    `)

    console.log(`   [email-gap] ${emails.length} read emails with no follow-up from sender`)

    for (const em of emails) {
      const name = em.sender_name || em.from_address
      const daysAgo = Math.round((Date.now() - new Date(em.date)) / 86400000)

      insights.push({
        contact_id:   em.contact_id || null,
        insight_type: 'cold_email',
        title:        `No reply: "${(em.subject || '(no subject)').slice(0, 55)}"`,
        description:  `From ${name}, ${daysAgo}d ago. You read it but never replied — they've sent nothing since. ${(em.snippet || '').replace(/\s+/g, ' ').slice(0, 120)}`,
        priority:     daysAgo > 14 ? 'high' : 'medium',
        source_ref:   `email:${em.id}`,
      })
    }
  } catch (err) {
    console.error('[email-gap] fatal error:', err.message)
  }
  return insights
}

// ── Agent 5: Cross-Person Intelligence ────────────────────────────────────────
// Reads the cross-source digest and detects cross-person opportunities.

async function detectCrossPersonOpportunities(lastRunAt) {
  const insights = []
  try {
    const digest = await buildCrossSourceDigest(
      lastRunAt ? new Date(Math.min(new Date(lastRunAt), Date.now() - 30 * 24 * 60 * 60 * 1000)) : null
    )
    if (!digest || digest.length < 200) return insights

    const prompt = `You are a relationship intelligence assistant for a senior executive.
Analyze these recent communications and identify actionable relationship opportunities.

Look specifically for:
1. CHECK-IN: Someone mentioned as going through difficulty (surgery, illness, crisis, loss, stress) — the executive should check in
2. INTRODUCTION: Person A has a need (looking for consultant, seeking intro, needs help with X) AND Person B has the matching skill/service mentioned elsewhere — executive can make introduction
3. FOLLOW-UP: Someone mentioned the executive, their work, or something they said — worth acknowledging
4. PROJECT_MATCH: Someone whose skills/company could help with a business challenge mentioned in the communications

Communications digest (newest first):
${digest}

Return ONLY a JSON array (empty array if no strong opportunities):
[
  {
    "type": "check_in|introduction|follow_up|project_match",
    "title": "Short action title (max 60 chars)",
    "description": "Specific, actionable description referencing what was said and why this matters",
    "person_names": ["Name1", "Name2"],
    "priority": "high|medium|low"
  }
]

Rules:
- Only return genuine, specific opportunities — not generic advice
- INTRODUCTION opportunities must name both the person with the need AND the person who can help
- CHECK-IN opportunities must reference the specific situation
- Maximum 5 opportunities
- If no strong opportunities, return []`

    const response = await llm.create('relationships', {
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text || ''
    const items = parseJSON(text)
    if (!Array.isArray(items)) return insights

    for (const item of items.slice(0, 5)) {
      // Resolve person names to contact_ids
      const contactIds = []
      for (const name of (item.person_names || [])) {
        if (!name) continue
        try {
          const { rows } = await db.query(`
            SELECT id FROM relationships.contacts
            WHERE normalized_name ILIKE $1
               OR display_name ILIKE $2
            LIMIT 1
          `, [name.toLowerCase().trim(), name.trim()])
          if (rows.length > 0) contactIds.push(rows[0].id)
        } catch { /* ignore */ }
      }

      // Deduplicate: skip if a similar insight already exists unactioned
      const sortedIds = [...contactIds].sort((a, b) => a - b).join(',')
      const titleHash = `cross:${item.title?.slice(0, 40)?.toLowerCase().replace(/\s+/g, '_')}:${sortedIds}`
      const { rows: exists } = await db.query(`
        SELECT id FROM relationships.insights
        WHERE source_ref = $1
          AND is_actioned = false AND is_dismissed = false
        LIMIT 1
      `, [titleHash])
      if (exists.length > 0) continue

      insights.push({
        contact_id:   contactIds[0] || null,
        contact_ids:  contactIds,
        insight_type: 'cross_source_opportunity',
        title:        item.title || 'Relationship opportunity',
        description:  item.description || '',
        priority:     item.priority || 'medium',
        source_ref:   titleHash,
      })
    }
  } catch (err) {
    console.error('[opportunities] detectCrossPersonOpportunities error:', err.message)
  }
  return insights
}

// ── Agent 6: Project Match ─────────────────────────────────────────────────────
// Matches open projects to contacts who could help.

async function detectProjectMatches(lastRunAt) {
  const insights = []
  try {
    // Fetch open projects
    const { rows: projects } = await db.query(`
      SELECT id, name, description, status, tags
      FROM projects.projects
      WHERE status NOT IN ('completed', 'cancelled', 'noise')
      ORDER BY updated_at DESC
      LIMIT 10
    `)
    if (projects.length === 0) return insights

    // Fetch strong/moderate contacts with research summaries or job details
    const { rows: contacts } = await db.query(`
      SELECT id, display_name, job_title, company, research_summary, summary, tags
      FROM relationships.contacts
      WHERE is_noise = false
        AND relationship_strength IN ('strong', 'moderate')
      ORDER BY last_interaction_at DESC NULLS LAST
      LIMIT 50
    `)
    if (contacts.length === 0) return insights

    const projectList = projects.map(p =>
      `- [ID:${p.id}] ${p.name}: ${(p.description || '').slice(0, 150)}`
    ).join('\n')

    const contactList = contacts.map(c => {
      const bio = c.research_summary || c.summary || ''
      return `- [ID:${c.id}] ${c.display_name} (${c.job_title || 'unknown role'} @ ${c.company || 'unknown company'}): ${bio.slice(0, 150)}`
    }).join('\n')

    const prompt = `You are a relationship intelligence assistant.
Given these open projects and contacts, identify which contacts could concretely help with which projects.

Open projects:
${projectList}

Contacts:
${contactList}

Return ONLY a JSON array of the best 3 matches (empty array if none are strong matches):
[
  {
    "project_id": 123,
    "contact_id": 456,
    "project_name": "...",
    "contact_name": "...",
    "reason": "Why this contact can help and how (2-3 sentences)",
    "suggested_opener": "A specific, natural opening message to send this contact about the project (1-2 sentences)",
    "priority": "high|medium|low"
  }
]

Only include genuinely strong matches where the contact has relevant expertise or connections.`

    const response = await llm.create('relationships', {
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text || ''
    const items = parseJSON(text)
    if (!Array.isArray(items)) return insights

    for (const item of items.slice(0, 3)) {
      const sourceRef = `project:${item.project_id}:${item.contact_id}`
      const { rows: exists } = await db.query(`
        SELECT id FROM relationships.insights
        WHERE source_ref = $1
          AND is_actioned = false AND is_dismissed = false
        LIMIT 1
      `, [sourceRef])
      if (exists.length > 0) continue

      insights.push({
        contact_id:   item.contact_id || null,
        contact_ids:  item.contact_id ? [item.contact_id] : [],
        insight_type: 'project_match',
        title:        `${item.contact_name} can help with: ${item.project_name}`,
        description:  `${item.reason}\n\nSuggested opener: "${item.suggested_opener}"`,
        priority:     item.priority || 'medium',
        source_ref:   sourceRef,
      })
    }
  } catch (err) {
    console.error('[opportunities] detectProjectMatches error:', err.message)
  }
  return insights
}

// ── Agent 7: Research-Driven Opportunities ───────────────────────────────────
// Scans new research results for contextual opportunities.

async function detectResearchOpportunities(lastRunAt) {
  const insights = []
  try {
    const since = lastRunAt || new Date(Date.now() - 24 * 60 * 60 * 1000)
    const { rows: newResearch } = await db.query(`
      SELECT cr.contact_id, cr.summary, cr.source, cr.researched_at,
             c.display_name, c.company
      FROM relationships.contact_research cr
      JOIN relationships.contacts c ON c.id = cr.contact_id
      WHERE cr.researched_at > $1
        AND cr.summary IS NOT NULL
        AND cr.summary NOT LIKE '%No %found%'
      ORDER BY cr.researched_at DESC
      LIMIT 30
    `, [since])

    if (newResearch.length === 0) return insights

    // Group by contact
    const byContact = {}
    for (const r of newResearch) {
      if (!byContact[r.contact_id]) {
        byContact[r.contact_id] = { display_name: r.display_name, company: r.company, summaries: [] }
      }
      byContact[r.contact_id].summaries.push(`[${r.source}] ${r.summary}`)
    }

    for (const [contactId, data] of Object.entries(byContact)) {
      const combined = data.summaries.join('\n\n').slice(0, 2000)
      const prompt = `Based on this recent research about ${data.display_name} (${data.company || 'unknown company'}), identify any specific relationship opportunities.

Research:
${combined}

Look for: company news (new product/funding/expansion), role changes, achievements, events, or anything that would be a natural reason to reach out.

Return ONLY a JSON object (or null if no strong opportunity):
{
  "title": "Short opportunity title (max 60 chars)",
  "description": "What happened and why it's a good reason to reach out (2-3 sentences)",
  "priority": "high|medium|low"
}`

      try {
        const response = await llm.create('relationships', {
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        })
        const text = response.text || ''
        if (text.trim() === 'null' || !text.trim()) continue
        const item = parseJSON(text)
        if (!item?.title) continue

        const sourceRef = `research:${contactId}:${Math.floor(Date.now() / 86400000)}`
        const { rows: exists } = await db.query(`
          SELECT id FROM relationships.insights
          WHERE source_ref = $1 AND is_actioned = false AND is_dismissed = false LIMIT 1
        `, [sourceRef])
        if (exists.length > 0) continue

        insights.push({
          contact_id:   parseInt(contactId, 10),
          contact_ids:  [parseInt(contactId, 10)],
          insight_type: 'opportunity',
          title:        item.title,
          description:  item.description || '',
          priority:     item.priority || 'medium',
          source_ref:   sourceRef,
        })
        await sleep(300)
      } catch { /* non-fatal per contact */ }
    }
  } catch (err) {
    console.error('[opportunities] detectResearchOpportunities error:', err.message)
  }
  return insights
}

// ── Swarm orchestrator ────────────────────────────────────────────────────────
// Runs all 7 agents. Agents 1-4 in parallel, Agents 5-7 sequential. Returns flat array of all insights found.

async function runOpportunitySwarm(lastRunAt) {
  console.log('\n🔭 Running opportunity detection swarm (7 agents)...')

  const [
    meetingResult,
    urgencyResult,
    coldResult,
    emailGapResult,
  ] = await Promise.allSettled([
    extractMeetingActionItems(lastRunAt),
    detectUrgentMessages(lastRunAt),
    detectColdRelationships(),
    findReadEmailsWithNoResponse(),
  ])

  const allInsights = [
    ...(meetingResult.status  === 'fulfilled' ? meetingResult.value  : []),
    ...(urgencyResult.status  === 'fulfilled' ? urgencyResult.value  : []),
    ...(coldResult.status     === 'fulfilled' ? coldResult.value     : []),
    ...(emailGapResult.status === 'fulfilled' ? emailGapResult.value : []),
  ]

  // Log any agent failures
  for (const [name, result] of [
    ['meeting-intel', meetingResult],
    ['urgency-scan',  urgencyResult],
    ['rel-health',    coldResult],
    ['email-gap',     emailGapResult],
  ]) {
    if (result.status === 'rejected') {
      console.error(`   ✗ ${name} agent failed:`, result.reason?.message)
    }
  }

  console.log(`   Swarm complete — ${allInsights.length} total opportunities found`)

  // Agent 5: Cross-person opportunities
  const crossPersonInsights = await detectCrossPersonOpportunities(lastRunAt)
  allInsights.push(...crossPersonInsights)
  console.log(`   [Agent 5] ${crossPersonInsights.length} cross-person opportunities`)

  // Agent 6: Project matches
  const projectInsights = await detectProjectMatches(lastRunAt)
  allInsights.push(...projectInsights)
  console.log(`   [Agent 6] ${projectInsights.length} project matches`)

  // Agent 7: Research-driven opportunities
  const researchInsights = await detectResearchOpportunities(lastRunAt)
  allInsights.push(...researchInsights)
  console.log(`   [Agent 7] ${researchInsights.length} research-driven opportunities`)

  return allInsights
}

module.exports = {
  runOpportunitySwarm,
  detectCrossPersonOpportunities,
  detectProjectMatches,
  detectResearchOpportunities,
}
