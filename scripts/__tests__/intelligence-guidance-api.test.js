#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '../..')
const server = fs.readFileSync(path.join(repo, 'packages/ui/server.js'), 'utf8')
const page = fs.readFileSync(path.join(repo, 'packages/ui/app/intelligence/page.jsx'), 'utf8')

test('refresh API uses the durable advisory-locked intelligence runner', () => {
  assert.match(server, /intelligence\.pipeline_runs/)
  assert.match(server, /runDurableIntelligence/)
  assert.doesNotMatch(server, /intelligenceRefreshState/)
  assert.match(page, /Analysis running/)
})

test('only persistent high-impact clarification is presented and retained as guidance', () => {
  assert.match(server, /status = 'pending' AND impact = 'high' AND occurrences >= 3/)
  assert.match(server, /answerClarification/)
  assert.match(server, /recordGuidanceFact/)
  assert.match(page, /Your answer is saved as guidance/)
  assert.match(page, /source messages are never changed/)
})

test('health API compares raw, canonical, intelligence, identity, evidence, and media state', () => {
  assert.match(server, /\/api\/intelligence\/health/)
  assert.match(server, /rawToCanonicalMinutes/)
  assert.match(server, /canonicalToIntelligenceMinutes/)
  assert.match(server, /pending_identity_conflicts/)
  assert.match(server, /open_without_evidence/)
  assert.match(server, /media_pending/)
  assert.match(page, /Data correction is still catching up/)
})

test('contact and project edits compose overrides once and mirror append-only guidance atomically', () => {
  const contactRoute = server.slice(server.indexOf("app.patch('/api/relationships/contacts/:id'"), server.indexOf("app.post('/api/relationships/contacts/:id/touches'"))
  const projectRoute = server.slice(server.indexOf("app.patch('/api/projects/:id'"), server.indexOf("app.get('/api/projects/:id/communications'"))
  for (const route of [contactRoute, projectRoute]) {
    assert.equal((route.match(/manual_overrides\s*=/g) || []).length, 1)
    assert.match(route, /recordGuidanceFactInTransaction/)
    assert.match(route, /mode: 'released'/)
    assert.match(route, /await client\.query\('BEGIN'\)/)
    assert.match(route, /await client\.query\('COMMIT'\)/)
  }
})

test('open opportunity API excludes unsupported candidates', () => {
  const route = server.slice(server.indexOf("app.get('/api/intelligence/opportunities'"), server.indexOf("app.get('/api/intelligence/opportunities/:id/evidence'"))
  assert.match(route, /status === 'open'/)
  assert.match(route, /o\.lifecycle_state = 'active'/)
})
