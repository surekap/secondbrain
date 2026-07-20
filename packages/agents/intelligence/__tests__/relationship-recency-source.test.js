#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.join(__dirname, '..', '..', '..', '..')
const schema = fs.readFileSync(path.join(repo, 'packages', 'agents', 'relationships', 'sql', 'schema.sql'), 'utf8')
const intelligence = fs.readFileSync(path.join(repo, 'packages', 'agents', 'intelligence', 'index.js'), 'utf8')

test('relationship schema has metadata-only contact touch ledger for calls and manual touches', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS relationships\.contact_touches/)
  assert.match(schema, /source\s+TEXT NOT NULL CHECK \(source IN/)
  assert.match(schema, /'whatsapp_call'/)
  assert.match(schema, /'ios_call'/)
  assert.match(schema, /touched_at\s+TIMESTAMPTZ NOT NULL/)
  assert.match(schema, /external_id\s+TEXT/)
  assert.match(schema, /UNIQUE \(source, external_id, contact_id\)/)
})

test('tier refresh computes recency from communications, touch ledger, and confirmed duplicate rows', () => {
  const start = intelligence.indexOf('async function tierContacts')
  assert.ok(start > 0)
  const source = intelligence.slice(start, start + 5000)
  assert.match(source, /effective_last_interaction_at/)
  assert.match(source, /relationships\.communications/)
  assert.match(source, /relationships\.contact_touches/)
  assert.doesNotMatch(source, /public\.messages/)
  assert.match(source, /intelligence\.duplicate_decisions/)
  assert.match(source, /COALESCE\(MIN\(dm\.group_id\), c\.id\)/)
  assert.match(source, /GROUP BY cg\.group_id/)
  assert.match(source, /AS last_interaction_at/)
})
