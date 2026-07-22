'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.resolve(__dirname, '../../packages/agents/projects/index.js'), 'utf8')

test('provider failures do not terminate the scheduled projects worker', () => {
  assert.match(source, /Initial analysis failed; keeping worker alive/)
  assert.match(source, /if \(RUN_ONCE\) throw error/)
})
