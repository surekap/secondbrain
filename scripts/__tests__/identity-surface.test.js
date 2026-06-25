#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const dashboardPath = path.resolve(__dirname, '../../packages/ui/app/page.jsx')
const source = fs.readFileSync(dashboardPath, 'utf8')

test('dashboard surfaces duplicate identity audit instead of burying it in API only', () => {
  assert.match(source, /duplicateSummary/)
  assert.match(source, /\/api\/intelligence\/duplicates\/summary/)
  assert.match(source, /Identity Resolution/)
  assert.match(source, /duplicate-group/)
  assert.match(source, /suggested_canonical_id/)
})
