#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverSource = fs.readFileSync(path.join(__dirname, '../../packages/ui/server.js'), 'utf8')

test('server exposes a lightweight health endpoint', () => {
  assert.match(serverSource, /app\.get\('\/api\/health'/)
  assert.match(serverSource, /SELECT 1/)
  assert.match(serverSource, /secondbrain-api/)
})
