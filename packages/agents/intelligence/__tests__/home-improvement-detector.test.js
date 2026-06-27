const test = require('node:test')
const assert = require('node:assert/strict')
const {
  detectHomeImprovementOpportunities,
  isHomeImprovementEmail,
  isHomeImprovementLifelog,
} = require('../services/home-improvement-detector')

test('detects Jxtapose home renovation evidence from emails', () => {
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
  assert.equal(opportunities[0].source_ref, 'home_improvement_project:jxtapose_residence')
  assert.equal(opportunities[0].metadata.email_count, 1)
  assert.equal(opportunities[0].evidence[0].source_table, 'email.emails')
  assert.match(opportunities[0].description, /concept renders/i)
  assert.match(opportunities[0].recommended_next_action, /GFC drawings|site-documentation payment/i)
})

test('combines Jxtapose lifelog and emails into one corroborated opportunity', () => {
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
