#!/usr/bin/env node
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const serverSource = fs.readFileSync(path.join(__dirname, '../../packages/ui/server.js'), 'utf8')
const deployScript = fs.readFileSync(path.join(__dirname, '../../scripts/deploy-pull-reload.sh'), 'utf8')

test('server exposes guarded deploy reload API', () => {
  assert.match(serverSource, /app\.get\('\/api\/system\/deploy\/status'/)
  assert.match(serverSource, /app\.get\('\/api\/system\/deploy\/log'/)
  assert.match(serverSource, /DEPLOY_LOG_FILE/)
  assert.match(serverSource, /tail \|\| 20000/)
  assert.match(serverSource, /app\.post\('\/api\/system\/deploy\/reload'/)
  assert.match(serverSource, /confirm.*pull-and-reload/s)
  assert.match(serverSource, /SECOND_BRAIN_DEPLOY_TOKEN/)
  assert.match(serverSource, /deployAlreadyRunning\(\)/)
  assert.match(serverSource, /SECOND_BRAIN_DEPLOY_INSTALL/)
  assert.match(serverSource, /req\.body\?\.install === true \? '1' : '0'/)
})

test('deploy reload script is fast-forward only and restarts UI listeners', () => {
  assert.match(deployScript, /git fetch origin "\$BRANCH"/)
  assert.match(deployScript, /git pull --ff-only origin "\$BRANCH"/)
  assert.match(deployScript, /git status --porcelain/)
  assert.match(deployScript, /SECOND_BRAIN_DEPLOY_INSTALL/)
  assert.match(deployScript, /write_status "running" "install" "Installing npm dependencies"/)
  assert.match(deployScript, /npm install 2>&1 \| tee -a "\$LOG_FILE"/)
  assert.match(deployScript, /npm run build --workspace=packages\/ui/)
  assert.match(deployScript, /lsof -ti tcp:4000/)
  assert.match(deployScript, /lsof -ti tcp:4001/)
  assert.match(deployScript, /nohup npm run ui/)
  assert.match(deployScript, /api\/intelligence\/refresh\/status/)
})
