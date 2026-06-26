const test = require('node:test')
const assert = require('node:assert/strict')
const { detectHomeImprovementOpportunities, isHomeImprovementLifelog } = require('../services/home-improvement-detector')

test('detects Jxtapose home renovation lifelog even when ASR says just to pose', () => {
  const lifelog = {
    id: '4H8G36cYecxMRjTPgdSt',
    title: 'Discussion about house renovation',
    start_time: '2026-05-21T00:34:23.000Z',
    markdown: 'meeting with just to pose for the renovation of the house with Gayatri. Nandita joined. Review proposed workflow of using an interior PMC to manage civil electrical and plumbing work.',
  }
  assert.equal(isHomeImprovementLifelog(lifelog), true)
  const out = detectHomeImprovementOpportunities({ lifelogs: [lifelog] })
  assert.equal(out.length, 1)
  assert.equal(out[0].opportunity_type, 'project_opportunity')
  assert.match(out[0].title, /Home renovation with Jxtapose/i)
  assert.match(out[0].description, /just to pose|Gayatri|PMC/i)
  assert.equal(out[0].metadata.vendor, 'Jxtapose')
  assert.deepEqual(out[0].metadata.members.sort(), ['Gayatri', 'Nandita'].sort())
})

test('does not promote generic home chatter without Jxtapose alias', () => {
  const out = detectHomeImprovementOpportunities({
    lifelogs: [{ id: 'x', title: 'Personal updates and home setup', markdown: 'Moving home next Saturday and household stuff.' }],
  })
  assert.equal(out.length, 0)
})
