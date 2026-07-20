'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { applyOpportunityFeedback, lifecycleForStatus } = require('../services/opportunity-feedback')
const { reconcileEvidenceLifecycle, wasOpportunityLinkRejected } = require('../index')

test('opportunity statuses map to synchronized item lifecycle states', () => {
  assert.equal(lifecycleForStatus('open'), 'active')
  assert.equal(lifecycleForStatus('snoozed'), 'active')
  assert.equal(lifecycleForStatus('actioned'), 'resolved')
  assert.equal(lifecycleForStatus('dismissed'), 'dismissed')
  assert.equal(lifecycleForStatus('expired'), 'expired')
})

test('a corrected item link remains rejected when the detector reruns', async () => {
  let params
  const rejected = await wasOpportunityLinkRejected({
    async query(_sql, values) {
      params = values
      return { rows: [{ rejected: true }] }
    },
  }, 12, 'contact', 88)
  assert.equal(rejected, true)
  assert.deepEqual(params, [12, 'wrong_person', 'removed_contact_id', '88'])
})

test('evidence lifecycle reconciliation expires only older unsupported open items', async () => {
  const statements = []
  const pool = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push({ sql: normalized, params })
      return { rows: [], rowCount: normalized.includes("SET status = 'expired'") ? 3 : 2 }
    },
  }
  const cutoff = new Date('2026-07-20T10:00:00Z')
  const stats = await reconcileEvidenceLifecycle(pool, cutoff)
  const expiry = statements.find(statement => statement.sql.includes("SET status = 'expired'"))
  assert.deepEqual(stats, { activated: 2, expired_unsupported: 3 })
  assert.match(expiry.sql, /o\.created_at < \$1/)
  assert.match(expiry.sql, /NOT EXISTS \( SELECT 1 FROM intelligence\.opportunity_evidence/)
  assert.equal(expiry.params[0], cutoff)
  assert.match(expiry.params[1], /missing_inspectable_evidence/)
})

test('wrong-person feedback removes only the item link and leaves the item open', async () => {
  const statements = []
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push({ sql: normalized, params })
      if (normalized.startsWith('SELECT * FROM intelligence.opportunities')) {
        return { rows: [{ id: 12, status: 'open', lifecycle_state: 'active', primary_contact_id: 88, primary_project_id: 9 }] }
      }
      if (normalized.startsWith('UPDATE intelligence.opportunities')) {
        return { rows: [{ id: 12, status: 'open', lifecycle_state: 'active', primary_contact_id: null, primary_project_id: 9 }] }
      }
      if (normalized.startsWith('INSERT INTO intelligence.opportunity_feedback_events')) return { rows: [{ id: 5, action: 'wrong_person' }] }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const result = await applyOpportunityFeedback({ connect: async () => client, query: client.query }, 12, { action: 'wrong_person' })
  const update = statements.find(statement => statement.sql.startsWith('UPDATE intelligence.opportunities'))
  assert.match(statements.find(statement => statement.sql.startsWith('DELETE FROM intelligence.opportunity_contacts')).sql, /contact_id = \$2/)
  assert.doesNotMatch(update.sql, /status =/)
  assert.equal(result.opportunity.status, 'open')
  assert.equal(result.link_correction.removed_contact_id, 88)
  assert.equal(result.feedback_event.action, 'wrong_person')
})
