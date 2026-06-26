'use strict'

const ACTION_PATTERNS = [
  /\b(need|needs|required|require|pending|stuck|blocked|delay|issue|problem|risk|concern)\b/i,
  /\b(send|share|review|approve|confirm|coordinate|follow up|follow-up|call|meet|schedule|arrange)\b/i,
  /\b(waiting|awaiting|not closed|open item|next step|owner|deadline)\b/i,
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

function isActionable(text) {
  return ACTION_PATTERNS.some(pattern => pattern.test(text || ''))
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

function detectCrossChannelProjectSignals(input = {}) {
  const projects = input.projects || []
  const groups = input.groups || []
  const groupMessages = input.groupMessages || []
  const directMessages = input.directMessages || []
  const contacts = input.contacts || []
  const minProjectGroupScore = input.minProjectGroupScore ?? 0.18
  const minProjectDmScore = input.minProjectDmScore ?? 0.14
  const out = []
  const participantContactMap = buildParticipantContactMap(contacts)

  const groupMessagesByChat = new Map()
  for (const m of groupMessages) {
    const chatId = m.chat_id || m.wa_chat_id
    if (!chatId) continue
    if (!groupMessagesByChat.has(chatId)) groupMessagesByChat.set(chatId, [])
    groupMessagesByChat.get(chatId).push(m)
  }

  const directByContact = new Map()
  for (const m of directMessages) {
    const key = String(m.contact_id || contactKey(m.contact || {}) || '')
    if (!key) continue
    if (!directByContact.has(key)) directByContact.set(key, [])
    directByContact.get(key).push(m)
  }

  for (const project of projects) {
    const pText = projectText(project)
    if (!pText) continue
    for (const group of groups) {
      const gText = `${groupText(group)} ${(groupMessagesByChat.get(group.wa_chat_id || group.chat_id) || []).map(messageText).join(' ')}`
      const pgScore = Math.max(overlapScore(pText, groupText(group)), overlapScore(pText, gText))
      if (pgScore < minProjectGroupScore) continue

      const participants = new Map()
      for (const gm of groupMessagesByChat.get(group.wa_chat_id || group.chat_id) || []) {
        const raw = gm.participant || gm.author || gm.author_raw || gm.from || gm.from_jid
        const pKey = participantKey(raw)
        if (!pKey) continue
        const contact = participantContactMap.get(pKey)
        if (contact) participants.set(String(contact.id), contact)
      }

      for (const contact of participants.values()) {
        const dms = directByContact.get(String(contact.id)) || []
        const relevantDms = dms
          .map(dm => ({ dm, text: messageText(dm), score: overlapScore(pText, messageText(dm)) }))
          .filter(x => x.score >= minProjectDmScore && isActionable(x.text))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
        if (!relevantDms.length) continue

        const latest = relevantDms
          .map(x => x.dm.occurred_at || x.dm.ts || x.dm.created_at)
          .filter(Boolean)
          .sort()
          .at(-1) || group.last_activity_at || project.last_activity_at || null
        const contactName = contact.display_name || contact.name || `contact ${contact.id}`
        const title = `${project.name}: direct follow-up with ${contactName} from ${group.name || group.wa_chat_id}`
        out.push({
          opportunity_type: 'meeting_action',
          title: compactText(title, 180),
          description: compactText(`Project appears active in WhatsApp group "${group.name || group.wa_chat_id}" and related direct conversation with ${contactName} contains actionable/pending language: ${relevantDms.map(x => `“${compactText(x.text, 180)}”`).join(' | ')}`, 1000),
          recommended_next_action: compactText(`Review the group context and direct chat with ${contactName}; convert the pending project item into owner/date/next message or dismiss if already closed.`, 260),
          why_now: latest ? `Cross-channel evidence last seen ${latest}: group project context plus direct actionable DM.` : 'Cross-channel group + direct-chat evidence found for an active project.',
          priority: 'high',
          confidence: Math.min(0.9, 0.62 + pgScore * 0.15 + relevantDms[0].score * 0.2),
          impact_score: 78,
          urgency_score: 76,
          relationship_score: 72,
          expected_value_score: 78,
          source_system: 'signals',
          source_ref: `cross_channel_project:${project.id}:${group.id || group.wa_chat_id}:${contact.id}`,
          dedupe_key: `cross_channel_project:${project.id}:${group.id || group.wa_chat_id}:${contact.id}`,
          primary_project_id: project.id,
          primary_contact_id: contact.id,
          contact_ids: [contact.id],
          metadata: {
            detector: 'cross_channel_project',
            group_id: group.id || null,
            wa_chat_id: group.wa_chat_id || group.chat_id || null,
            project_group_score: pgScore,
            top_direct_score: relevantDms[0].score,
          },
          evidence: [
            {
              source_table: 'relationships.groups',
              source_id: group.id || group.wa_chat_id,
              source_ref: `group:${group.id || group.wa_chat_id}`,
              occurred_at: group.last_activity_at || group.updated_at || null,
              quote: compactText(groupText(group), 500),
              relevance: pgScore,
              metadata: { wa_chat_id: group.wa_chat_id || group.chat_id || null },
            },
            ...relevantDms.map(x => ({
              source_table: 'public.messages',
              source_id: x.dm.source_id || x.dm.id || `${x.dm.chat_id || contact.id}:${x.dm.ts || x.dm.occurred_at || ''}`,
              source_ref: `whatsapp:${x.dm.source_id || x.dm.id || ''}`,
              occurred_at: x.dm.occurred_at || x.dm.ts || x.dm.created_at || null,
              quote: compactText(x.text, 500),
              relevance: x.score,
              metadata: { chat_id: x.dm.chat_id || null, contact_id: contact.id },
            })),
          ],
        })
      }
    }
  }

  const seen = new Set()
  return out.filter(item => {
    if (seen.has(item.dedupe_key)) return false
    seen.add(item.dedupe_key)
    return true
  })
}

module.exports = {
  detectCrossChannelProjectSignals,
  overlapScore,
  tokens,
}
