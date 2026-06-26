#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverPath = path.join(__dirname, '../../packages/ui/server.js')
const source = fs.readFileSync(serverPath, 'utf8')

test('relationship contact touch endpoint writes metadata-only touches and updates recency fields', () => {
  const routeStart = source.indexOf("// POST /api/relationships/contacts/:id/touches")
  assert.ok(routeStart > 0)
  const routeSource = source.slice(routeStart, routeStart + 4500)
  assert.match(routeSource, /relationships\.contact_touches/)
  assert.match(routeSource, /INSERT INTO relationships\.contact_touches/)
  assert.match(routeSource, /ON CONFLICT \(source, external_id, contact_id\)/)
  assert.match(routeSource, /UPDATE relationships\.contacts/)
  assert.match(routeSource, /last_interaction_at = GREATEST/)
  assert.match(routeSource, /next_suggested_touch_at/)
  assert.match(routeSource, /preferred_cadence_days/)
  assert.match(routeSource, /allowedSources = \['manual','whatsapp','whatsapp_call','ios_call','phone','in_person','email','limitless'\]/)
})
