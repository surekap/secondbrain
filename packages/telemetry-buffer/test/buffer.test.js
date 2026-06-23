// packages/telemetry-buffer/test/buffer.test.js
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { createBuffer } = require('../index')

test('enqueue increments emitted count', () => {
  const buf = createBuffer({ maxMemory: 100, spillDir: null, drainIntervalMs: 0 })
  buf.enqueue({ type: 'test', data: 1 })
  buf.enqueue({ type: 'test', data: 2 })
  assert.equal(buf.counts().emitted, 2)
  buf.stop()
})

test('drain calls writer with batched events', async () => {
  const buf = createBuffer({ maxMemory: 100, spillDir: null, drainIntervalMs: 0 })
  buf.enqueue({ type: 'a' })
  buf.enqueue({ type: 'b' })
  const written = []
  await buf.drain(async (events) => { written.push(...events) })
  assert.equal(written.length, 2)
  assert.equal(written[0].type, 'a')
  buf.stop()
})

test('drops events when maxMemory exceeded, increments dropped count', () => {
  const buf = createBuffer({ maxMemory: 2, spillDir: null, drainIntervalMs: 0 })
  buf.enqueue({ type: '1' })
  buf.enqueue({ type: '2' })
  buf.enqueue({ type: '3' }) // should drop
  assert.equal(buf.counts().emitted, 3)
  assert.equal(buf.counts().dropped, 1)
  buf.stop()
})

test('spills to disk on writer failure', async () => {
  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbuf-'))
  const buf = createBuffer({ maxMemory: 100, spillDir, drainIntervalMs: 0 })
  buf.enqueue({ type: 'spill_me' })
  await buf.drain(async () => { throw new Error('DB down') })
  const files = fs.readdirSync(spillDir).filter(f => f.endsWith('.ndjson'))
  assert.ok(files.length > 0, 'should have spill file')
  const content = fs.readFileSync(path.join(spillDir, files[0]), 'utf8').trim()
  assert.ok(content.includes('spill_me'))
  fs.rmSync(spillDir, { recursive: true })
  buf.stop()
})
