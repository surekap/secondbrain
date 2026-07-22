'use strict'

const llm = require('../../shared/llm')
const db = require('@secondbrain/db')
const { extractText } = require('../../shared/docParser')
const { messageTextForAnalysis } = require('./communication')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Parse JSON from Claude's response, handling markdown code fences.
 */
function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  try {
    return JSON.parse(clean)
  } catch {
    // Attempt to recover truncated JSON by closing open structures
    let s = clean
    // Close any open string by trimming to last complete key-value
    s = s.replace(/,\s*"[^"]*$/, '').replace(/,\s*$/, '')
    // Count open braces/brackets and close them
    let braces = 0, brackets = 0
    for (const ch of s) {
      if (ch === '{') braces++; else if (ch === '}') braces--
      if (ch === '[') brackets++; else if (ch === ']') brackets--
    }
    s += ']'.repeat(Math.max(0, brackets)) + '}'.repeat(Math.max(0, braces))
    return JSON.parse(s)
  }
}

async function createStructured(options, attempts = 2) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await llm.create('relationships', options)
    try {
      return parseJSON(response.text || '')
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        console.warn(`[analyzer] invalid structured output; retrying (${attempt}/${attempts})`)
        await sleep(250)
      }
    }
  }
  throw new Error(`invalid structured output after ${attempts} attempts: ${lastError?.message || 'unknown parse error'}`)
}

/**
 * Analyze a WhatsApp direct chat contact using Claude.
 * Returns structured contact profile.
 */
async function analyzeDirectChatContact(chatId, contactData, messages, existingOverrides) {
  const defaults = {
    display_name: contactData.display_name || chatId.replace('@c.us', ''),
    company: null,
    job_title: null,
    my_role: null,
    relationship_type: 'unknown',
    relationship_strength: 'weak',
    summary: 'No analysis available.',
    tags: [],
    is_noise: false,
  }

  try {
    const phone = chatId.replace('@c.us', '')
    const displayName = contactData.display_name || `+${phone}`

    // Build message sample (up to 20 messages)
    const sample = messages.slice(0, 20).map(m => {
      const who = m.from_me ? 'Me' : (m.notify_name || displayName)
      const date = m.ts ? new Date(m.ts).toLocaleDateString() : ''
      return `[${who}] (${date}): ${messageTextForAnalysis(m).slice(0, 500)}`
    }).join('\n')

    // Try to extract text from documents
    const docTexts = []
    for (const m of messages) {
      if (m.msg_type === 'document' && m.wa_msg_id) {
        try {
          const { rows } = await db.query('SELECT file_path, mime_type FROM public.media_files WHERE wa_msg_id = $1', [m.wa_msg_id])
          if (rows.length > 0) {
            const text = await extractText(rows[0].file_path, rows[0].mime_type)
            if (text) docTexts.push(`[Document: ${m.filename || 'file'}]\n${text}`)
          }
        } catch { /* non-fatal */ }
      }
    }
    const docContext = docTexts.length > 0
      ? `\n\nDocuments shared:\n${docTexts.join('\n---\n').slice(0, 2000)}`
      : ''

    // Include manually-confirmed facts as ground truth
    const overrides = existingOverrides || {}
    const overrideKeys = Object.keys(overrides)
    const overrideContext = overrideKeys.length > 0
      ? `\nUser-confirmed facts (treat as ground truth, do not contradict):\n${overrideKeys.map(k => `- ${k}: ${JSON.stringify(overrides[k].value)}`).join('\n')}\n`
      : ''

    // Collect image messages for vision analysis (up to 3)
    const imageMessages = messages.filter(m => {
      const b = m.body || ''
      const t = m.msg_type || ''
      return t === 'image' || (b.startsWith('/9j/') && b.length > 200)
    }).slice(0, 3)

    const imageNote = imageMessages.length > 0
      ? `\n\nNote: ${imageMessages.length} image message(s) occur in this sample. Use their media-analysis text when present; do not invent missing visual details.`
      : ''

    const prompt = `You are analyzing a WhatsApp contact from the perspective of the account owner.
Describe who THIS CONTACT IS to the account owner — their role, not the reverse.

Examples of correct perspective:
- Account owner's dentist → relationship_type: "service_provider", my_role: "patient"
- Account owner's investor → relationship_type: "professional_contact", my_role: "founder"
- Account owner's employee → relationship_type: "colleague", my_role: "manager"
- Account owner's friend → relationship_type: "friend", my_role: "friend"

Contact info:
- Phone: ${phone}
- Display name: ${displayName}
- Total messages: ${contactData.msg_count}
- My messages: ${contactData.my_msgs}
- Their messages: ${contactData.their_msgs}
- First seen: ${contactData.first_msg_at ? new Date(contactData.first_msg_at).toLocaleDateString() : 'unknown'}
- Last seen: ${contactData.last_msg_at ? new Date(contactData.last_msg_at).toLocaleDateString() : 'unknown'}
${overrideContext}
Recent messages (newest first):
${sample || '(no text messages)'}${docContext}${imageNote}

Return ONLY valid JSON:
{
  "display_name": "best name for this person",
  "company": null or "company name",
  "job_title": null or "their job title",
  "relationship_type": "family|friend|colleague|client|vendor|service_provider|professional_contact|unknown",
  "my_role": null or "account owner's role relative to this contact (e.g. patient, client, mentee)",
  "relationship_strength": "strong|moderate|weak|noise",
  "summary": "2-3 sentences: who this person is TO the account owner and what the relationship is",
  "tags": ["tag1", "tag2"],
  "is_noise": false
}

Set is_noise=true for: bots, spam, automated alerts, OTP services, delivery notifications, bank alerts, unknown contacts with only automated messages.
relationship_strength=noise means this contact is not meaningful (same as is_noise).`

    const result = await createStructured({
      profile: 'bulk_structured',
      task_type: 'relationship_contact_extract_json',
      workflow_name: 'relationship_analysis',
      max_tokens: 600,
      // Media has its own versioned semantic-analysis stage. Relationship
      // synthesis consumes that canonical text instead of re-sending raw files.
      messages: [{ role: 'user', content: prompt }],
    })

    return {
      display_name: result.display_name || defaults.display_name,
      company: result.company || null,
      job_title: result.job_title || null,
      my_role: result.my_role || null,
      relationship_type: result.relationship_type || 'unknown',
      relationship_strength: result.relationship_strength || 'weak',
      summary: result.summary || '',
      tags: Array.isArray(result.tags) ? result.tags : [],
      is_noise: Boolean(result.is_noise),
    }
  } catch (err) {
    console.error('[analyzer] analyzeDirectChatContact error:', err.message)
    return { ...defaults, analysis_error: err.message }
  }
}

/**
 * Deep analysis of a single WhatsApp group.
 * Classifies group type, infers user's role, extracts intelligence.
 *
 * @param {object} group   - Row from relationships.groups (wa_chat_id, name, msg_count, my_msg_count)
 * @param {Array}  messages - Recent messages [{from_me, body, notify_name, ts}]
 * @returns {object} analysis result
 */
const GROUP_ANALYSIS_BATCH_MAX_ITEMS = 8
const GROUP_ANALYSIS_BATCH_MAX_CHARS = 80000

function groupAnalysisDefaults() {
  return {
    group_type: 'unknown',
    my_role: 'unknown',
    ai_summary: null,
    key_topics: [],
    communication_advice: null,
    notable_contacts: [],
    opportunities: [],
    is_noise: false,
  }
}

function groupAnalysisInput(group, messages) {
  const totalMsgs = Number(group.msg_count) || 0
  const myMsgs = Number(group.my_msg_count) || 0
  const myPct = totalMsgs > 0 ? Math.round((myMsgs / totalMsgs) * 100) : 0
  const evidence = (messages || []).slice(0, 50).map(m => ({
    canonical_ref: String(m.source_id || ''),
    author: m.from_me ? 'Me' : (m.notify_name || 'Other'),
    date: m.ts ? new Date(m.ts).toLocaleDateString('en-GB') : '',
    text: messageTextForAnalysis(m).slice(0, 500),
  }))
  const participants = [...new Set(
    (messages || []).filter(m => !m.from_me && m.notify_name).map(m => m.notify_name)
  )].slice(0, 20)

  return {
    group_id: String(group.wa_chat_id),
    name: group.name || group.wa_chat_id,
    total_messages: totalMsgs,
    my_messages: myMsgs,
    my_participation_percent: myPct,
    participants,
    last_active: group.last_activity_at
      ? new Date(group.last_activity_at).toLocaleDateString('en-GB')
      : 'unknown',
    evidence,
  }
}

function batchGroupAnalysisInputs(items, {
  maxItems = GROUP_ANALYSIS_BATCH_MAX_ITEMS,
  maxChars = GROUP_ANALYSIS_BATCH_MAX_CHARS,
} = {}) {
  const batches = []
  let batch = []
  let chars = 0
  for (const item of items || []) {
    const input = groupAnalysisInput(item.group, item.messages)
    const itemChars = JSON.stringify(input).length
    if (batch.length > 0 && (batch.length >= maxItems || chars + itemChars > maxChars)) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push({ ...item, input })
    chars += itemChars
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

function normalizeGroupAnalysis(result, messages) {
  const defaults = groupAnalysisDefaults()
  const allowedRefs = new Set((messages || []).map(message => String(message.source_id || '')).filter(Boolean))
  const supportedOpportunities = (Array.isArray(result?.opportunities) ? result.opportunities : [])
    .map(opportunity => ({
      ...opportunity,
      evidence_refs: (Array.isArray(opportunity?.evidence_refs) ? opportunity.evidence_refs : [])
        .map(String)
        .filter(ref => allowedRefs.has(ref)),
    }))
    .filter(opportunity => opportunity.evidence_refs.length > 0)

  return {
    group_type: result?.group_type || defaults.group_type,
    my_role: result?.my_role || defaults.my_role,
    ai_summary: result?.ai_summary || null,
    key_topics: Array.isArray(result?.key_topics) ? result.key_topics : [],
    communication_advice: result?.communication_advice || null,
    notable_contacts: Array.isArray(result?.notable_contacts) ? result.notable_contacts : [],
    opportunities: supportedOpportunities,
    is_noise: Boolean(result?.is_noise),
  }
}

function validateGroupAnalysisBatch(payload, batch) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : null
  if (!groups) throw new Error('Group batch response is missing groups')
  const expectedIds = new Set(batch.map(item => item.input.group_id))
  const results = new Map()
  for (const item of groups) {
    const groupId = String(item?.group_id || '')
    const analysis = item?.analysis
    if (!expectedIds.has(groupId) || results.has(groupId)) continue
    if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) continue
    results.set(groupId, analysis)
  }
  if (results.size !== expectedIds.size) {
    throw new Error(`Group batch response acknowledged ${results.size}/${expectedIds.size} groups`)
  }
  return results
}

async function analyzeGroupBatch(batch) {
  const prompt = `Analyze these WhatsApp groups for a senior business executive. Treat each group independently and use only its evidence.

Groups:
${JSON.stringify(batch.map(item => item.input))}

Return ONLY valid JSON with exactly one entry per input group_id:
{
  "groups": [
    {
      "group_id": "copy the input group_id exactly",
      "analysis": {
        "group_type": "board_peers|management|employees|community|unknown",
        "my_role": "active_leader|active_participant|occasional_contributor|status_receiver|passive_observer",
        "ai_summary": "2-3 sentences: purpose, participants, and use",
        "key_topics": ["topic1", "topic2"],
        "communication_advice": "specific tone, frequency, and engagement angle",
        "notable_contacts": [{"name":"...","role_or_context":"...","why_notable":"..."}],
        "opportunities": [{"title":"...","description":"...","priority":"high|medium|low","evidence_refs":["exact canonical_ref"]}],
        "is_noise": false
      }
    }
  ]
}

Rules:
- Acknowledge every group_id, including groups with no opportunities.
- group_type: board_peers = board/investor/C-suite peers; management = colleagues/direct reports/project teams; employees = staff where the executive has authority; community = associations/alumni/networking/trade/social; unknown = insufficient evidence.
- Infer my_role from both message content and participation: active_leader usually >30%; active_participant 15-30%; occasional_contributor 5-15%; status_receiver 1-5%; passive_observer <1%.
- notable_contacts: use only for community groups or 1-2 people clearly worth a direct connection; otherwise [].
- opportunities: only specific business or relationship opportunities directly supported by evidence. Every opportunity must cite an exact canonical_ref from that same group; otherwise omit it. In community groups, actively check for leads, offered introductions, market intelligence, and events.
- communication_advice must reflect both group_type and my_role: strategic/concise for board peers, collaborative/directive for management, clear/accountable for employees, and selective/value-adding for communities. For passive/status roles, do not manufacture a need to engage.
- is_noise is true only for spam, broadcast, or automated groups without real human conversation.`

  const result = await createStructured({
    profile: 'bulk_structured',
    task_type: 'relationship_group_batch_extract_json',
    workflow_name: 'relationship_analysis',
    max_tokens: Math.min(8000, Math.max(2048, batch.length * 1200)),
    messages: [{ role: 'user', content: prompt }],
  })
  return validateGroupAnalysisBatch(result, batch)
}

async function analyzeGroups(items) {
  const results = new Map()
  const batches = batchGroupAnalysisInputs((items || []).filter(item => item.messages?.length > 0))

  for (const batch of batches) {
    try {
      const batchResults = await analyzeGroupBatch(batch)
      for (const item of batch) {
        results.set(item.input.group_id, normalizeGroupAnalysis(
          batchResults.get(item.input.group_id),
          item.messages
        ))
      }
    } catch (err) {
      console.error(`[analyzer] analyzeGroups batch error (${batch.map(item => item.input.group_id).join(', ')}):`, err.message)
      for (const item of batch) {
        results.set(item.input.group_id, { ...groupAnalysisDefaults(), analysis_error: err.message })
      }
    }
  }

  for (const item of items || []) {
    const groupId = String(item.group.wa_chat_id)
    if (!results.has(groupId)) results.set(groupId, groupAnalysisDefaults())
  }
  return results
}

async function analyzeGroup(group, messages) {
  const defaults = {
    group_type: 'unknown',
    my_role: 'unknown',
    ai_summary: null,
    key_topics: [],
    communication_advice: null,
    notable_contacts: [],
    opportunities: [],
    is_noise: false,
  }

  if (!messages || messages.length === 0) return defaults
  const results = await analyzeGroups([{ group, messages }])
  return results.get(String(group.wa_chat_id)) || defaults
}

/**
 * Extract mentioned people from Limitless lifelog markdowns.
 * Returns array of {name, contexts, relationship_hint}.
 */
async function analyzeLimitlessParticipants(lifelogs) {
  if (!lifelogs || lifelogs.length === 0) return []

  try {
    const combined = lifelogs.slice(0, 20).map(l =>
      `=== ${l.title || l.id} (${l.start_time ? new Date(l.start_time).toLocaleDateString() : ''}) ===\n${l.markdown_preview || ''}`
    ).join('\n\n')

    const prompt = `Extract all named people mentioned in these conversation transcripts (excluding "You" and "Unknown").

Transcripts:
${combined.slice(0, 4000)}

Return ONLY a JSON array:
[
  {
    "name": "Person Name",
    "contexts": ["brief context 1", "brief context 2"],
    "relationship_hint": "colleague|friend|client|family|unknown"
  }
]

Only include real named people. Skip generic terms like "someone", "they", etc.`

    const result = await createStructured({
      profile: 'bulk_structured',
      task_type: 'relationship_participant_extract_json',
      workflow_name: 'relationship_analysis',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    })
    return Array.isArray(result) ? result : []
  } catch (err) {
    console.error('[analyzer] analyzeLimitlessParticipants error:', err.message)
    return []
  }
}

/**
 * Generate actionable insights for a specific contact.
 */
async function generateContactInsights(contact, recentComms) {
  if (!contact) return []

  try {
    const commSummary = (recentComms || []).slice(0, 10).map(c =>
      `- [${c.source}] ${c.direction} on ${c.occurred_at ? new Date(c.occurred_at).toLocaleDateString() : ''}: ${(c.content_snippet || '').slice(0, 150)}`
    ).join('\n')

    const prompt = `Generate actionable insights for this contact relationship.

Contact: ${contact.display_name}
Company: ${contact.company || 'unknown'}
Relationship: ${contact.relationship_type} (${contact.relationship_strength})
Summary: ${contact.summary || ''}
Last interaction: ${contact.last_interaction_at ? new Date(contact.last_interaction_at).toLocaleDateString() : 'unknown'}

Recent communications:
${commSummary || '(none)'}

Return ONLY a JSON array of insights (max 3):
[
  {
    "insight_type": "opportunity|action_needed|topic",
    "title": "Short title",
    "description": "Actionable description",
    "priority": "high|medium|low"
  }
]

Only return insights that are genuinely actionable. Empty array if nothing notable.`

    const result = await createStructured({
      profile: 'reasoning_synthesis',
      task_type: 'relationship_insight_synthesis_json',
      workflow_name: 'relationship_analysis',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    })
    return Array.isArray(result) ? result : []
  } catch (err) {
    console.error('[analyzer] generateContactInsights error:', err.message)
    return []
  }
}

module.exports = {
  sleep,
  parseJSON,
  createStructured,
  analyzeDirectChatContact,
  analyzeGroup,
  analyzeGroups,
  batchGroupAnalysisInputs,
  validateGroupAnalysisBatch,
  analyzeLimitlessParticipants,
  generateContactInsights,
}
