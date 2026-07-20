'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { canRunPowermetrics } = require('../powermetrics')

test('powermetrics runs only on macOS with superuser privileges', () => {
  assert.equal(canRunPowermetrics({ platform: 'darwin', getuid: () => 0 }), true)
  assert.equal(canRunPowermetrics({ platform: 'darwin', getuid: () => 501 }), false)
  assert.equal(canRunPowermetrics({ platform: 'linux', getuid: () => 0 }), false)
})
