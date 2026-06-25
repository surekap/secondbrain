#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverPath = path.resolve(__dirname, '../../packages/ui/server.js')
const smokePath = path.resolve(__dirname, '../secondbrain-live-smoke.js')

function read(file) { return fs.readFileSync(file, 'utf8') }

test('contact tier API exposes summary and inspectable tier list', () => {
  const server = read(serverPath)

  assert.match(server, /\/api\/intelligence\/contact-tiers\/summary/, 'summary endpoint should exist')
  assert.match(server, /\/api\/intelligence\/contact-tiers'/, 'list endpoint should exist')
  assert.match(server, /relationship_tier/, 'endpoint should expose relationship_tier')
  assert.match(server, /strategic_importance_score/, 'endpoint should expose strategic score')
  assert.match(server, /next_suggested_touch_at/, 'endpoint should expose next touch date')
  assert.match(server, /manual_override_fields/, 'endpoint should expose sticky override fields')
})

test('live smoke includes contact tier endpoint', () => {
  const smoke = read(smokePath)

  assert.match(smoke, /contact_tiers_summary/, 'smoke should fetch contact tier summary')
  assert.match(smoke, /\/api\/intelligence\/contact-tiers\/summary/, 'smoke should call contact tier summary API')
})
