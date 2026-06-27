#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const schema = fs.readFileSync(path.join(__dirname, '../../packages/agents/intelligence/sql/schema.sql'), 'utf8')

test('attention queue excludes no-evidence and below-threshold noise', () => {
  assert.match(schema, /attention_score >= 20/)
  assert.match(schema, /NOT \('no_evidence' = ANY\(quality_flags\)\)/)
  assert.match(schema, /NOT \('low_value_admin' = ANY\(quality_flags\)\)/)
})

test('attention queue keeps explicit direct-chat open loops from being buried by old single-evidence penalties', () => {
  assert.match(schema, /unresolved direct-chat loop%'.*evidence_count = 0/s)
  assert.match(schema, /unresolved direct-chat loop%'.*INTERVAL '90 days'/s)
})
