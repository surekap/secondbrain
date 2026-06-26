#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverSource = fs.readFileSync(path.join(__dirname, '../../packages/ui/server.js'), 'utf8')

test('attention API supports q filtering against names and content', () => {
  assert.match(serverSource, /app\.get\('\/api\/intelligence\/attention'/)
  assert.match(serverSource, /const q = String\(req\.query\.q \|\| ''\)\.trim\(\)/)
  assert.match(serverSource, /LOWER\(COALESCE\(primary_contact_name, ''\)\) LIKE/)
  assert.match(serverSource, /LOWER\(COALESCE\(primary_project_name, ''\)\) LIKE/)
  assert.match(serverSource, /FROM intelligence\.attention_queue[\s\S]*\$\{where\}/)
})
