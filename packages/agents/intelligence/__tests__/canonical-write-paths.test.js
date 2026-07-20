#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const indexPath = path.join(__dirname, '..', 'index.js')
const source = fs.readFileSync(indexPath, 'utf8')
const {
  canonicalCommunicationReferenceCandidates,
  resolveCanonicalCommunicationRefs,
} = require('../index')

test('intelligence write paths canonicalize contacts before writing signals and opportunities', () => {
  assert.match(source, /canonicalizeEntityId/)
  assert.match(source, /canonicalizeEntityIds/)

  const upsertOpportunity = source.slice(source.indexOf('async function upsertOpportunity'), source.indexOf('async function linkContacts'))
  assert.match(upsertOpportunity, /canonicalizeEntityId\(db, 'contact'/)
  assert.match(upsertOpportunity, /canonicalPrimaryContactId/)
  assert.doesNotMatch(upsertOpportunity, /recordSignalForOpportunity/, 'derived intelligence items must not feed back into raw signals')

  const upsertSignal = source.slice(source.indexOf('async function upsertSignal'), source.indexOf('async function upsertOrganizationGraph'))
  assert.match(upsertSignal, /canonicalizeEntityId\(pool, 'contact'/)
})

test('intelligence link paths canonicalize contact and organization links before insert', () => {
  const linkContacts = source.slice(source.indexOf('async function linkContacts'), source.indexOf('async function linkProject'))
  assert.match(linkContacts, /canonicalizeEntityIds\(db, 'contact'/)

  const orgGraph = source.slice(source.indexOf('async function upsertOrganizationGraph'), source.indexOf('async function upsertAliases'))
  assert.match(orgGraph, /canonicalizeEntityId\(pool, 'organization'/)
  assert.match(orgGraph, /canonicalizeEntityId\(pool, 'contact'/)
})

test('project evidence resolves canonical source refs to inspectable communication rows', async () => {
  const queries = []
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params })
      return {
        rows: [{
          id: '42',
          source: 'email',
          source_id: 'email:123',
          occurred_at: '2026-07-20T00:00:00.000Z',
          content_snippet: 'Canonical source evidence',
          subject: 'Decision',
        }],
      }
    },
  }

  assert.deepEqual(
    canonicalCommunicationReferenceCandidates(['email:email:123', 'whatsapp:episode:not-a-message']),
    ['email:email:123', 'email:123', 'whatsapp:episode:not-a-message'],
  )
  const rows = await resolveCanonicalCommunicationRefs(pool, ['email:123', 'whatsapp:episode:not-a-message'])
  assert.deepEqual(rows.map(row => row.id), ['42'])
  assert.match(queries[0].sql, /FROM relationships\.communications/)
  assert.match(queries[0].sql, /source_id = ANY\(\$1::text\[\]\)/)
  assert.deepEqual(queries[0].params[0], ['email:123', 'whatsapp:episode:not-a-message'])

  const projectWriter = source.slice(source.indexOf('async function upsertFromProjectInsight'), source.indexOf('async function reconcileProjectItems'))
  assert.match(projectWriter, /resolveCanonicalCommunicationRefs/)
  assert.match(projectWriter, /source_table: 'relationships\.communications'/)
  assert.match(projectWriter, /source_id: communication\.id/)
  assert.match(projectWriter, /source_ref: `relationships\.communication:\$\{communication\.id\}`/)
  assert.doesNotMatch(projectWriter, /source_table: String\(ref\)/)
})
