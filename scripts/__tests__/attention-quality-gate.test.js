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
})
