#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverPath = path.resolve(__dirname, '../../packages/ui/server.js')
const source = fs.readFileSync(serverPath, 'utf8')

test('server exposes safe exact identity merge dry-run/write endpoint', () => {
  assert.match(source, /runExactIdentityMerge/)
  assert.match(source, /\/api\/intelligence\/identity\/exact-merge/)
  assert.match(source, /write: req\.body\?\.write === true \|\| req\.query\.write === 'true'/)
  assert.match(source, /no fuzzy\/name-only merges/i)
})
