#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const fs = require('fs')
const path = require('path')
const db = require('@secondbrain/db')

async function main() {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(fs.readFileSync(path.join(__dirname, 'sql/schema.sql'), 'utf8'))
    await client.query('COMMIT')
    console.log('Relationship schema migration completed')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
    await db.end()
  }
}

main().catch(err => {
  console.error(`[relationship-migration] ${err.message}`)
  process.exit(1)
})
