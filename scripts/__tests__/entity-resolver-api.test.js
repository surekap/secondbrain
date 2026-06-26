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
  assert.match(routeSource, /duplicate_decisions/)
  assert.match(routeSource, /canonical_entity_id/)
  assert.match(routeSource, /matched_entity_id/)
})

test('contact tier q search uses entity_aliases and canonical recency for alias matching', () => {
  const routeStart = source.indexOf("// GET /api/intelligence/contact-tiers — inspect contacts by tier/overdue state")
  assert.ok(routeStart > 0)
  const routeSource = source.slice(routeStart, routeStart + 7000)
  assert.match(routeSource, /entity_aliases/)
  assert.match(routeSource, /normalized_alias/)
  assert.match(routeSource, /duplicate_decisions/)
  assert.match(routeSource, /canonical_entity_id/)
  assert.match(routeSource, /matched_entity_id/)
  assert.match(routeSource, /effective_last_interaction_at/)
  assert.match(routeSource, /relationships\.communications/)
  assert.match(routeSource, /relationships\.contact_touches/)
  assert.match(routeSource, /public\.messages/)
  assert.match(routeSource, /ANY\(cg\.contact_ids\)/)
})

test('server exposes read-only duplicate audit endpoints', () => {
  assert.match(source, /auditDuplicateContacts/)
  assert.match(source, /auditDuplicateOrganizations/)
  assert.match(source, /auditDuplicateSummary/)
  assert.match(source, /\/api\/intelligence\/duplicates\/contacts/)
  assert.match(source, /\/api\/intelligence\/duplicates\/organizations/)
  assert.match(source, /\/api\/intelligence\/duplicates\/summary/)
})

test('live smoke includes duplicate summary endpoint', () => {
  const smokePath = path.join(__dirname, '..', 'secondbrain-live-smoke.js')
  const smoke = fs.readFileSync(smokePath, 'utf8')
  assert.match(smoke, /duplicate_summary/)
  assert.match(smoke, /duplicate_decisions/)
  assert.match(smoke, /\/api\/intelligence\/duplicates\/summary\?limit=5/)
  assert.match(smoke, /\/api\/intelligence\/duplicates\/decisions\?limit=5/)
})

test('server exposes manual duplicate decision endpoints', () => {
  assert.match(source, /upsertDuplicateDecision/)
  assert.match(source, /listDuplicateDecisions/)
  assert.match(source, /\/api\/intelligence\/duplicates\/decisions/)
  assert.match(source, /\/api\/intelligence\/duplicates\/decide/)
})
