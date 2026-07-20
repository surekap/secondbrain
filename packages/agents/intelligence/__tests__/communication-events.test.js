#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '../../../..')
const schema = fs.readFileSync(path.join(repo, 'packages', 'agents', 'intelligence', 'sql', 'schema.sql'), 'utf8')
const indexSource = fs.readFileSync(path.join(repo, 'packages', 'agents', 'intelligence', 'index.js'), 'utf8')

const {
  extractCommunicationEvents,
} = require('../services/communication-event-extractor')
const eventExtractorSource = fs.readFileSync(path.join(repo, 'packages', 'agents', 'intelligence', 'services', 'communication-event-extractor.js'), 'utf8')

test('communication events schema stores traceable source communication metadata', () => {
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS intelligence.communication_events'))
  assert.ok(schema.includes('event_key          TEXT NOT NULL UNIQUE'))
  assert.ok(schema.includes('event_kind         TEXT NOT NULL CHECK (event_kind IN ('))
  assert.ok(schema.includes('source_table       TEXT NOT NULL'))
  assert.ok(schema.includes('source_id          TEXT NOT NULL'))
  assert.ok(schema.includes('source_ref         TEXT'))
  assert.ok(schema.includes('source_contact_id  BIGINT REFERENCES relationships.contacts(id)'))
  assert.ok(schema.includes('source_project_id  BIGINT REFERENCES projects.projects(id)'))
})

test('communication event extractor classifies invites and preserves the original communication trace', () => {
  const rows = extractCommunicationEvents([
    {
      id: 17,
      subject: 'Invite: AI founders webinar on 15 Aug at 5pm IST',
      body_text: 'Join the webinar with the Zoom link below. Description: short talk and Q&A. Register now.',
      date: '2026-07-01T10:00:00Z',
      from_address: 'organizer@example.com',
    },
    {
      id: 'm-99',
      chat_id: '12345@c.us',
      body: 'Conference next week on 22 Aug. Zoom call link will follow.',
      ts: '2026-07-10T09:30:00Z',
    },
  ], 'email.emails')

  assert.equal(rows.length, 2)
  assert.equal(rows[0].source_table, 'email.emails')
  assert.equal(rows[0].source_id, '17')
  assert.equal(rows[0].source_ref, 'email:17')
  assert.equal(rows[0].event_kind, 'webinar')
  assert.match(rows[0].title, /webinar/i)
  assert.match(rows[0].description, /Zoom link/i)
  assert.ok(rows[0].communicated_at)
  assert.ok(rows[0].event_key)

  assert.equal(rows[1].source_id, 'm-99')
  assert.equal(rows[1].source_ref, 'email:m-99')
  assert.equal(rows[1].event_kind, 'conference')
  assert.match(rows[1].title, /conference/i)
})

test('intelligence pipeline wires communication event backfill into refresh', () => {
  assert.ok(indexSource.includes("backfillCommunicationEvents(pool, { days: 30, log })"))
})

test('communication event backfill reads each message only from the canonical layer', () => {
  const loader = eventExtractorSource.slice(eventExtractorSource.indexOf('async function loadCommunicationRows'), eventExtractorSource.indexOf('async function backfillCommunicationEvents'))
  assert.match(loader, /FROM relationships\.communications rc/)
  assert.doesNotMatch(loader, /FROM email\.emails|FROM public\.messages/)
  assert.match(loader, /rows: comms\.rows\.map\(row => \(\{ \.\.\.row, source_table: 'relationships\.communications'/)
  assert.match(loader, /rc\.source_id AS source_ref/)
})
