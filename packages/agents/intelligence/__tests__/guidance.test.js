'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { answerClarification, formatGuidanceContext, listClarificationsToAsk, normalizeEvidenceObservations, observeAmbiguity, shouldAskClarification } = require('../services/guidance')

test('clarifications surface only after a persistent high-impact ambiguity', () => {
  assert.equal(shouldAskClarification({ impact: 'high', status: 'pending', occurrences: 2 }), false)
  assert.equal(shouldAskClarification({ impact: 'low', status: 'pending', occurrences: 9 }), false)
  assert.equal(shouldAskClarification({ impact: 'high', status: 'answered', occurrences: 9 }), false)
  assert.equal(shouldAskClarification({ impact: 'high', status: 'pending', occurrences: 3 }), true)
})

test('guidance context contains only active overlay facts and warns against source mutation', () => {
  const context = formatGuidanceContext([
    { scope_type: 'project', scope_id: '4', fact_type: 'owner', fact_value: 'Maya', state: 'active', confidence: 1, provenance: 'user_clarification' },
    { scope_type: 'project', scope_id: '4', fact_type: 'owner', fact_value: 'Old owner', state: 'superseded' },
    { scope_type: 'project', scope_id: '4', fact_type: 'owner', fact_value: { mode: 'released' }, state: 'active' },
  ])
  assert.match(context, /never source data/)
  assert.match(context, /Maya/)
  assert.doesNotMatch(context, /Old owner/)
})

test('clarification evidence identities deduplicate repeated communication refs', () => {
  const observations = normalizeEvidenceObservations({
    ambiguity_key: 'project:4:owner',
    evidence_refs: ['email:1', 'email:1', { source: 'whatsapp', source_id: 'wa:2' }],
  })
  assert.equal(observations.length, 2)
  assert.notEqual(observations[0].evidence_key, observations[1].evidence_key)
})

test('detector reruns do not increase clarification occurrences without new evidence', async () => {
  const observed = new Set()
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('INSERT INTO intelligence.clarification_questions')) return { rows: [{ id: 7 }] }
      if (normalized.startsWith('INSERT INTO intelligence.clarification_observations')) {
        observed.add(params[1])
        return { rows: [], rowCount: 1 }
      }
      if (normalized.startsWith('UPDATE intelligence.clarification_questions q')) {
        return { rows: [{ id: 7, impact: 'high', status: 'pending', occurrences: observed.size }] }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const pool = { connect: async () => client }
  const input = { ambiguity_key: 'project:4:owner', question: 'Who owns this?', impact: 'high', evidence_refs: ['email:1'] }
  const first = await observeAmbiguity(pool, input)
  const rerun = await observeAmbiguity(pool, input)
  const successive = await observeAmbiguity(pool, { ...input, evidence_refs: ['email:2'] })
  assert.equal(first.occurrences, 1)
  assert.equal(rerun.occurrences, 1)
  assert.equal(successive.occurrences, 2)
  assert.equal(successive.should_ask, false)
})

test('answering a clarification writes guidance and closes the question atomically', async () => {
  const statements = []
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (normalized.includes('SELECT * FROM intelligence.clarification_questions')) {
        return { rows: [{ id: 3, scope_type: 'project', scope_id: '4' }] }
      }
      if (normalized.includes('SELECT id FROM intelligence.guidance_facts')) return { rows: [] }
      if (normalized.includes('INSERT INTO intelligence.guidance_facts')) return { rows: [{ id: 8 }] }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  const fact = await answerClarification({ connect: async () => client, query: client.query }, 'owner-choice', { fact_type: 'owner', fact_value: 'Maya' })
  assert.equal(fact.id, 8)
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements.at(-1), 'COMMIT')
  assert.ok(statements.findIndex(sql => sql.includes('INSERT INTO intelligence.guidance_facts')) < statements.findIndex(sql => sql.includes("SET status = 'answered'")))
})

test('clarification queue query exposes only persistent high-impact questions', async () => {
  let sql = ''
  const rows = await listClarificationsToAsk({ query: async statement => { sql = statement; return { rows: [{ id: 1 }] } } })
  assert.deepEqual(rows, [{ id: 1 }])
  assert.match(sql, /impact = 'high'/)
  assert.match(sql, /occurrences >=/)
  assert.match(sql, /status = 'pending'/)
})
