const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '../../../..')
const schema = fs.readFileSync(path.join(repo, 'packages/agents/intelligence/sql/schema.sql'), 'utf8')
const pipeline = fs.readFileSync(path.join(repo, 'packages/agents/intelligence/index.js'), 'utf8')

test('intelligence refresh only writes feedback values allowed by opportunities_feedback_check', () => {
  const allowedMatch = schema.match(/feedback\s+TEXT CHECK \(feedback IS NULL OR feedback IN \(([^)]+)\)\)/)
  assert.ok(allowedMatch, 'schema should define feedback CHECK values')
  const allowed = new Set([...allowedMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]))
  assert.ok(allowed.has('false_positive'))

  const written = [...pipeline.matchAll(/feedback\s*=\s*COALESCE\(feedback,\s*'([^']+)'\)/g)].map(m => m[1])
  assert.ok(written.length > 0, 'pipeline should write stale-dismissal feedback values')
  for (const value of written) {
    assert.ok(allowed.has(value), `${value} must be allowed by intelligence.opportunities.feedback CHECK`)
  }
})
