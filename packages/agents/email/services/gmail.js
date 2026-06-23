"use strict";

const { ImapFlow } = require("imapflow");

const PS_LABEL = "ps";

class GmailClient {
  /**
   * @param {string} email
   * @param {string} appPassword
   * @param {{ debug: Function, info: Function, warn: Function, error: Function }} logger
   */
  constructor(email, appPassword, logger) {
    this.email = email;
    this.appPassword = appPassword;
    this.logger = logger;
    this.client = null;
    this.isConnecting = false;
    this.connectionError = null;
  }

  _createClient() {
    return new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: {
        user: this.email,
        pass: this.appPassword,
      },
      // Suppress imapflow's own logger; we use our own
      logger: false,
    });
  }

  async connect() {
    if (this.isConnecting) {
      throw new Error("Connection already in progress");
    }
    if (this.client?.usable) {
      return; // Already connected
    }

    this.isConnecting = true;
    this.connectionError = null;

    try {
      this.client = this._createClient();

      // Handle connection errors that occur during long-running operations
      this.client.on('error', (err) => {
        this.logger.error(`IMAP connection error: ${err.message}`);
        this.connectionError = err;
      });

      await this.client.connect();
      this.logger.info(`Connected to Gmail IMAP for ${this.email}`);
    } finally {
      this.isConnecting = false;
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (_) {
        // ignore errors on disconnect
      }
      this.client = null;
      this.logger.info(`Disconnected from Gmail IMAP for ${this.email}`);
    }
  }

  /**
   * Check if the connection is usable and reconnect if needed
   * @returns {Promise<boolean>} true if connection is ready
   */
  async ensureConnected() {
    if (this.client?.usable && !this.connectionError) {
      return true;
    }

    // Connection is dead, try to reconnect
    this.logger.warn('IMAP connection lost, reconnecting...');
    await this.disconnect();
    await this.connect();
    return true;
  }

  /**
   * Execute an IMAP operation with automatic retry and exponential backoff
   * @param {Function} operation - Async function to execute
   * @param {string} operationName - Name for logging
   * @param {Object} options - Retry options
   * @returns {Promise<any>}
   */
  async withRetry(operation, operationName, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const baseDelayMs = options.baseDelayMs || 1000;
    const maxDelayMs = options.maxDelayMs || 30000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Ensure connection before each attempt
        await this.ensureConnected();

        return await operation();
      } catch (err) {
        const isConnectionError = err.code === 'ETIMEDOUT' ||
                                  err.code === 'ECONNRESET' ||
                                  err.code === 'EPIPE' ||
                                  err.code === 'ENOTFOUND' ||
                                  err.message?.includes('socket') ||
                                  err.message?.includes('timeout') ||
                                  err.message?.includes('connection') ||
                                  this.connectionError;

        if (attempt === maxRetries) {
          this.logger.error(`${operationName} failed after ${maxRetries} attempts: ${err.message}`);
          throw err;
        }

        if (isConnectionError) {
          // Exponential backoff: 1s, 2s, 4s (capped at maxDelayMs)
          const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
          this.logger.warn(`${operationName} failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delay}ms...`);

          // Clear connection error state and disconnect
          this.connectionError = null;
          await this.disconnect().catch(() => {});

          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Non-connection errors don't get retried
          throw err;
        }
      }
    }
  }

  /**
   * Create the "ps" mailbox/label if it doesn't already exist.
   * In Gmail IMAP, creating a mailbox adds a label.
   */
  async ensurePsLabelExists() {
    return this.withRetry(async () => {
      try {
        await this.client.mailboxCreate(PS_LABEL);
        this.logger.info(`Created Gmail label "${PS_LABEL}"`);
      } catch (err) {
        // ALREADYEXISTS is expected on subsequent runs — ignore it
        if (
          err.responseCode === "ALREADYEXISTS" ||
          /already exists/i.test(err.message)
        ) {
          this.logger.debug(`Label "${PS_LABEL}" already exists`);
        } else {
          throw err;
        }
      }
    }, 'ensurePsLabelExists');
  }

  /**
   * Returns UIDs in the source mailbox that are NOT present in the "ps" label.
   *
   * Strategy: fetch all UIDs from INBOX, fetch all UIDs from "ps", then
   * use Gmail's X-GM-MSGID (unique per message across mailboxes) to diff.
   * Fall back to a simpler UID-set subtraction if X-GM-MSGID is unavailable.
   *
   * @param {string} mailbox
   * @returns {Promise<number[]>}
   */
  async getUnprocessedUIDs(mailbox = "INBOX") {
    return this.withRetry(async () => {
      // --- Step 1: get all UIDs in INBOX with their Gmail message IDs ---
      const inboxUIDtoGmsgid = new Map(); // uid → gmsgid
      {
        const lock = await this.client.getMailboxLock(mailbox, {
          readonly: true,
        });
        try {
          const allUIDs = await this.client.search({ all: true }, { uid: true });
          if (!allUIDs || allUIDs.length === 0) return [];

          for await (const msg of this.client.fetch(
            allUIDs.join(","),
            { uid: true, gmailMsgId: true },
            { uid: true },
          )) {
            inboxUIDtoGmsgid.set(msg.uid, msg.gmailMsgId ?? msg.uid);
          }
        } finally {
          lock.release();
        }
      }

      if (inboxUIDtoGmsgid.size === 0) return [];

      // --- Step 2: get all Gmail message IDs already in "ps" label ---
      const psGmsgids = new Set();
      try {
        const lock = await this.client.getMailboxLock(PS_LABEL, {
          readonly: true,
        });
        try {
          const psUIDs = await this.client.search({ all: true }, { uid: true });
          if (psUIDs && psUIDs.length > 0) {
            for await (const msg of this.client.fetch(
              psUIDs.join(","),
              { uid: true, gmailMsgId: true },
              { uid: true },
            )) {
              psGmsgids.add(msg.gmailMsgId ?? msg.uid);
            }
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        // "ps" mailbox may be empty or not yet accessible — treat as no processed msgs
        this.logger.debug(`Could not read "${PS_LABEL}" mailbox: ${err.message}`);
      }

      // --- Step 3: return INBOX UIDs whose gmsgid is NOT in ps ---
      const unprocessed = [];
      for (const [uid, gmsgid] of inboxUIDtoGmsgid) {
        if (!psGmsgids.has(gmsgid)) {
          unprocessed.push(uid);
        }
      }

      this.logger.debug(
        `${mailbox}: ${inboxUIDtoGmsgid.size} total, ` +
          `${psGmsgids.size} in "${PS_LABEL}", ${unprocessed.length} to process`,
      );

      return unprocessed;
    }, 'getUnprocessedUIDs');
  }

  /**
   * Fetch the full RFC822 source plus flags and Gmail metadata for a UID.
   * Opens INBOX in read-only mode so the \Seen flag is never set.
   *
   * @param {number} uid
   * @returns {Promise<{ uid: number, source: Buffer, flags: string[], labels: string[], thrid: string|null }>}
   */
  async fetchMessage(uid) {
    return this.withRetry(async () => {
      const lock = await this.client.getMailboxLock("INBOX", { readonly: true });
      try {
        let result = null;
        for await (const msg of this.client.fetch(
          String(uid),
          {
            uid: true,
            flags: true,
            source: true,
            gmailLabels: true,
            gmailThreadId: true,
          },
          { uid: true },
        )) {
          result = {
            uid: msg.uid,
            source: msg.source,
            flags: [...(msg.flags || [])],
            labels: [...(msg.gmailLabels || [])],
            thrid: msg.gmailThreadId ? String(msg.gmailThreadId) : null,
          };
        }
        if (!result) throw new Error(`UID ${uid} not found in INBOX`);
        return result;
      } finally {
        lock.release();
      }
    }, `fetchMessage(${uid})`);
  }

  /**
   * Apply the "ps" label to a message by copying it to the "ps" mailbox.
   * COPY adds the label in Gmail without moving or modifying the original.
   *
   * @param {number} uid
   */
  async applyPsLabel(uid) {
    return this.withRetry(async () => {
      // We need read-write access for COPY; open INBOX in default (rw) mode.
      // This does NOT affect \Seen — COPY is not a read operation.
      const lock = await this.client.getMailboxLock("INBOX");
      try {
        await this.client.messageCopy(String(uid), PS_LABEL, { uid: true });
        this.logger.debug(`Applied label "${PS_LABEL}" to UID ${uid}`);
      } finally {
        lock.release();
      }
    }, `applyPsLabel(${uid})`);
  }
}

module.exports = { GmailClient };
