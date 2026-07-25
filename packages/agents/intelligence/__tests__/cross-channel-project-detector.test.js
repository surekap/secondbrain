const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildContactMentionIndex,
  contactsMentionedInText,
  detectCrossChannelProjectSignals,
} = require('../services/cross-channel-project-detector')

test('indexes contact-name mentions instead of scanning the full address book per message', () => {
  const contacts = Array.from({ length: 10000 }, (_, index) => ({
    id: index + 1,
    display_name: `Person ${String(index + 1).padStart(5, '0')} Distinctive${index + 1}`,
  }))
  const index = buildContactMentionIndex(contacts)
  const matches = contactsMentionedInText('Please ask Person 09999 Distinctive9999 to review this.', index)

  assert.deepEqual(matches.map(contact => contact.id), [9999])
  assert.ok(index.size > 0)
})

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
    { contact_id: 99, canonical_communication_id: 991, chat_id: '919999999999@c.us', body: 'Pending catalogue fitment data. Please confirm approval and send latest tyre content.', ts: '2026-06-25T11:00:00Z' },
  ]

  const opportunities = detectCrossChannelProjectSignals({ projects, groups, contacts, groupMessages, directMessages })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_project_id, 42)
  assert.equal(opportunities[0].primary_contact_id, 99)
  assert.equal(opportunities[0].opportunity_type, 'project_match')
  assert.match(opportunities[0].description, /direct conversation/i)
  assert.ok(opportunities[0].evidence.length >= 1)
  assert.ok(opportunities[0].evidence.every(item => item.source_table === 'relationships.communications'))
  assert.equal(opportunities[0].evidence[0].source_id, 991)
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
  assert.match(opportunities[0].title, /relationship workflow/i)
  assert.equal(opportunities[0].metadata.used_group_derived_project, true)
  assert.equal(opportunities[0].opportunity_type, 'relationship_health')
  assert.equal(opportunities[0].priority, 'medium')
  assert.equal(opportunities[0].expected_value_score, 50)
})

test('does not force YPO GIC evidence into unrelated HR project names', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 47, name: 'HR & Payroll Management', description: 'payroll hr employee onboarding compliance' }],
    groups: [{ id: 16, wa_chat_id: 'ypo@g.us', name: 'YPO India Business Corridor 🇮🇳', ai_summary: 'Members request business introductions, YPO GIC referrals and owner connects' }],
    contacts: [{ id: 85, display_name: 'Vivek Gupta', wa_jids: ['919820722245@c.us'] }],
    groupMessages: [{ chat_id: 'ypo@g.us', participant: '39522305876204@lid', body: 'Hi any lead / contact with Mokobara owners / management ? Rgds Vivek Gupta YPO GIC' }],
    directMessages: [{ contact_id: 85, chat_id: '919820722245@c.us', body: 'Process for a YPO BOM member to join as secondary member of GIC. How to apply' }],
  })
  assert.equal(opportunities.length, 0)
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

test('does not turn WhatsApp contact-card artifacts into cross-channel project actions', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 49, name: 'Estate Planning & Family Trust', description: 'family trust and estate planning work' }],
    groups: [{ id: 41, wa_chat_id: 'legal@g.us', name: 'YPO Legal Network', ai_summary: 'Members discuss estate planning and trusts.' }],
    contacts: [{ id: 10707, display_name: 'Prashant Hingorani', wa_jids: ['919999999999@c.us'] }],
    groupMessages: [{ chat_id: 'legal@g.us', participant: '919999999999@c.us', body: 'Estate planning and family trust discussion' }],
    directMessages: [
      { contact_id: 10707, canonical_communication_id: 620282, chat_id: '919999999999@c.us', body: '👤 Contact card', ts: '2026-06-08T04:23:08Z' },
      { contact_id: 10707, canonical_communication_id: 640452, chat_id: '919999999999@c.us', body: '👤 Contact card', ts: '2026-07-12T15:14:13Z' },
    ],
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

test('does not promote cross-channel work for contacts already classified as noise', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 54, name: 'Investment Opportunities and Strategy', description: 'investment dividend capital strategy' }],
    groups: [{ id: 38, wa_chat_id: 'fin@g.us', name: 'MyEO-INL-FinServ&Invest', ai_summary: 'Investment strategy and finance opportunities' }],
    contacts: [{
      id: 12,
      display_name: 'Vested Finance',
      relationship_tier: 'noise',
      relationship_strength: 'noise',
      is_noise: true,
      wa_jids: ['918591400209@c.us'],
    }],
    groupMessages: [{ chat_id: 'fin@g.us', participant: '918591400209@c.us', body: 'Investment opportunity discussion and dividend strategy' }],
    directMessages: [{ contact_id: 12, chat_id: '918591400209@c.us', body: 'Dividend payout received. Please review investment details and confirm.' }],
  })
  assert.equal(opportunities.length, 0)
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

test('suppresses low-value admin cross-channel candidates even for tier one contacts', () => {
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
  }).length, 0)
})

test('suppresses family-office compliance admin joins even for family contacts', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 5, name: 'Hartex Banking & Payment Systems', description: 'payments banking operations' }],
    groups: [{ id: 35, wa_chat_id: 'fo@g.us', name: 'Sureka Family Office Internal', ai_summary: 'Family-office finance/compliance workflow: TDS challan invoice reimbursement ledger and audit coordination' }],
    contacts: [{ id: 1, display_name: 'Anupama Sureka', relationship_tier: 'tier_1', strategic_importance_score: 95, wa_jids: ['919111111111@c.us'] }],
    groupMessages: [{ chat_id: 'fo@g.us', participant: '919111111111@c.us', body: 'Please coordinate TDS challan and invoice compliance workflow' }],
    directMessages: [{ contact_id: 1, chat_id: '919111111111@c.us', body: 'Need the ledger and reimbursement confirmation pending' }],
  })
  assert.equal(opportunities.length, 0)
})

test('does not promote a project join when the direct DM only matches unrelated group/social context', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 54, name: 'Investment Opportunities and Strategy', description: 'investment capital strategy portfolio allocation' }],
    groups: [{ id: 44, wa_chat_id: 'social@g.us', name: "Nandita's Men", ai_summary: 'Mixed social group where members discuss investment strategy in one thread and share songs, family reels, social listening suggestions, and casual Facebook links in another.' }],
    contacts: [{ id: 118, display_name: 'Dinesh Kumar Jhunjhnuwala', relationship_tier: 'tier_1', strategic_importance_score: 85, wa_jids: ['919222222222@c.us'] }],
    groupMessages: [{ chat_id: 'social@g.us', participant: '919222222222@c.us', body: 'Investment capital strategy came up earlier; separately please share the two songs and Facebook reel in the social group' }],
    directMessages: [{ contact_id: 118, chat_id: '919222222222@c.us', body: 'Can you share your two investment songs. Will want to listen to them in a peaceful manner. https://www.facebook.com/share/r/abc' }],
  })
  assert.equal(opportunities.length, 0)
})

test('does not promote Radhika Pitti / CA Toppers banter into a project join', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 64, name: 'Real Estate and Investment Review', description: 'Review and evaluation of real estate investment opportunities including Dubai property, family real estate business proposals, and broader investment strategy discussions with advisors.' }],
    groups: [{ id: 15231, wa_chat_id: '120363426696797016@g.us', name: 'CA Toppers - JJwala India Cousins', ai_summary: 'Humorous cousin/friends banter, pickup coordination, jokes, and everyday chatter; no serious work discussions.' }],
    contacts: [{ id: 99, display_name: 'Radhika Pitti', relationship_tier: 'tier_2', strategic_importance_score: 50, wa_jids: ['917702412323@c.us'] }],
    groupMessages: [
      { chat_id: '120363426696797016@g.us', participant: '917702412323@c.us', body: 'Radhika visited Mumbai and Nandita needed something picked up so she coordinated it', ts: '2026-06-25T11:13:10Z' },
      { chat_id: '120363426696797016@g.us', participant: '917702412323@c.us', body: 'lol', ts: '2026-06-25T11:14:10Z' },
    ],
    directMessages: [{ contact_id: 99, chat_id: '917702412323@c.us', body: 'Pl send contact to buy', ts: '2026-03-21T03:31:28Z' }],
  })
  assert.equal(opportunities.length, 0)
})

test('uses longer adjacent context to keep real project follow-ups alive', () => {
  const opportunities = detectCrossChannelProjectSignals({
    projects: [{ id: 64, name: 'Real Estate and Investment Review', description: 'Review and evaluation of real estate investment opportunities including Dubai property and investment strategy discussions.' }],
    groups: [{ id: 15231, wa_chat_id: '120363426696797016@g.us', name: 'Real Estate Review', ai_summary: 'Context about Dubai property review and investment decisions.' }],
    contacts: [{ id: 99, display_name: 'Radhika Pitti', relationship_tier: 'tier_2', strategic_importance_score: 50, wa_jids: ['917702412323@c.us'] }],
    groupMessages: [
      { chat_id: '120363426696797016@g.us', participant: '917702412323@c.us', body: 'Dubai property investment review: maintenance charges and next decision', ts: '2026-06-25T11:10:10Z' },
      { chat_id: '120363426696797016@g.us', participant: '917702412323@c.us', body: 'Please confirm the property review and investment details', ts: '2026-06-25T11:11:10Z' },
    ],
    directMessages: [
      { contact_id: 99, chat_id: '917702412323@c.us', body: 'Need one contact to buy', ts: '2026-06-25T11:12:10Z' },
      { contact_id: 99, chat_id: '917702412323@c.us', body: 'Review the investment property notes', ts: '2026-06-25T11:13:10Z' },
      { contact_id: 99, chat_id: '917702412323@c.us', body: 'Send the latest property details', ts: '2026-06-25T11:14:10Z' },
    ],
  })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].primary_contact_id, 99)
  assert.equal(opportunities[0].primary_project_id, 64)
})
