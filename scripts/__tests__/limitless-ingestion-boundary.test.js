#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '../..')
const agent = fs.readFileSync(path.join(repo, 'packages/agents/limitless/index.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages/agents/limitless/package.json'), 'utf8'))

test('Limitless is an idempotent raw-ingestion boundary, not an ambient action executor', () => {
  assert.match(agent, /fetchFromLimitless/)
  assert.match(agent, /lifelog_ingestion/)
  assert.doesNotMatch(agent, /loadMCPTools|processLifelog|executeTool/)
  assert.equal(pkg.dependencies['@notionhq/client'], undefined)
  assert.equal(pkg.dependencies['@anthropic-ai/sdk'], undefined)
  assert.equal(pkg.dependencies.openai, undefined)
})

test('removed autonomous tools are not present in the connector', () => {
  for (const name of ['agent.js', 'tools/notion-mcp.js', 'tools/stock-mcp.js', 'tools/todoist-mcp.js']) {
    assert.equal(fs.existsSync(path.join(repo, 'packages/agents/limitless', name)), false, name)
  }
})
