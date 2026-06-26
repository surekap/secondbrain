const test = require('node:test')
const assert = require('node:assert/strict')
const { detectRelationshipOpenLoops } = require('../services/relationship-open-loop-detector')

test('surfaces Sivaram remittance open loop', () => {
  const out = detectRelationshipOpenLoops({
    contacts: [{ id: 35, display_name: 'Sivaram Padmanabhan', relationship_tier: 'tier_1', relationship_type: 'professional_contact' }],
    directMessages: [{ contact_id: 35, chat_id: '919910111649@c.us', source_id: 'sivaram-1', ts: '2026-03-30T09:42:16Z', from_me: false, body: "Good afternoon Prateek. We don't seem to have received your remittance ( 11,86, 890) against Drawdown due 27 th March. Appreciate your looking at it and ensure remittance by tomorrow please" }]
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].opportunity_type, 'follow_up')
  assert.match(out[0].title, /Sivaram/)
  assert.match(out[0].description, /remittance|Drawdown/i)
})

test('surfaces Nikhil cancelled diving trip / plan loop even for weak friend', () => {
  const out = detectRelationshipOpenLoops({
    contacts: [{ id: 63, display_name: 'Nikhil Mehra', relationship_tier: 'noise', relationship_type: 'friend', is_noise: true }],
    directMessages: [{ contact_id: 63, source_id: 'nikhil-1', ts: '2026-03-06T06:09:54Z', from_me: false, body: 'Am assuming diving trip is cancelled. Now the plan is ?' }]
  })
  assert.equal(out.length, 1)
  assert.match(out[0].description, /diving trip|plan/i)
})

test('surfaces Vivek Gupta membership/intro direct-chat loop', () => {
  const out = detectRelationshipOpenLoops({
    contacts: [{ id: 85, display_name: 'Vivek Gupta', relationship_tier: 'tier_2', relationship_type: 'professional_contact' }],
    directMessages: [{ contact_id: 85, source_id: 'vivek-1', ts: '2026-03-16T05:36:23Z', from_me: false, body: 'Process for a YPO BOM member to join as secondary member of GIC' }]
  })
  assert.equal(out.length, 1)
  assert.match(out[0].description, /YPO|GIC/i)
})

test('does not surface closed direct-chat loop', () => {
  const out = detectRelationshipOpenLoops({
    contacts: [{ id: 1, display_name: 'Closed Contact', relationship_tier: 'tier_2', relationship_type: 'professional_contact' }],
    directMessages: [
      { contact_id: 1, source_id: 'a', ts: '2026-03-01T00:00:00Z', from_me: false, body: 'Please send the document' },
      { contact_id: 1, source_id: 'b', ts: '2026-03-01T01:00:00Z', from_me: true, body: 'Sent and closed' },
    ]
  })
  assert.equal(out.length, 0)
})
