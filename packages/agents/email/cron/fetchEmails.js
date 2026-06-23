'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../.env.local') });

const { simpleParser } = require('mailparser');
const pool = require('@secondbrain/db');
const { GmailClient } = require('../services/gmail');
const batching = require('../../shared/batching');

// ── Config ───────────────────────────────────────────────────────────────────

function loadAccounts() {
  const accounts = [];
  let i = 1;
  while (process.env[`GMAIL_EMAIL_${i}`]) {
    const email       = process.env[`GMAIL_EMAIL_${i}`].trim();
    const appPassword = process.env[`GMAIL_APP_PASSWORD_${i}`];
    if (!appPassword) {
      throw new Error(`GMAIL_APP_PASSWORD_${i} is missing for account ${email}`);
    }
    accounts.push({ email, appPassword: appPassword.trim() });
    i++;
  }
  if (accounts.length === 0) {
    throw new Error(
      'No Gmail accounts configured. Add GMAIL_EMAIL_1 and GMAIL_APP_PASSWORD_1 to .env.local'
    );
  }
  return accounts;
}

// ── Database helpers (email schema) ──────────────────────────────────────────

async function upsertAccount(email) {
  const { rows } = await pool.query(
    `INSERT INTO email.accounts (email)
     VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [email]
  );
  return rows[0];
}

async function emailExists(accountId, gmailUid) {
  const { rows } = await pool.query(
    'SELECT 1 FROM email.emails WHERE account_id = $1 AND gmail_uid = $2',
    [accountId, String(gmailUid)]
  );
  return rows.length > 0;
}

async function saveEmail(accountId, emailData) {
  await pool.query(
    `INSERT INTO email.emails (
       account_id, message_id, gmail_uid, thread_id,
       subject, from_address, to_addresses, cc_addresses, bcc_addresses,
       reply_to, date, received_at, body_text, body_html,
       raw_headers, attachments, labels, is_read
     ) VALUES (
       $1,  $2,  $3,  $4,
       $5,  $6,  $7,  $8,  $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18
     )
     ON CONFLICT (account_id, gmail_uid) DO NOTHING`,
    [
      accountId,
      emailData.message_id    || null,
      String(emailData.gmail_uid),
      emailData.thread_id     || null,
      emailData.subject       || null,
      emailData.from_address  || null,
      emailData.to_addresses  || [],
      emailData.cc_addresses  || [],
      emailData.bcc_addresses || [],
      emailData.reply_to      || null,
      emailData.date          || null,
      emailData.received_at   || new Date(),
      emailData.body_text     || null,
      emailData.body_html     || null,
      emailData.raw_headers   ? JSON.stringify(emailData.raw_headers) : null,
      emailData.attachments   ? JSON.stringify(emailData.attachments) : null,
      emailData.labels        || [],
      emailData.is_read       ?? false,
    ]
  );
}

async function updateAccountSyncTime(accountId) {
  await pool.query(
    'UPDATE email.accounts SET last_synced_at = NOW() WHERE id = $1',
    [accountId]
  );
}

// ── Email parsing ─────────────────────────────────────────────────────────────

async function parseEmail(rawSource, uid, flags = []) {
  const parsed = await simpleParser(rawSource);

  const is_read = Array.isArray(flags) && flags.includes('\\Seen');

  const raw_headers = {};
  if (parsed.headers) {
    for (const [key, value] of parsed.headers) {
      raw_headers[key] = Array.isArray(value) ? value : String(value);
    }
  }

  return {
    gmail_uid:     uid,
    message_id:    parsed.messageId || String(uid),
    thread_id:     null,  // populated by caller from X-GM-THRID
    subject:       parsed.subject || '',
    from_address:  parsed.from?.text || '',
    to_addresses:  parsed.to?.value?.map((a) => a.address).filter(Boolean)  || [],
    cc_addresses:  parsed.cc?.value?.map((a) => a.address).filter(Boolean)  || [],
    bcc_addresses: parsed.bcc?.value?.map((a) => a.address).filter(Boolean) || [],
    reply_to:      parsed.replyTo?.text || null,
    date:          parsed.date || null,
    received_at:   new Date(),
    body_text:     parsed.text  || null,
    body_html:     parsed.html  || null,
    raw_headers,
    attachments: await Promise.all((parsed.attachments || []).map(async (a) => {
      const base = {
        filename:    a.filename    || null,
        contentType: a.contentType || null,
        size:        a.size        || 0,
      }

      // Extract text from PDF/spreadsheet attachments
      const ct = (a.contentType || '').toLowerCase()
      const fn = (a.filename || '').toLowerCase()
      if (a.content && (ct.includes('pdf') || fn.endsWith('.pdf'))) {
        try {
          const pdfParse = require('pdf-parse')
          const data = await pdfParse(a.content)
          base.extracted_text = (data.text || '').slice(0, 3000)
        } catch { /* non-fatal */ }
      } else if (a.content && (ct.includes('spreadsheet') || ct.includes('excel') ||
                 fn.endsWith('.xlsx') || fn.endsWith('.xls') || fn.endsWith('.csv'))) {
        try {
          const XLSX = require('xlsx')
          const wb = XLSX.read(a.content)
          const texts = wb.SheetNames.slice(0, 3).map(s => {
            return `[${s}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`
          })
          base.extracted_text = texts.join('\n\n').slice(0, 3000)
        } catch { /* non-fatal */ }
      }

      return base
    })),
    labels:  [],  // populated by caller from X-GM-LABELS
    is_read,
  };
}

// ── Account processing ────────────────────────────────────────────────────────

async function processAccount(account, gmailClient, logger, options = {}) {
  const { batchSize = 50, mailbox = 'INBOX' } = options;

  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  // 1. Ensure the tracking label exists in Gmail
  await gmailClient.ensurePsLabelExists();

  // 2. Get UIDs that haven't received the "ps" label yet
  const uids = await gmailClient.getUnprocessedUIDs(mailbox);
  logger.info(`Found ${uids.length} message(s) to process in ${mailbox}`);

  if (uids.length === 0) {
    await updateAccountSyncTime(account.id);
    return { processed, skipped, errors };
  }

  // 3. Process in parallel batches (fetching is I/O bound, can be parallelized)
  const PARALLEL_SIZE = 5; // Fetch 5 emails simultaneously
  const DELAY_BETWEEN_BATCHES = 500; // Delay between batches to avoid overwhelming Gmail API

  const results = await batching.processBatch(
    uids,
    async (uid) => {
      try {
        // Skip if already stored
        if (await emailExists(account.id, uid)) {
          logger.debug(`UID ${uid} already in DB — skipping`);
          return { skipped: true };
        }

        // Fetch raw message — read-only; \Seen flag is never set
        const { source, flags, labels, thrid } = await gmailClient.fetchMessage(uid);

        // Parse
        const emailData = await parseEmail(source, uid, flags);
        if (thrid)  emailData.thread_id = thrid;
        if (labels) emailData.labels    = labels;

        // Persist
        await saveEmail(account.id, emailData);

        // Mark as processed in Gmail (COPY to "ps" mailbox = add label)
        await gmailClient.applyPsLabel(uid);

        logger.info(`Saved UID ${uid} subject="${emailData.subject}"`);
        return { success: true, subject: emailData.subject };

      } catch (err) {
        logger.error(`Failed on UID ${uid}: ${err.message}`);
        return { error: err.message };
      }
    },
    {
      batchSize: PARALLEL_SIZE,
      delayBetweenBatches: DELAY_BETWEEN_BATCHES,
      onBatchComplete: (batchInfo) => {
        const newProcessed = batchInfo.successCount;
        processed += newProcessed;
        skipped += batchInfo.itemsInBatch - newProcessed - batchInfo.errorCount;
        errors += batchInfo.errorCount;

        logger.info(
          `Batch ${batchInfo.batchNum}/${batchInfo.totalBatches} done — ` +
          `processed: ${processed}, skipped: ${skipped}, errors: ${errors}`
        );
      }
    }
  );

  // 4. Update sync timestamp
  await updateAccountSyncTime(account.id);

  return { processed, skipped, errors };
}

// ── Main run function ─────────────────────────────────────────────────────────

async function run() {
  const { createLogger } = require('../logger');
  const log = createLogger('email');

  const accounts  = loadAccounts();
  const batchSize = parseInt(process.env.BATCH_SIZE || '50', 10);
  const mailbox   = process.env.MAILBOX || 'INBOX';

  log.info(`Starting email sync for ${accounts.length} account(s)`);

  const summary = { processed: 0, skipped: 0, errors: 0 };

  // Sequential processing — respects Gmail rate limits per account
  for (const accountConfig of accounts) {
    const accountLog = log.child(accountConfig.email);
    accountLog.info('Starting sync');

    let gmailClient;
    let accountRetries = 0;
    const maxAccountRetries = 2;

    while (accountRetries <= maxAccountRetries) {
      try {
        const account = await upsertAccount(accountConfig.email);

        gmailClient = new GmailClient(accountConfig.email, accountConfig.appPassword, accountLog);
        await gmailClient.connect();

        const result = await processAccount(account, gmailClient, accountLog, { batchSize, mailbox });

        summary.processed += result.processed;
        summary.skipped   += result.skipped;
        summary.errors    += result.errors;

        accountLog.info(
          `Sync complete — processed: ${result.processed}, ` +
          `skipped: ${result.skipped}, errors: ${result.errors}`
        );

        // Success - break out of retry loop
        break;

      } catch (err) {
        accountRetries++;
        if (accountRetries <= maxAccountRetries) {
          const delay = 5000 * accountRetries; // 5s, 10s
          accountLog.warn(`Account sync failed (attempt ${accountRetries}/${maxAccountRetries + 1}): ${err.message}. Retrying in ${delay}ms...`);
          if (gmailClient) {
            await gmailClient.disconnect().catch(() => {});
            gmailClient = null;
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          accountLog.error(`Account sync failed after ${maxAccountRetries + 1} attempts: ${err.message}`);
          summary.errors++;
        }
      } finally {
        if (gmailClient) {
          await gmailClient.disconnect().catch(() => {});
        }
      }
    }
  }

  log.info(
    `All accounts processed — ` +
    `total processed: ${summary.processed}, ` +
    `skipped: ${summary.skipped}, ` +
    `errors: ${summary.errors}`
  );

  return summary;
}

if (require.main === module) {
  // Global error handlers to prevent crashes from unhandled async errors
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    pool.end().finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    pool.end().finally(() => process.exit(1));
  });

  run()
    .then((summary) => pool.end().then(() => process.exit(summary.errors > 0 ? 1 : 0)))
    .catch((err) => {
      console.error('Fatal error:', err);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { run };
