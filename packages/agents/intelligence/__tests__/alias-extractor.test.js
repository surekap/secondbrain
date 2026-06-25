const test = require('node:test')
const assert = require('node:assert/strict')
const { contactAliases, organizationAliases, extractAliases, normalized } = require('../services/alias-extractor')

test('alias-extractor: derives first-name and last-name aliases from contact display name', () => {
  const aliases = contactAliases({ id: 1, display_name: 'Rahul Kayan' })
  const texts = aliases.map(a => a.alias)
  assert.ok(texts.includes('Rahul'))
  assert.ok(texts.includes('Kayan'))
  assert.ok(!texts.includes('Rahul Kayan'))
  assert.equal(aliases.every(a => a.entity_type === 'contact' && a.entity_id === 1), true)
})

test('alias-extractor: strips titles and treats cleaned name as high-confidence alias', () => {
  const aliases = contactAliases({ id: 2, display_name: 'Dr. Anupama Sureka' })
  const texts = aliases.map(a => a.alias)
  assert.ok(texts.includes('Anupama'))
  assert.ok(texts.includes('Sureka'))
  assert.ok(texts.includes('Anupama Sureka'))
  const cleaned = aliases.find(a => a.alias === 'Anupama Sureka')
  assert.ok(cleaned)
  assert.equal(cleaned.confidence, 0.95)
})

test('alias-extractor: generates short-form organization aliases without company suffixes', () => {
  const aliases = organizationAliases({ id: 10, name: 'Eden Realty Ventures Pvt. Ltd.' })
  const texts = aliases.map(a => a.alias)
  assert.ok(texts.includes('Eden Realty Ventures'))
  assert.ok(texts.includes('Eden Realty'))
  assert.ok(!texts.includes('Eden Realty Ventures Pvt. Ltd.'))
})

test('alias-extractor: does not create empty or trivial aliases', () => {
  assert.equal(contactAliases({ id: 3, display_name: '' }).length, 0)
  assert.equal(contactAliases({ id: 4, display_name: 'A' }).length, 0)
  assert.equal(organizationAliases({ id: 11, name: 'AB' }).length, 0)
})

test('alias-extractor: batch extraction combines contacts and organizations', () => {
  const aliases = extractAliases(
    [{ id: 1, display_name: 'Rahul Kayan' }],
    [{ id: 10, name: 'Eden Realty Ventures Pvt. Ltd.' }]
  )
  assert.ok(aliases.some(a => a.entity_type === 'contact' && a.alias === 'Rahul'))
  assert.ok(aliases.some(a => a.entity_type === 'organization' && a.alias === 'Eden Realty Ventures'))
})
