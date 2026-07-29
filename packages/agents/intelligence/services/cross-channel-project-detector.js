'use strict'

const ACTION_PATTERNS = [
  /\b(need|needs|required|require|pending|stuck|blocked|delay|issue|problem|risk|concern)\b/i,
  /\b(send|share|review|approve|confirm|coordinate|follow up|follow-up|call|meet|schedule|arrange|apply|process|lead|contact|connect|intro|introduction)\b/i,
  /\b(waiting|awaiting|not closed|open item|next step|owner|deadline)\b/i,
]

const SELF_PATTERNS = [
  /\bprateek\s+sureka\b/i,
  /\bsureka\s+prateek\b/i,
]

const GENERIC_PROJECT_NAMES = [
  /\bcompany meetings?\b/i,
  /\bcoordination\b/i,
  /\bdealer sales planning\b/i,
  /\bmarket analysis\b/i,
]

const ADMIN_OPS_PATTERNS = [
  /\bvisa\b/i,
  /\bflight|hotel|cab|taxi|booking|travel plan\b/i,
  /\btds|challan|invoice|reimbursement|ledger|payment backlog|compliance workflow|family-office finance\/compliance workflow\b/i,
  /\botp|password|login|subscription\b/i,
]

const STRATEGIC_PATTERNS = [
  /\bacquisition|investment|capital|ipo|strategic|customer lead|distribution|partnership|board|fundrais/i,
]

const SOCIAL_GROUP_PATTERNS = [
  /\b(cousin|cousins|family banter|banter|jokes?|humor|humorous|pickup coordination|pickleball|reels?|songs?|casual chatter|everyday domestic chatter|friends?)\b/i,
]

const SOCIAL_NOISE_PATTERNS = [
  /\bsongs?\b/i,
  /\bfacebook\.com\/share\b/i,
  /\breels?\b/i,
  /\blisten\b/i,
  /\bpeaceful manner\b/i,
]

const STOPWORDS = new Set([
  'the','and','for','with','from','this','that','there','their','your','you','are','was','were','have','has','had',
  'project','group','whatsapp','meeting','call','team','update','please','thanks','thank','about','into','will','can',
  'our','his','her','him','she','they','them','been','being','also','would','could','should','what','when','where','who',
])

function compactText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function tokens(value) {
  const out = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&.-]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
  return Array.from(new Set(out))
}

function overlapScore(left, right) {
  const a = new Set(tokens(left))
  const b = new Set(tokens(right))
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / Math.min(a.size, b.size)
}

function sharedTerms(left, right) {
  const a = new Set(tokens(left))
  const b = new Set(tokens(right))
  return Array.from(a).filter(t => b.has(t))
}

function isSelfContact(contact) {
  const haystack = [contact?.display_name, contact?.name, contact?.email, Array.isArray(contact?.emails) ? contact.emails.join(' ') : '']
    .filter(Boolean).join(' ')
  return SELF_PATTERNS.some(pattern => pattern.test(haystack))
}

function isNoiseContact(contact = {}) {
  return contact.is_noise === true
    || String(contact.relationship_tier || '').toLowerCase() === 'noise'
    || String(contact.relationship_strength || '').toLowerCase() === 'noise'
}

function isGenericProject(project) {
  const name = String(project?.name || '')
  return GENERIC_PROJECT_NAMES.some(pattern => pattern.test(name))
}

function isTierOneContact(contact = {}) {
  return String(contact.relationship_tier || '').toLowerCase() === 'tier_1'
    || Number(contact.strategic_importance_score || 0) >= 80
}

function isLowValueAdminCandidate({ projectLabel, group, relevantDms, contact }) {
  const text = [projectLabel, group?.name, groupText(group), ...((relevantDms || []).map(x => x.text || ''))]
    .filter(Boolean).join(' ').toLowerCase()
  if (String(projectLabel || '').toLowerCase().includes('internal workflow')) return true
  const isAdmin = ADMIN_OPS_PATTERNS.some(pattern => pattern.test(text))
    && !STRATEGIC_PATTERNS.some(pattern => pattern.test(text))
  if (!isAdmin) return false
  if (/\bgolden\s+visa\b|\bpersonal\s+needs?\b|\bvisa\s+(application|documents?|process)\b|\binternal\s+workflow\b/i.test(text)) return true
  return !isTierOneContact(contact)
}

function isLowValueSocialCandidate({ relevantDms }) {
  const directText = (relevantDms || []).map(x => x.text || '').join(' ').toLowerCase()
  if (!directText) return false
  return SOCIAL_NOISE_PATTERNS.some(pattern => pattern.test(directText))
}

function isMembershipAdministrationCandidate({ relevantDms }) {
  const directText = (relevantDms || []).map(x => x.text || '').join(' ').toLowerCase()
  if (!directText) return false
  return /\b(membership|secondary member|join as secondary|how to apply|application process|member application)\b/i.test(directText)
    && !/\b(introduc(?:e|tion)|warm intro|customer lead|commercial lead|partnership|investment|capital)\b/i.test(directText)
}

function isLowValueSocialGroup(group = {}, knownGroupDerived = false) {
  if (knownGroupDerived) return false
  const text = groupText(group).toLowerCase()
  return SOCIAL_GROUP_PATTERNS.some(pattern => pattern.test(text))
}

function canonicalContactId(contact, canonicalContactMap = {}) {
  const raw = String(contact?.id || '')
  if (!raw) return raw
  return String(canonicalContactMap[raw] || canonicalContactMap[Number(raw)] || raw)
}

function withCanonicalContactId(contact, canonicalContactMap = {}) {
  const canonicalId = canonicalContactId(contact, canonicalContactMap)
  if (!canonicalId || String(contact?.id) === canonicalId) return contact
  return { ...contact, id: canonicalId, original_contact_id: contact.id }
}

function projectText(project) {
  return [project.name, project.description, project.ai_summary, Array.isArray(project.tags) ? project.tags.join(' ') : project.tags, project.next_action]
    .filter(Boolean).join(' ')
}

function groupText(group) {
  return [group.name, group.ai_summary, group.communication_advice, Array.isArray(group.key_topics) ? group.key_topics.join(' ') : group.key_topics, JSON.stringify(group.opportunities || [])]
    .filter(Boolean).join(' ')
}

function messageText(message) {
  return compactText(message.body || message.content || message.content_snippet || message.text || '', 1000)
}

function toTime(value) {
  const ts = value ? new Date(value).getTime() : NaN
  return Number.isFinite(ts) ? ts : null
}

function collectNearbyMessageText(messages = [], target, { before = 2, after = 2, windowMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  if (!Array.isArray(messages) || !target) return ''
  const targetTs = toTime(target.occurred_at || target.ts || target.created_at)
  const targetText = messageText(target)
  if (targetTs == null) return targetText
  const sorted = messages
    .map((message, index) => ({ message, index, ts: toTime(message.occurred_at || message.ts || message.created_at) }))
    .filter(item => item.ts != null)
    .sort((a, b) => a.ts - b.ts)
  const targetIndex = sorted.findIndex(item => item.message === target)
  if (targetIndex < 0) return targetText
  const parts = [targetText]
  for (let i = Math.max(0, targetIndex - before); i < targetIndex; i++) {
    const item = sorted[i]
    if (Math.abs(item.ts - targetTs) <= windowMs) parts.push(messageText(item.message))
  }
  for (let i = targetIndex + 1; i < Math.min(sorted.length, targetIndex + after + 1); i++) {
    const item = sorted[i]
    if (Math.abs(item.ts - targetTs) <= windowMs) parts.push(messageText(item.message))
  }
  return parts.filter(Boolean).join(' ')
}

function isActionable(text) {
  return ACTION_PATTERNS.some(pattern => pattern.test(text || ''))
}

function isNonSemanticMessageArtifact(text) {
  const normalized = compactText(text, 200).toLowerCase()
  return /^(?:👤\s*)?contact card$/.test(normalized)
}

function phoneFromJid(jid) {
  const m = String(jid || '').match(/(\d{7,15})@c\.us/)
  return m ? m[1] : null
}

function contactKey(contact) {
  if (contact.id != null) return String(contact.id)
  return String(contact.wa_jid || contact.chat_id || contact.phone || contact.name || '')
}

function participantKey(value) {
  return phoneFromJid(value) || String(value || '').trim().toLowerCase()
}

function buildParticipantContactMap(contacts = []) {
  const map = new Map()
  for (const c of contacts || []) {
    const values = []
    if (Array.isArray(c.wa_jids)) values.push(...c.wa_jids)
    if (c.wa_jid) values.push(c.wa_jid)
    if (c.chat_id) values.push(c.chat_id)
    if (Array.isArray(c.phone_numbers)) values.push(...c.phone_numbers)
    if (c.phone) values.push(c.phone)
    for (const value of values) {
      const key = participantKey(value)
      if (key) map.set(key, c)
    }
  }
  return map
}

function contactNameNeedles(contact = {}) {
  const names = [contact.display_name, contact.name].filter(Boolean).map(v => String(v).trim()).filter(v => v.length >= 5)
  return Array.from(new Set(names))
}

function mentionTokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []
}

function buildContactMentionIndex(contacts = []) {
  const entries = []
  const frequencies = new Map()
  for (const contact of contacts) {
    for (const name of contactNameNeedles(contact)) {
      const normalized = name.toLowerCase()
      const nameTokens = [...new Set(mentionTokens(normalized))]
      if (!nameTokens.length) continue
      entries.push({ contact, normalized, nameTokens })
      for (const token of nameTokens) frequencies.set(token, (frequencies.get(token) || 0) + 1)
    }
  }
  const byToken = new Map()
  for (const entry of entries) {
    const keyToken = [...entry.nameTokens].sort((left, right) => {
      const frequencyDelta = (frequencies.get(left) || 0) - (frequencies.get(right) || 0)
      return frequencyDelta || right.length - left.length || left.localeCompare(right)
    })[0]
    if (!byToken.has(keyToken)) byToken.set(keyToken, [])
    byToken.get(keyToken).push(entry)
  }
  return byToken
}

function contactsMentionedInText(text, contactMentionIndex = new Map()) {
  const lower = String(text || '').toLowerCase()
  if (!lower) return []
  const matches = new Map()
  for (const token of new Set(mentionTokens(lower))) {
    for (const entry of contactMentionIndex.get(token) || []) {
      if (lower.includes(entry.normalized) && entry.contact?.id != null) {
        matches.set(String(entry.contact.id), entry.contact)
      }
    }
  }
  return [...matches.values()]
}

function addParticipantContact(participants, contact) {
  if (contact?.id != null) participants.set(String(contact.id), contact)
}

function groupDerivedProjectLabel(group = {}, relevantDms = []) {
  const name = String(group.name || group.wa_chat_id || 'WhatsApp group')
  const context = `${name} ${relevantDms.map(x => x.text || '').join(' ')}`.toLowerCase()
  if (/\b(family office|internal|finance|compliance|audit|ledger|invoice|reimbursement|tds|challan|funds?)\b/i.test(context)) {
    return `${name}: internal workflow`
  }
  if (/\b(member|membership|introductions?|secondary member|join as secondary|gic)\b/i.test(context)) {
    return `${name}: relationship workflow`
  }
  return `${name}: group-sourced project`
}

function isKnownGroupDerivedProject(group = {}, relevantDms = []) {
  const context = `${String(group.name || '')} ${relevantDms.map(x => x.text || '').join(' ')}`.toLowerCase()
  return /\b(family office|internal|finance|compliance|audit|ledger|invoice|reimbursement|tds|challan|funds?|member|membership|introductions?|secondary member|join as secondary|gic)\b/i.test(context)
}

function shouldUseGroupDerivedProject(group = {}, projectGroupScore = 0, relevantDms = []) {
  return isKnownGroupDerivedProject(group, relevantDms)
}

function detectCrossChannelProjectSignals(input = {}) {
  const projects = input.projects || []
  const groups = input.groups || []
  const groupMessages = input.groupMessages || []
  const directMessages = input.directMessages || []
  const contacts = input.contacts || []
  const canonicalContactMap = input.canonicalContactMap || {}
  const minProjectGroupScore = input.minProjectGroupScore ?? 0.22
  const minProjectDmScore = input.minProjectDmScore ?? 0.16
  const minSharedProjectDmTerms = input.minSharedProjectDmTerms ?? 1
  const out = []
  const participantContactMap = buildParticipantContactMap(contacts)
  const contactMentionIndex = buildContactMentionIndex(contacts)

  const groupMessagesByChat = new Map()
  for (const m of groupMessages) {
    const chatId = m.chat_id || m.wa_chat_id
    if (!chatId) continue
    if (!groupMessagesByChat.has(chatId)) groupMessagesByChat.set(chatId, [])
    groupMessagesByChat.get(chatId).push(m)
  }

  const directByContact = new Map()
  for (const m of directMessages) {
    const key = String(canonicalContactMap[String(m.contact_id || '')] || canonicalContactMap[Number(m.contact_id)] || m.contact_id || contactKey(m.contact || {}) || '')
    if (!key) continue
    if (!directByContact.has(key)) directByContact.set(key, [])
    directByContact.get(key).push(m)
  }
  for (const messages of directByContact.values()) {
    messages.sort((a, b) => (toTime(a.occurred_at || a.ts || a.created_at) || 0) - (toTime(b.occurred_at || b.ts || b.created_at) || 0))
  }

  for (const project of projects) {
    if (isGenericProject(project)) continue
    const pText = projectText(project)
    if (!pText) continue
    for (const group of groups) {
      const gText = `${groupText(group)} ${(groupMessagesByChat.get(group.wa_chat_id || group.chat_id) || []).map(messageText).join(' ')}`
      const pgScore = Math.max(overlapScore(pText, groupText(group)), overlapScore(pText, gText))
      if (pgScore < minProjectGroupScore && !isKnownGroupDerivedProject(group)) continue

      const participants = new Map()
      for (const gm of groupMessagesByChat.get(group.wa_chat_id || group.chat_id) || []) {
        const raw = gm.participant || gm.author || gm.author_raw || gm.from || gm.from_jid
        const pKey = participantKey(raw)
        if (pKey) {
          const contact = participantContactMap.get(pKey)
          if (contact) addParticipantContact(participants, contact)
        }
        for (const mentioned of contactsMentionedInText(messageText(gm), contactMentionIndex)) addParticipantContact(participants, mentioned)
      }

      for (const rawContact of participants.values()) {
        const contact = withCanonicalContactId(rawContact, canonicalContactMap)
        if (isSelfContact(contact)) continue
        if (isNoiseContact(contact)) continue
        const dms = directByContact.get(String(contact.id)) || []
        const knownGroupDerived = isKnownGroupDerivedProject(group)
        const dmContext = knownGroupDerived ? gText : `${pText} ${gText}`
        const dmThreshold = knownGroupDerived ? 0.08 : minProjectDmScore
        const relevantDms = dms
          .map(dm => {
            const text = messageText(dm)
            const contextText = knownGroupDerived ? collectNearbyMessageText(dms, dm, { before: 2, after: 2 }) : collectNearbyMessageText(dms, dm, { before: 3, after: 3 })
            const projectScore = overlapScore(pText, text)
            const contextScore = overlapScore(dmContext, text)
            const contextualProjectScore = overlapScore(pText, `${text} ${contextText} ${gText}`)
            const projectTerms = sharedTerms(pText, text)
            const contextTerms = sharedTerms(dmContext, text)
            const contextualProjectTerms = sharedTerms(pText, `${text} ${contextText} ${gText}`)
            return {
              dm,
              text,
              context_text: compactText(contextText, 1000),
              score: Math.max(projectScore, contextScore, contextualProjectScore),
              projectScore,
              contextScore,
              contextualProjectScore,
              project_terms: projectTerms,
              context_terms: contextTerms,
              contextual_project_terms: contextualProjectTerms,
              shared_terms: Array.from(new Set([...projectTerms, ...contextTerms, ...contextualProjectTerms])),
            }
          })
          .filter(x => {
            if (isNonSemanticMessageArtifact(x.text)) return false
            if (x.score < dmThreshold || x.shared_terms.length < minSharedProjectDmTerms || !isActionable(x.text)) return false
            // For real project joins, the direct DM must carry enough project language in the broader local context.
            // This prevents a casual social DM like "send contact to buy" from inheriting unrelated group/project words.
            if (!knownGroupDerived) {
              const projectSignalCount = Math.max(x.project_terms.length, x.contextual_project_terms.length)
              if (projectSignalCount < 2) return false
            }
            return true
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
        if (!relevantDms.length) continue

        const latest = relevantDms
          .map(x => x.dm.occurred_at || x.dm.ts || x.dm.created_at)
          .filter(Boolean)
          .sort()
          .at(-1) || group.last_activity_at || project.last_activity_at || null
        const contactName = contact.display_name || contact.name || `contact ${contact.id}`
        const useGroupDerivedProject = shouldUseGroupDerivedProject(group, pgScore, relevantDms)
        const projectLabel = useGroupDerivedProject ? groupDerivedProjectLabel(group, relevantDms) : project.name
        const sourcePrefix = useGroupDerivedProject ? 'cross_channel_group_project' : 'cross_channel_project'
        const projectRef = useGroupDerivedProject ? 'group-derived' : project.id
        // A project-backed action belongs in the project surface. A group-derived
        // relationship cue has weaker decision value and must not masquerade as an
        // urgent operational task simply because it crossed two chats.
        const opportunityType = useGroupDerivedProject ? 'relationship_health' : 'project_match'
        const priority = useGroupDerivedProject ? 'medium' : 'high'
        const expectedValueScore = useGroupDerivedProject ? 50 : 78
        const title = `${projectLabel}: direct follow-up with ${contactName} from ${group.name || group.wa_chat_id}`
        if (isLowValueAdminCandidate({ projectLabel, group, relevantDms, contact })) continue
        if (useGroupDerivedProject && isMembershipAdministrationCandidate({ relevantDms })) continue
        if (isLowValueSocialGroup(group, knownGroupDerived)) continue
        if (isLowValueSocialCandidate({ relevantDms })) continue
        out.push({
          opportunity_type: opportunityType,
          title: compactText(title, 180),
          description: compactText(`Project appears active in WhatsApp group "${group.name || group.wa_chat_id}" and related direct conversation with ${contactName} contains actionable/pending language: ${relevantDms.map(x => `“${compactText(x.text, 180)}”`).join(' | ')}`, 1000),
          recommended_next_action: compactText(`Review the group context and direct chat with ${contactName}; convert the pending project item into owner/date/next message or dismiss if already closed.`, 260),
          why_now: latest ? `Cross-channel evidence last seen ${latest}: group project context plus direct actionable DM.` : 'Cross-channel group + direct-chat evidence found for an active project.',
          priority,
          confidence: Math.min(0.9, 0.62 + pgScore * 0.15 + relevantDms[0].score * 0.2),
          impact_score: expectedValueScore,
          urgency_score: useGroupDerivedProject ? 50 : 76,
          relationship_score: 72,
          expected_value_score: expectedValueScore,
          source_system: 'signals',
          source_ref: `${sourcePrefix}:${projectRef}:${group.id || group.wa_chat_id}:${contact.id}`,
          dedupe_key: `${sourcePrefix}:${projectRef}:${group.id || group.wa_chat_id}:${contact.id}`,
          primary_project_id: useGroupDerivedProject ? null : project.id,
          primary_contact_id: contact.id,
          contact_ids: [contact.id],
          metadata: {
            detector: 'cross_channel_project',
            group_id: group.id || null,
            wa_chat_id: group.wa_chat_id || group.chat_id || null,
            project_group_score: pgScore,
            used_group_derived_project: useGroupDerivedProject,
            group_derived_project_label: useGroupDerivedProject ? projectLabel : null,
            suppressed_project_id: useGroupDerivedProject ? project.id : null,
            suppressed_project_name: useGroupDerivedProject ? project.name : null,
            top_direct_score: relevantDms[0].score,
            candidate_score: pgScore + relevantDms[0].score,
            shared_project_dm_terms: relevantDms[0].shared_terms,
          },
          // Group/project rows are derived context, retained above in metadata.
          // Item evidence itself is always a canonical communication pointer.
          evidence: relevantDms
            .filter(x => x.dm.canonical_communication_id)
            .map(x => ({
              source_table: 'relationships.communications',
              source_id: x.dm.canonical_communication_id,
              source_ref: `relationships.communication:${x.dm.canonical_communication_id}`,
              occurred_at: x.dm.occurred_at || x.dm.ts || x.dm.created_at || null,
              quote: compactText(x.text, 500),
              relevance: x.score,
              metadata: { chat_id: x.dm.chat_id || null, contact_id: contact.id },
            })),
        })
      }
    }
  }

  const bestByGroupContact = new Map()
  for (const item of out) {
    const key = `${item.metadata?.group_id || item.metadata?.wa_chat_id || 'group'}:${item.primary_contact_id || 'contact'}`
    const current = bestByGroupContact.get(key)
    const itemScore = Number(item.metadata?.candidate_score || 0)
    const currentScore = Number(current?.metadata?.candidate_score || 0)
    if (!current || itemScore > currentScore || (itemScore === currentScore && Number(item.metadata?.project_group_score || 0) > Number(current.metadata?.project_group_score || 0))) {
      bestByGroupContact.set(key, item)
    }
  }

  const seen = new Set()
  return Array.from(bestByGroupContact.values()).filter(item => {
    if (seen.has(item.dedupe_key)) return false
    seen.add(item.dedupe_key)
    return true
  })
}

module.exports = {
  detectCrossChannelProjectSignals,
  buildContactMentionIndex,
  contactsMentionedInText,
  overlapScore,
  tokens,
}
