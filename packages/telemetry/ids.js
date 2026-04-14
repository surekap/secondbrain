// packages/telemetry/ids.js
'use strict'
const { randomUUID } = require('crypto')
function generateId() { return randomUUID() }
module.exports = { generateId }
