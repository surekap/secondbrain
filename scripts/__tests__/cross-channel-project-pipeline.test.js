#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const indexSource = fs.readFileSync(path.join(__dirname, '../../packages/agents/intelligence/index.js'), 'utf8')
const schemaSource = fs.readFileSync(path.join(__dirname, '../../packages/agents/intelligence/sql/schema.sql'), 'utf8')

test('intelligence pipeline promotes cross-channel project opportunities', () => {
  assert.match(indexSource, /detectCrossChannelProjectSignals/)
  assert.match(indexSource, /cross_channel_project_opportunities/)
  assert.match(indexSource, /public\.messages m[\s\S]*m\.chat_id LIKE '%@g\.us'/)
  assert.match(indexSource, /JOIN relationships\.contacts c ON c\.wa_jids @> ARRAY\[m\.chat_id\]::text\[\]/)
  assert.match(indexSource, /source_ref LIKE 'cross_channel_project:%'/)
  assert.match(indexSource, /Auto-dismissed: cross-channel detector no longer validates/)
  assert.match(indexSource, /source_table IN \('opportunities', 'intelligence\.opportunities'\)/)
  assert.doesNotMatch(indexSource, /extractSignals\(opportunitiesResult\.rows, 'opportunities'\)/)
  const detectorSource = fs.readFileSync(path.join(__dirname, '../../packages/agents/intelligence/services/cross-channel-project-detector.js'), 'utf8')
  assert.match(detectorSource, /source_ref: `cross_channel_project:/)
})

test('intelligence pipeline promotes direct relationship open loops', () => {
  assert.match(indexSource, /detectRelationshipOpenLoops/)
  assert.match(indexSource, /relationships\.communications rc/)
  assert.match(indexSource, /relationshipDirectMessagesResult\.rows/)
  assert.match(indexSource, /relationship_open_loop_opportunities/)
  assert.match(indexSource, /source_ref LIKE 'relationship_open_loop:%'/)
  assert.match(indexSource, /Auto-dismissed: direct relationship open-loop detector no longer validates/)
})

test('intelligence pipeline extracts durable relationship facts from source rows', () => {
  assert.match(indexSource, /extractRelationshipFactsFromText/)
  assert.match(indexSource, /upsertContactFact/)
  assert.match(indexSource, /relationships\.contact_facts/)
  assert.match(indexSource, /relationship_facts_extracted/)
  assert.match(indexSource, /inferContactMention/)
})

test('opportunity ledger supports cross-channel project metadata via generic evidence links', () => {
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS intelligence\.opportunity_evidence/)
  assert.match(schemaSource, /source_table\s+TEXT NOT NULL/)
  assert.match(schemaSource, /opportunity_projects/)
  assert.match(schemaSource, /opportunity_contacts/)
})
