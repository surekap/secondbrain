#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') });

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const db   = require('@secondbrain/db');
const { createLogger } = require('./logger');

let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null

const log = createLogger('email');

log.info('Email Agent starting');

async function ensureSchema() {
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8');
    await db.query(sql);
    log.info('Schema ready');
  } catch (err) {
    log.error(`Schema setup error: ${err.message}`);
  }
}

let _emailsDiscovered = 0
let _emailsDownloaded = 0

async function fetchEmails() {
  if (telemetry && !_runId) {
    _runId = await telemetry.startRun({ agentId: 'email', workflowName: 'email_sync' })
  }
  try {
    log.info('Fetching emails...');
    const { run } = require('./cron/fetchEmails');
    const summary = await run();
    log.info('Email fetch completed');
    if (summary) {
      _emailsDiscovered += (summary.processed || 0) + (summary.skipped || 0)
      _emailsDownloaded += summary.processed || 0
    }
    if (telemetry && _runId) {
      telemetry.progress(_runId, 'emails_discovered', { completed: _emailsDiscovered })
      telemetry.progress(_runId, 'emails_downloaded', { completed: _emailsDownloaded })
    }
  } catch (err) {
    log.error(`Email fetch failed: ${err.message}`);
  }
}

log.info('Scheduling email fetch every 15 minutes');

cron.schedule('*/15 * * * *', fetchEmails);

log.info('Starting initial fetch...');
ensureSchema().then(() => fetchEmails());

process.on('SIGINT', async () => {
  log.info('Shutting down...');
  if (telemetry && _runId) {
    await telemetry.endRun(_runId, { status: 'completed' })
    await telemetry.flush()
  }
  const pool = require('@secondbrain/db');
  pool.end().then(() => process.exit(0));
});

log.info('Email Agent running \u2014 press Ctrl+C to stop');

process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`);
});
