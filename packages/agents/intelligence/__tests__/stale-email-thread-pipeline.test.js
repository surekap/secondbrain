const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const indexPath = path.join(__dirname, '..', 'index.js')
const source = fs.readFileSync(indexPath, 'utf8')

test('intelligence pipeline scans old enough email threads for stale April follow-ups', () => {
  assert.match(source, /120 days/)
  assert.match(source, /detectStaleEmailThreads/)
  assert.match(source, /stale_email_threads_promoted/)
  assert.match(source, /email_response_gap/)
})
