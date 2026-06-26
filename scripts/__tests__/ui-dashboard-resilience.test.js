#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.join(__dirname, '../..')
const dashboard = fs.readFileSync(path.join(repo, 'packages/ui/app/page.jsx'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages/ui/package.json'), 'utf8'))

test('dashboard loads independent API slices instead of blanking on one slow endpoint', () => {
  assert.match(dashboard, /Promise\.allSettled/)
  assert.match(dashboard, /fetchJson\('/)
  assert.match(dashboard, /timeoutMs/)
  assert.doesNotMatch(dashboard, /const \[ri, pi, rs, ps, ra, gr, aq, ds\] = await Promise\.all\(/)
})

test('dev UI uses webpack instead of Turbopack to avoid non-hydrated dashboard pages', () => {
  assert.match(pkg.scripts.dev, /next dev/)
  assert.match(pkg.scripts.dev, /--webpack/)
})
