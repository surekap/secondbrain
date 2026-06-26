#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.join(__dirname, '../..')
const server = fs.readFileSync(path.join(repo, 'packages/ui/server.js'), 'utf8')
const dashboard = fs.readFileSync(path.join(repo, 'packages/ui/app/page.jsx'), 'utf8')

test('duplicate review exposes evidence drill-down endpoint before decisions', () => {
  assert.match(server, /\/api\/intelligence\/duplicates\/evidence/)
  assert.match(server, /relationships\.contacts/)
  assert.match(server, /relationships\.communications/)
  assert.match(server, /intelligence\.entity_aliases/)
  assert.match(server, /intelligence\.contact_organizations/)
  assert.match(server, /public\.messages/)
})

test('dashboard duplicate panel has inspect action and evidence rendering', () => {
  assert.match(dashboard, /inspectDuplicate/)
  assert.match(dashboard, /duplicateEvidence/)
  assert.match(dashboard, /Inspect evidence/)
  assert.match(dashboard, /Recent communications/)
  assert.match(dashboard, /Aliases/)
})
