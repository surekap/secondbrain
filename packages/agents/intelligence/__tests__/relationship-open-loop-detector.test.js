const test = require('node:test')
const assert = require('node:assert/strict')
const { detectRelationshipOpenLoops } = require('../services/relationship-open-loop-detector')

const detect = (input) => detectRelationshipOpenLoops({ now: '2026-04-01T00:00:00Z', ...input })

test('surfaces Sivaram remittance open loop', () => {
  const out = detect({
    contacts: [{ id: 35, display_name: 'Sivaram Padmanabhan', relationship_tier: 'tier_1', relationship_type: 'professional_contact' }],
    directMessages: [{ contact_id: 35, canonical_communication_id: 7331, chat_id: '919910111649@c.us', source_id: 'sivaram-1', ts: '2026-03-30T09:42:16Z', from_me: false, body: "Good afternoon Prateek. We don't seem to have received your remittance ( 11,86, 890) against Drawdown due 27 th March. Appreciate your looking at it and ensure remittance by tomorrow please" }]
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].opportunity_type, 'follow_up')
  assert.match(out[0].title, /Sivaram/)
  assert.match(out[0].description, /remittance|Drawdown/i)
  assert.equal(out[0].evidence[0].source_table, 'relationships.communications')
  assert.equal(out[0].evidence[0].source_id, 7331)
})

test('suppresses user-confirmed false positive Nikhil diving-trip attribution', () => {
  const out = detect({
    contacts: [{ id: 63, display_name: 'Nikhil Mehra', relationship_tier: 'noise', relationship_type: 'friend', is_noise: true }],
    directMessages: [{ contact_id: 63, source_id: 'nikhil-1', ts: '2026-03-06T06:09:54Z', from_me: false, body: 'Am assuming diving trip is cancelled. Now the plan is ?' }]
  })
  assert.equal(out.length, 0)
})

test('suppresses travel-booking cancellation and refund administration', () => {
  const out = detect({
    contacts: [{ id: 103, display_name: 'Vaibhav Tamboli', relationship_tier: 'tier_2', relationship_type: 'friend' }],
    directMessages: [{ contact_id: 103, source_id: 'vaibhav-travel-1', ts: '2026-03-20T03:52:17Z', from_me: false, body: 'GM bro. I would like to cancel my Svalbard booking and apply for refund. Please convince Preya to get me a refund.' }]
  })
  assert.equal(out.length, 0)
})

test('surfaces Vivek Gupta membership/intro direct-chat loop', () => {
  const out = detect({
    contacts: [{ id: 85, display_name: 'Vivek Gupta', relationship_tier: 'tier_2', relationship_type: 'professional_contact' }],
    directMessages: [{ contact_id: 85, source_id: 'vivek-1', ts: '2026-03-16T05:36:23Z', from_me: false, body: 'Process for a YPO BOM member to join as secondary member of GIC' }]
  })
  assert.equal(out.length, 1)
  assert.match(out[0].description, /YPO|GIC/i)
})

test('does not surface closed direct-chat loop', () => {
  const out = detect({
    contacts: [{ id: 1, display_name: 'Closed Contact', relationship_tier: 'tier_2', relationship_type: 'professional_contact' }],
    directMessages: [
      { contact_id: 1, source_id: 'a', ts: '2026-03-01T00:00:00Z', from_me: false, body: 'Please send the document' },
      { contact_id: 1, source_id: 'b', ts: '2026-03-01T01:00:00Z', from_me: true, body: 'Sent and closed' },
    ]
  })
  assert.equal(out.length, 0)
})

test('does not surface a direct-chat loop whose evidence is older than 30 days', () => {
  const out = detectRelationshipOpenLoops({
    now: '2026-07-20T00:00:00Z',
    contacts: [{ id: 35, display_name: 'Sivaram Padmanabhan', relationship_tier: 'tier_1', relationship_type: 'professional_contact' }],
    directMessages: [{ contact_id: 35, source_id: 'stale-remittance', ts: '2026-03-30T09:42:16Z', from_me: false, body: 'Please ensure remittance by tomorrow.' }]
  })
  assert.equal(out.length, 0)
})
