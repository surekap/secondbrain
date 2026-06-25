#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverPath = path.join(__dirname, '..', '..', 'packages', 'ui', 'server.js')
const source = fs.readFileSync(serverPath, 'utf8')

test('server exposes alias-aware entity resolver endpoint', () => {
  assert.match(source, /resolveEntityAlias/)
  assert.match(source, /\/api\/intelligence\/resolve-entity/)
  assert.match(source, /types/)
  assert.match(source, /entity_aliases|alias/i)
})

test('organization search uses entity_aliases for q matching', () => {
  const routeStart = source.indexOf("/api/intelligence/organizations")
  assert.ok(routeStart > 0)
  const routeSource = source.slice(routeStart, routeStart + 2500)
  assert.match(routeSource, /entity_aliases/)
  assert.match(routeSource, /normalized_alias/)
})

test('contact tier q search uses entity_aliases for alias matching', () => {
  const routeStart = source.indexOf("/api/intelligence/contact-tiers")
  assert.ok(routeStart > 0)
  const routeSource = source.slice(routeStart, routeStart + 4000)
  assert.match(routeSource, /entity_aliases/)
  assert.match(routeSource, /normalized_alias/)
})
