#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverSource = fs.readFileSync(path.join(__dirname, '../../packages/ui/server.js'), 'utf8')
const relationshipSchema = fs.readFileSync(path.join(__dirname, '../../packages/agents/relationships/sql/schema.sql'), 'utf8')

test('manual contact API supports sticky relationship tier and cadence overrides', () => {
  assert.match(serverSource, /relationship_tier/)
  assert.match(serverSource, /strategic_importance_score/)
  assert.match(serverSource, /preferred_cadence_days/)
  assert.match(serverSource, /intro_sensitivity/)
})

test('opportunities API supports q text filtering instead of ignoring the parameter', () => {
  assert.match(serverSource, /req\.query\.q/)
  assert.match(serverSource, /LOWER\(o\.title\)/)
  assert.match(serverSource, /LOWER\(COALESCE\(o\.description/)
})

test('relationship schema has first-class personal fact memory', () => {
  assert.match(relationshipSchema, /CREATE TABLE IF NOT EXISTS relationships\.contact_facts/)
  assert.match(relationshipSchema, /gift_preference/)
  assert.match(relationshipSchema, /important_date/)
  assert.match(relationshipSchema, /support_context/)
  assert.match(relationshipSchema, /cancelled_plan/)
  assert.match(relationshipSchema, /manual|whatsapp|email|limitless|hermes/)
})
