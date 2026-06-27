const test = require('node:test')
const assert = require('node:assert/strict')
const { detectCrossChannelProjectSignals } = require('../services/cross-channel-project-detector')

test('detects project work spanning WhatsApp group and direct member chat', () => {
  const projects = [{
    id: 42,
    name: 'Tyre Catalogue Revamp',
    description: 'Build tyre fitment guide and catalogue content for website launch',
    status: 'active',
    last_activity_at: '2026-06-24T10:00:00Z',
  }]
  const groups = [{
    id: 7,
    wa_chat_id: '120@g.us',
    name: 'Tyre Catalogue Team',
    ai_summary: 'Team is coordinating tyre fitment guide content, catalogue pages, and website launch approvals.',
    last_activity_at: '2026-06-25T10:00:00Z',
  }]
  const contacts = [{ id: 99, display_name: 'Amit Supplier', wa_jids: ['919999999999@c.us'] }]
  const groupMessages = [
    { chat_id: '120@g.us', participant: '919999999999@c.us', body: 'Need fitment guide content before website launch', ts: '2026-06-25T09:00:00Z' },
  ]
  const directMessages = [
    { contact_id: 99, chat_id: '919999999999@c.us', body: 'Pending catalogue fitment data. Please confirm approval and send latest tyre content.', ts: '2026-06-25T11:00:00Z' },
  ]

  const opportunities = detectCrossChannelProjectSignals({ projects, groups, contacts, groupMessages, directMessages })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_project_id, 42)
  assert.equal(opportunities[0].primary_contact_id, 99)
  assert.equal(opportunities[0].opportunity_type, 'meeting_action')
  assert.match(opportunities[0].description, /direct conversation/i)
  assert.ok(opportunities[0].evidence.length >= 2)
})

test('uses group context to connect direct tasks whose wording differs from project name', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 8, name: 'Grapevine ERP Implementation', description: 'ERP rollout and operational issue closure' }],
    groups: [{ id: 9, wa_chat_id: 'erp@g.us', name: 'ERP rollout group', ai_summary: 'Gaurav and team are resolving strategic rollout approvals and customer migration issues for Grapevine ERP' }],
    contacts: [{ id: 10, display_name: 'Gaurav Partner', wa_jids: ['911222222222@c.us'] }],
    groupMessages: [{ chat_id: 'erp@g.us', participant: '911222222222@c.us', body: 'Strategic rollout approval pending for customer migration, Gaurav to coordinate next step' }],
    directMessages: [{ contact_id: 10, chat_id: '911222222222@c.us', body: 'Please review rollout approval pending and confirm next step for customer migration issue' }],
  })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_project_id, 8)
  assert.equal(opportunities[0].primary_contact_id, 10)
})

test('maps a named group message to a contact even when WhatsApp participant id is an unmapped LID', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 16, name: 'YPO Business Corridor', description: 'YPO introductions and business corridor networking' }],
    groups: [{ id: 17, wa_chat_id: 'ypo@g.us', name: 'YPO India Business Corridor', ai_summary: 'Members request business introductions, owner connects, YPO GIC referrals and project leads' }],
    contacts: [{ id: 85, display_name: 'Vivek Gupta', wa_jids: ['919820722245@c.us'] }],
    groupMessages: [{ chat_id: 'ypo@g.us', participant: '39522305876204@lid', body: 'Hi any lead / contact with Mokobara owners / management ? Rgds Vivek Gupta YPO GIC' }],
    directMessages: [{ contact_id: 85, chat_id: '919820722245@c.us', body: 'Process for a YPO BOM member to join as secondary member of GIC. How to apply' }],
  })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_contact_id, 85)
  assert.match(opportunities[0].description, /Vivek Gupta|YPO/i)
})

test('keeps only the best project candidate per group/contact pair', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [
      { id: 1, name: 'Generic YPO Project', description: 'YPO member networking' },
      { id: 2, name: 'YPO Business Corridor', description: 'YPO GIC business introductions and corridor leads' },
    ],
    groups: [{ id: 17, wa_chat_id: 'ypo@g.us', name: 'YPO India Business Corridor', ai_summary: 'Members request business introductions, owner connects, YPO GIC referrals and project leads' }],
    contacts: [{ id: 85, display_name: 'Vivek Gupta', wa_jids: ['919820722245@c.us'] }],
    groupMessages: [{ chat_id: 'ypo@g.us', participant: '39522305876204@lid', body: 'Hi any lead / contact with Mokobara owners / management ? Rgds Vivek Gupta YPO GIC' }],
    directMessages: [{ contact_id: 85, chat_id: '919820722245@c.us', body: 'Process for a YPO BOM member to join as secondary member of GIC. How to apply' }],
  })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_project_id, null)
  assert.match(opportunities[0].title, /YPO GIC membership \/ introductions/)
  assert.equal(opportunities[0].metadata.used_group_derived_project, true)
})

test('does not force YPO GIC evidence into unrelated HR project names', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 47, name: 'HR & Payroll Management', description: 'payroll hr employee onboarding compliance' }],
    groups: [{ id: 16, wa_chat_id: 'ypo@g.us', name: 'YPO India Business Corridor 🇮🇳', ai_summary: 'Members request business introductions, YPO GIC referrals and owner connects' }],
    contacts: [{ id: 85, display_name: 'Vivek Gupta', wa_jids: ['919820722245@c.us'] }],
    groupMessages: [{ chat_id: 'ypo@g.us', participant: '39522305876204@lid', body: 'Hi any lead / contact with Mokobara owners / management ? Rgds Vivek Gupta YPO GIC' }],
    directMessages: [{ contact_id: 85, chat_id: '919820722245@c.us', body: 'Process for a YPO BOM member to join as secondary member of GIC. How to apply' }],
  })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_project_id, null)
  assert.match(opportunities[0].title, /YPO GIC membership \/ introductions/)
  assert.doesNotMatch(opportunities[0].title, /HR & Payroll/i)
})

test('does not promote group-only project chatter without direct actionable member evidence', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 1, name: 'Dubai Property Review', description: 'Review Dubai property options' }],
    groups: [{ id: 2, wa_chat_id: 'g@g.us', name: 'Dubai Property', ai_summary: 'Dubai property discussion' }],
    contacts: [{ id: 3, display_name: 'Broker', wa_jids: ['911111111111@c.us'] }],
    groupMessages: [{ chat_id: 'g@g.us', participant: '911111111111@c.us', body: 'Dubai property discussion' }],
    directMessages: [{ contact_id: 3, body: 'Thanks', chat_id: '911111111111@c.us' }],
  })
  assert.equal(opportunities.length, 0)
})

test('does not promote self-contact or generic project buckets as cross-channel work', () => {
  const base = {
    groups: [{ id: 95, wa_chat_id: '120@g.us', name: 'YPO Travel & Dining II', ai_summary: 'Travel dining meeting coordination' }],
    groupMessages: [{ chat_id: '120@g.us', participant: '919999999999@c.us', body: 'Please coordinate meeting and dining plan' }],
    directMessages: [{ contact_id: 284, chat_id: '919999999999@c.us', body: 'Please send details and meet tonight for coordination planning' }],
  }
  assert.equal(detectCrossChannelProjectSignals({
    ...base,
    projects: [{ id: 66, name: 'Company Meetings and Coordination', description: 'Company meetings and coordination' }],
    contacts: [{ id: 284, display_name: 'Prateek Sureka', wa_jids: ['919999999999@c.us'] }],
  }).length, 0)
  assert.equal(detectCrossChannelProjectSignals({
    ...base,
    projects: [{ id: 67, name: 'Specific Travel Program', description: 'Travel dining itinerary program' }],
    contacts: [{ id: 284, display_name: 'Prateek Sureka', wa_jids: ['919999999999@c.us'] }],
  }).length, 0)
})

test('canonicalizes duplicate contact ids before source_ref/dedupe generation', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 71, name: 'Hartex Partnership', description: 'Hartex distribution partnership strategic customer lead' }],
    groups: [{ id: 94, wa_chat_id: 'frontier@g.us', name: 'The Final Frontier', ai_summary: 'Hartex partnership customer lead and distribution discussion' }],
    contacts: [{ id: 92, display_name: 'Gaurav Atha', wa_jids: ['919748983882@c.us'] }],
    groupMessages: [{ chat_id: 'frontier@g.us', participant: '919748983882@c.us', body: 'Gaurav please coordinate Hartex partnership customer lead next step' }],
    directMessages: [{ contact_id: 3134, chat_id: '919748983882@c.us', body: 'Need follow up on Hartex partnership and customer lead approval' }],
    canonicalContactMap: { 92: '3134' },
  })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_contact_id, '3134')
  assert.match(opportunities[0].source_ref, /:3134$/)
  assert.doesNotMatch(opportunities[0].source_ref, /:92$/)
})

test('suppresses low-value admin cross-channel candidates unless contact is tier one', () => {
  const base = {
    projects: [{ id: 57, name: 'YPO UAE Golden Visa Initiative', description: 'visa application processing and travel documentation' }],
    groups: [{ id: 87, wa_chat_id: 'ypo@g.us', name: 'YPO Personal Needs', ai_summary: 'golden visa process application coordination' }],
    groupMessages: [{ chat_id: 'ypo@g.us', participant: '919748983882@c.us', body: 'Need golden visa documents and application process confirmation' }],
    directMessages: [{ contact_id: 3134, chat_id: '919748983882@c.us', body: 'Please confirm visa application process and documents pending' }],
  }
  assert.equal(detectCrossChannelProjectSignals({
    ...base,
    contacts: [{ id: 3134, display_name: 'Gaurav Atha', relationship_tier: 'tier_2', strategic_importance_score: 60, wa_jids: ['919748983882@c.us'] }],
  }).length, 0)
  assert.equal(detectCrossChannelProjectSignals({
    ...base,
    contacts: [{ id: 3134, display_name: 'Gaurav Atha', relationship_tier: 'tier_1', strategic_importance_score: 90, wa_jids: ['919748983882@c.us'] }],
  }).length, 1)
})
