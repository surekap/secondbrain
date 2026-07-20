'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  CORRECTION_VERSION,
  LEGACY_PROVENANCE_CUTOFF,
  syntheticLidName,
  runLidOwnershipCorrection,
} = require('../services/lid-ownership-correction')

function correctionClient() {
  const calls = []
  let pass = 0
  let nextContactId = 900
  return {
    calls,
    async connect() { throw new Error('already-connected clients must not reconnect') },
    release() {},
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (/lid-ownership:load-split-candidates/.test(sql)) {
        pass++
        if (pass > 1) return { rows: [] }
        return { rows: [
          {
            identity_id: 11,
            previous_contact_id: 101,
            jid: '111111111111111@lid',
            provider_display_name: 'Legacy Name',
            correction_kind: 'legacy_name_only',
          },
          {
            identity_id: 12,
            previous_contact_id: 102,
            jid: '222222222222222@lid',
            provider_display_name: 'Shared Push Name',
            correction_kind: 'provisional_extra_lid',
          },
        ] }
      }
      if (/lid-ownership:create-provider-profile/.test(sql)) {
        return { rows: [{ id: nextContactId++ }], rowCount: 1 }
      }
      if (/lid-ownership:move-split-identity/.test(sql)) return { rows: [{ id: params[0] }], rowCount: 1 }
      if (/lid-ownership:load-missing-canonical-lids/.test(sql)) {
        if (pass > 1) return { rows: [] }
        return { rows: [{ jid: '333333333333333@lid', provider_display_name: null }] }
      }
      if (/lid-ownership:create-missing-identity-profiles/.test(sql)) {
        return { rows: [{ contact_id: 902, synthetic: true, identity_created: true }], rowCount: 1 }
      }
      if (/lid-ownership:audit-exact-canonical-owners/.test(sql)) {
        const rows = pass > 1 ? [] : [
          { previous_contact_id: null, jid: '111111111111111@lid' },
          { previous_contact_id: 101, jid: '111111111111111@lid' },
          { previous_contact_id: null, jid: '333333333333333@lid' },
        ]
        return { rows, rowCount: rows.length }
      }
      if (/lid-ownership:reassign-exact-canonical-owners/.test(sql)) {
        const rows = pass > 1 ? [] : [
          { previous_contact_id: null, jid: '111111111111111@lid' },
          { previous_contact_id: 101, jid: '111111111111111@lid' },
          { previous_contact_id: null, jid: '333333333333333@lid' },
        ]
        return { rows, rowCount: rows.length }
      }
      if (/lid-ownership:enrich-profile-recency/.test(sql)) return { rows: [], rowCount: params[0].length }
      return { rows: [], rowCount: 0 }
    },
  }
}

test('LID ownership correction is versioned, convergent, and audits NULL plus stale links', async () => {
  const client = correctionClient()
  const correctedAt = '2026-07-20T06:40:00.000Z'
  const first = await runLidOwnershipCorrection(client, { correctedAt })

  assert.deepEqual(first, {
    version: CORRECTION_VERSION,
    split_candidates: 2,
    legacy_name_only_lids_split: 1,
    provisional_extra_lids_split: 1,
    provider_profiles_created: 3,
    nameless_lid_profiles_created: 1,
    identities_moved: 2,
    exact_owners_reconciled: 2,
    communications_audited: 3,
    communications_reassigned: 3,
    null_links_reassigned: 2,
    stale_links_reassigned: 1,
    profiles_recency_enriched: 3,
  })

  const moved = client.calls.filter(call => /lid-ownership:move-split-identity/.test(call.sql))
  assert.equal(moved.length, 2)
  assert.ok(moved.every(call => call.params[4] === CORRECTION_VERSION))
  assert.ok(moved.every(call => call.params[5] === correctedAt))
  assert.ok(moved.every(call => /COALESCE\(NULLIF\(identity\.metadata->>'corrected_at'/.test(call.sql)))

  const missingBatch = client.calls.find(call => /lid-ownership:create-missing-identity-profiles/.test(call.sql))
  const synthetic = JSON.parse(missingBatch.params[0])[0]
  assert.equal(synthetic.display_name, syntheticLidName('333333333333333@lid'))
  assert.equal(synthetic.raw_data.display_name_is_synthetic, true)

  const auditSql = client.calls.find(call => /lid-ownership:audit-exact-canonical-owners/.test(call.sql)).sql
  assert.match(auditSql, /previous_contact_id IS NOT DISTINCT FROM/)
  assert.match(auditSql, /previous_contact_was_null/)
  assert.match(auditSql, /correction_version/)
  const reassignmentSql = client.calls.find(call => /lid-ownership:reassign-exact-canonical-owners/.test(call.sql)).sql
  assert.match(reassignmentSql, /is_group = FALSE[\s\S]+UNION ALL[\s\S]+is_group = TRUE/)
  assert.match(reassignmentSql, /contact_id IS DISTINCT FROM/)

  const second = await runLidOwnershipCorrection(client, { correctedAt: '2026-07-21T00:00:00.000Z' })
  assert.equal(second.version, CORRECTION_VERSION)
  assert.ok(Object.entries(second).every(([key, value]) => key === 'version' || value === 0))
  assert.equal(client.calls.filter(call => /lid-ownership:move-split-identity/.test(call.sql)).length, 2)
  assert.equal(client.calls.filter(call => /^\s*COMMIT\s*$/.test(call.sql)).length, 2)
})

test('legacy candidate selection requires exact old name-match provenance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/lid-ownership-correction.js'), 'utf8')
  const selection = source.slice(
    source.indexOf('async function loadSplitCandidates'),
    source.indexOf('async function createProviderProfile'),
  )
  assert.equal(CORRECTION_VERSION, '2026-07-20-lid-ownership-v1')
  assert.match(LEGACY_PROVENANCE_CUTOFF, /^2026-07-20T/)
  assert.match(selection, /identity\.verified_by = 'system'/)
  assert.match(selection, /identity\.confidence = 1/)
  assert.match(selection, /identity\.metadata->>'source' = 'chat_metadata'/)
  assert.match(selection, /identity\.metadata->>'privacy_preserving_lid' = 'true'/)
  assert.match(selection, /identity\.updated_at < \$1::timestamptz/)
  assert.match(selection, /identity\.metadata->>'display_name'[\s\S]+contact\.normalized_name/)
  assert.match(selection, /contact\.raw_data->>'source' IS DISTINCT FROM 'whatsapp_lid'/)
  assert.match(selection, /redirect\.from_contact_id IS NULL/)
  assert.match(selection, /contact\.raw_data->>'reason' = 'unmatched_exact_name'/)
  assert.match(selection, /ROW_NUMBER\(\)[\s\S]+owner_ordinal > 1/)
  assert.doesNotMatch(source, /public\.messages|UPDATE\s+public\.|DELETE\s+FROM\s+public\./i)
})

test('schema permits NULL-to-exact ownership transitions in the audit ledger', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8')
  assert.match(schema, /communication_identity_conflicts[\s\S]+ALTER COLUMN previous_contact_id DROP NOT NULL/)
})
