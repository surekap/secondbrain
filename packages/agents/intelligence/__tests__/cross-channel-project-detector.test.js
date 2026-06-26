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
