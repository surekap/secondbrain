const test = require('node:test')
const assert = require('node:assert/strict')
const {
  detectHomeImprovementOpportunities,
  isHomeImprovementEmail,
  isHomeImprovementLifelog,
} = require('../services/home-improvement-detector')

test('detects home renovation evidence from emails', () => {
  const email = {
    id: 57354,
    subject: "Concept renders and services drawings for Prateek & Nanditha's residence",
    from_address: '"jxp designhouse" <jxpdesignhouse@gmail.com>',
    date: '2026-06-17T15:31:31+05:30',
    body_text: 'PFA the concept render document and service drawings AutoCAD files, which include Floor plan, Brick marking & demolition layout, Electrical layout, Plumbing layout, HVAC layout, RCP layout. Regards, Vijay Jxtapose',
  }

  assert.equal(isHomeImprovementEmail(email), true)
  const opportunities = detectHomeImprovementOpportunities({ emails: [email], lifelogs: [] })
  assert.equal(opportunities.length, 1)
  assert.match(opportunities[0].source_ref, /^home_improvement_project:/)
  assert.equal(opportunities[0].metadata.email_count, 1)
  assert.equal(opportunities[0].evidence[0].source_table, 'email.emails')
  assert.match(opportunities[0].description, /concept renders/i)
  assert.match(opportunities[0].recommended_next_action, /home-renovation packet|GFC drawings/i)
})

test('combines home renovation lifelog and emails into one corroborated opportunity', () => {
  const lifelog = {
    id: 'life-1',
    title: 'Discussion about house renovation',
    start_time: '2026-05-21T06:04:23Z',
    markdown: 'meeting with just to pose for the renovation of the house with Gayatri and Nandita',
  }
  const email = {
    id: 57375,
    subject: "Re: Concept renders and services drawings for Prateek & Nanditha's residence",
    from_address: '"jxp designhouse" <jxpdesignhouse@gmail.com>',
    date: '2026-06-23T10:04:58+05:30',
    body_text: 'PFA the window drawing intent. Regards, Vijay Jxtapose',
  }

  assert.equal(isHomeImprovementLifelog(lifelog), true)
  const opportunities = detectHomeImprovementOpportunities({ lifelogs: [lifelog], emails: [email] })
  assert.equal(opportunities.length, 1)
  assert.equal(opportunities[0].metadata.email_count, 1)
  assert.equal(opportunities[0].metadata.lifelog_count, 1)
  assert.equal(opportunities[0].evidence.length, 2)
  assert.match(opportunities[0].why_now, /2026-06-23/)
})

test('uses the canonical communication id for canonical evidence', () => {
  const opportunities = detectHomeImprovementOpportunities({
    emails: [{
      id: 991,
      source_id: 'email:57354',
      canonical_table: 'relationships.communications',
      contact_id: 44,
      subject: 'Home renovation services drawings',
      occurred_at: '2026-06-17T10:00:00Z',
      content_snippet: 'Electrical and plumbing drawings for the residence',
    }],
  })

  assert.equal(opportunities[0].evidence[0].source_table, 'relationships.communications')
  assert.equal(opportunities[0].evidence[0].source_id, 991)
  assert.equal(opportunities[0].evidence[0].source_ref, 'email:57354')
  assert.equal(opportunities[0].primary_contact_id, 44)
})
