const test = require('node:test')
const assert = require('node:assert/strict')
const { extractRelationshipFactsFromText } = require('../services/fact-extractor')

test('relationship fact extractor catches support context and cancelled plan case', () => {
  const text = 'Vivek Gupta GIC is going through some difficult times and I had coordinated to meet him but he had to cancel last minute. I want to be there to support him.'
  const facts = extractRelationshipFactsFromText(text, { source: 'hermes', source_ref: 'test:vivek-gupta-gic' })
  const types = facts.map(f => f.fact_type).sort()
  assert.deepEqual(types, ['cancelled_plan', 'support_context'])
  assert.ok(facts.every(f => f.source_ref === 'test:vivek-gupta-gic'))
})

test('relationship fact extractor catches milestone birthday gift and preferences', () => {
  const text = 'Nikhil Mehra had a milestone birthday this year. I sent him a gift through Nandita which may have been too generic. He always wanted Wimbledon tickets or something wine related.'
  const facts = extractRelationshipFactsFromText(text, { source: 'hermes', source_ref: 'test:nikhil-mehra-birthday' })
  const types = facts.map(f => f.fact_type).sort()
  assert.deepEqual(types, ['gift_preference', 'gift_sent', 'important_date', 'personal_preference'])
  assert.ok(facts.find(f => f.fact_type === 'gift_preference').fact.includes('Wimbledon'))
})
