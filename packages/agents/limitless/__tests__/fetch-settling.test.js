'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { lifelogSnapshot, settleLatestWindow } = require('../cron/fetchLifelogs')

test('lifelog snapshots detect transcript changes independent of API ordering', () => {
  const left = [{ id: '2', markdown: 'beta' }, { id: '1', markdown: 'alpha' }]
  const same = [{ id: '1', markdown: 'alpha' }, { id: '2', markdown: 'beta' }]
  const changed = [{ id: '1', markdown: 'alpha updated' }, { id: '2', markdown: 'beta' }]
  assert.equal(lifelogSnapshot(left), lifelogSnapshot(same))
  assert.notEqual(lifelogSnapshot(left), lifelogSnapshot(changed))
})

test('newest API window waits through changes until two quiet refreshes', async () => {
  const versions = [
    [{ id: '1', markdown: 'still changing' }],
    [{ id: '1', markdown: 'final' }],
    [{ id: '1', markdown: 'final' }],
    [{ id: '1', markdown: 'final' }],
  ]
  const saved = []
  let waits = 0
  const result = await settleLatestWindow({
    initialLogs: [{ id: '1', markdown: 'initial' }],
    fetchWindow: async () => versions.shift(),
    save: async logs => saved.push(logs[0].markdown),
    wait: async () => { waits += 1 },
    delayMs: 1,
    stablePasses: 2,
    maxRefreshes: 6,
  })

  assert.equal(result.settled, true)
  assert.equal(result.refreshes, 4)
  assert.equal(waits, 4)
  assert.deepEqual(saved, ['still changing', 'final', 'final', 'final'])
})
