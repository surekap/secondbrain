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
  assert.match(indexSource, /FROM relationships\.communications rc/)
  assert.match(indexSource, /whatsappResult\.rows[\s\S]*\.filter\(row => row\.is_group\)/)
  assert.match(indexSource, /\.filter\(row => !row\.is_group && row\.contact_id\)/)
  assert.doesNotMatch(indexSource, /const groupMessagesResult = await pool\.query/)
  assert.match(indexSource, /source_ref LIKE 'cross_channel_project:%'/)
  assert.match(indexSource, /Auto-dismissed: cross-channel detector no longer validates/)
  assert.match(indexSource, /source_table IN \('opportunities', 'intelligence\.opportunities'\)/)
  assert.doesNotMatch(indexSource, /extractSignals\(opportunitiesResult\.rows, 'opportunities'\)/)
  const detectorSource = fs.readFileSync(path.join(__dirname, '../../packages/agents/intelligence/services/cross-channel-project-detector.js'), 'utf8')
  assert.match(detectorSource, /sourcePrefix = useGroupDerivedProject \? 'cross_channel_group_project' : 'cross_channel_project'/)
  assert.match(detectorSource, /source_ref: `\$\{sourcePrefix\}:/)
})

test('intelligence pipeline promotes direct relationship open loops', () => {
  assert.match(indexSource, /detectRelationshipOpenLoops/)
  assert.match(indexSource, /relationships\.communications rc/)
  assert.match(indexSource, /relationshipDirectMessagesResult\.rows/)
  assert.match(indexSource, /relationship_open_loop_opportunities/)
  assert.match(indexSource, /source_ref LIKE 'relationship_open_loop:%'/)
  assert.match(indexSource, /Auto-dismissed: direct relationship open-loop detector no longer validates/)
})

test('intelligence pipeline promotes home-improvement lifelog opportunities', () => {
  assert.match(indexSource, /detectHomeImprovementOpportunities/)
  assert.match(indexSource, /home_improvement_opportunities/)
  assert.match(indexSource, /source_ref LIKE 'home_improvement_project:%'/)
  assert.match(indexSource, /Auto-dismissed: home-improvement detector no longer validates/)
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
