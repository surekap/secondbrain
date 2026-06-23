'use strict';

// Set process title so macOS shows "secondbrain" in Privacy & Security → Contacts
process.title = 'secondbrain';

const path   = require('path');
const fs     = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

const db = require('@secondbrain/db');
const { syncContacts } = require('./services/syncer');

async function ensureSchema() {
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8');
    await db.query(sql);
    console.log('[apple-contacts] Schema ready');
  } catch (err) {
    console.error('[apple-contacts] Schema setup error:', err.message);
  }
}

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runNativeSync() {
  console.log('[apple-contacts] Starting native sync…');
  let reader;
  try {
    reader = require('./services/nativeReader');
  } catch (err) {
    console.error('[apple-contacts] Cannot load native reader:', err.message);
    process.exit(1);
  }

  const contacts = await reader.readNativeContacts();
  console.log(`[apple-contacts] Read ${contacts.length} contacts from Apple Contacts`);

  const result = await syncContacts(contacts);
  console.log(
    `[apple-contacts] Sync complete — total: ${result.total}, ` +
    `matched: ${result.matched}, created: ${result.created}, skipped: ${result.skipped}`
  );
  return result;
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[apple-contacts] Native Apple Contacts sync not available on this platform.');
    console.log('[apple-contacts] Use "Upload VCF" on the Agents page to import contacts.');
    process.exit(0);
  }

  await ensureSchema();

  // Run immediately on start
  await runNativeSync();

  // Then schedule daily
  setInterval(async () => {
    try {
      await runNativeSync();
    } catch (err) {
      console.error('[apple-contacts] Sync error:', err.message);
    }
  }, SYNC_INTERVAL_MS);

  // Stay alive
  process.on('SIGINT',  () => { console.log('[apple-contacts] Stopped.'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('[apple-contacts] Stopped.'); process.exit(0); });
}

main().catch(err => {
  console.error('[apple-contacts] Fatal:', err.message);
  process.exit(1);
});
