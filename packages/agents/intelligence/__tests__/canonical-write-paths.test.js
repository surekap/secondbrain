#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const indexPath = path.join(__dirname, '..', 'index.js')
const source = fs.readFileSync(indexPath, 'utf8')

test('intelligence write paths canonicalize contacts before writing signals and opportunities', () => {
  assert.match(source, /canonicalizeEntityId/)
  assert.match(source, /canonicalizeEntityIds/)

  const upsertOpportunity = source.slice(source.indexOf('async function upsertOpportunity'), source.indexOf('async function recordSignalForOpportunity'))
  assert.match(upsertOpportunity, /canonicalizeEntityId\(db, 'contact'/)
  assert.match(upsertOpportunity, /canonicalPrimaryContactId/)

  const recordSignal = source.slice(source.indexOf('async function recordSignalForOpportunity'), source.indexOf('async function linkContacts'))
  assert.match(recordSignal, /canonicalizeEntityId\(db, 'contact'/)

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
