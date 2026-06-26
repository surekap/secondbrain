#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const indexSource = fs.readFileSync(path.join(__dirname, '../../packages/agents/intelligence/index.js'), 'utf8')

test('stale email refresh prunes previously promoted threads no longer validated', () => {
  assert.match(indexSource, /opportunity_type = 'email_response_gap'/)
  assert.match(indexSource, /source_ref LIKE 'email_thread:%'/)
  assert.match(indexSource, /Auto-dismissed: stale-email detector no longer validates this thread/)
  assert.match(indexSource, /activeEmailThreadRefs/)
})
