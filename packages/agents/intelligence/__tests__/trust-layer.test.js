#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '../../../..')
const schema = fs.readFileSync(path.join(repo, 'packages/agents/intelligence/sql/schema.sql'), 'utf8')
const indexSource = fs.readFileSync(path.join(repo, 'packages/agents/intelligence/index.js'), 'utf8')
const serverSource = fs.readFileSync(path.join(repo, 'packages/ui/server.js'), 'utf8')
const suppression = require('../services/suppression-matcher')

function makePool(rowsByKey = new Map()) {
  return {
    async query(_sql, params = []) {
      const key = JSON.stringify(params)
      return { rows: rowsByKey.get(key) || [] }
    },
  }
}

test('trust layer schema and wiring exist', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS intelligence\.opportunity_suppressions/)
  assert.match(schema, /reason_code\s+TEXT NOT NULL CHECK \(reason_code IN \('wrong_person','wrong_project','already_closed','not_useful','suppress_pattern'\)\)/)
  assert.match(schema, /NOT EXISTS \(\s+SELECT 1\s+FROM intelligence\.opportunity_suppressions/s)
  assert.match(indexSource, /matchOpportunitySuppression\(db, input\)/)
  assert.match(indexSource, /if \(!opportunityId\) return null/)
  assert.match(serverSource, /EXPLICIT_OPPORTUNITY_ACTIONS/)
  assert.match(serverSource, /recordOpportunitySuppressionFromAction/)
  assert.match(serverSource, /feedback_action\s*\|\| req\.body\?\.action/)
})

test('suppression matcher casts nullable params so null candidates do not break query planning', () => {
  const source = fs.readFileSync(path.join(repo, 'packages/agents/intelligence/services/suppression-matcher.js'), 'utf8')
  assert.match(source, /\$1::text IS NOT NULL/)
  assert.match(source, /\$2::text <> ''/)
  assert.match(source, /\$5::text IS NOT NULL/)
})

test('suppression matcher blocks only matching candidates and preserves unrelated opportunities', async () => {
  const pool = {
    async query(_sql, params) {
      const [opportunityId, sourceRef, contactId, projectId, titleHash, title, description] = params
      const matches = []
      if (String(contactId) === '42') {
        matches.push({ reason_code: 'wrong_person', scope_type: 'contact', scope_id: '42', match_type: 'exact', match_value: '42' })
      }
      if (String(projectId) === '99') {
        matches.push({ reason_code: 'wrong_project', scope_type: 'project', scope_id: '99', match_type: 'exact', match_value: '99' })
      }
      if (titleHash === suppression.normalizedTitleHash('Do not surface me')) {
        matches.push({ reason_code: 'suppress_pattern', scope_type: 'pattern', scope_id: null, match_type: 'normalized_title_hash', match_value: titleHash })
      }
      if (sourceRef === 'ticket:123') {
        matches.push({ reason_code: 'already_closed', scope_type: 'source_ref', scope_id: 'ticket:123', match_type: 'exact', match_value: 'ticket:123' })
      }
      if (title.includes('pattern') && description.includes('pattern')) {
        matches.push({ reason_code: 'suppress_pattern', scope_type: 'pattern', scope_id: null, match_type: 'pattern', match_value: '%pattern%' })
      }
      return { rows: matches.slice(0, 1) }
    },
  }

  const blocked = await suppression.matchOpportunitySuppression(pool, {
    opportunity_id: 7,
    source_ref: 'ticket:123',
    primary_contact_id: 42,
    primary_project_id: 11,
    title: 'Do not surface me',
    description: 'pattern match not needed',
  })
  assert.ok(blocked)
  assert.equal(blocked.reason_code, 'wrong_person')

  const survives = await suppression.matchOpportunitySuppression(pool, {
    opportunity_id: 8,
    source_ref: 'ticket:321',
    primary_contact_id: 43,
    primary_project_id: 12,
    title: 'Useful real item',
    description: 'keep this open',
  })
  assert.equal(survives, null)
})

test('normalized title hashes are stable and specific', () => {
  const a = suppression.normalizedTitleHash('  Same title  ')
  const b = suppression.normalizedTitleHash('same   title')
  const c = suppression.normalizedTitleHash('Different title')
  assert.equal(a, b)
  assert.notEqual(a, c)
})
