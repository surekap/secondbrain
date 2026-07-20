#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.join(__dirname, '../..')
const dashboard = fs.readFileSync(path.join(repo, 'packages/ui/app/page.jsx'), 'utf8')
const intelligence = fs.readFileSync(path.join(repo, 'packages/ui/app/intelligence/page.jsx'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages/ui/package.json'), 'utf8'))

test('dashboard contains failures inside each API slice instead of blanking on one slow endpoint', () => {
  assert.match(dashboard, /fetchJsonDetailed\('/)
  assert.match(dashboard, /timeoutMs/)
  assert.match(dashboard, /error: err\?\.name === 'AbortError'/)
  assert.match(dashboard, /setFeedIssues\(feedErrors\)/)
})

test('dev UI uses webpack instead of Turbopack to avoid non-hydrated dashboard pages', () => {
  assert.match(pkg.scripts.dev, /next dev/)
  assert.match(pkg.scripts.dev, /--webpack/)
})

test('intelligence refresh runs analysis and records explicit negative feedback', () => {
  assert.match(intelligence, /fetch\('\/api\/intelligence\/refresh'/)
  assert.match(intelligence, /feedback_action: feedbackAction/)
  assert.match(intelligence, /Wrong person/)
  assert.match(intelligence, /Wrong project/)
  assert.doesNotMatch(dashboard, /Audit only — no auto-merge/)
})
