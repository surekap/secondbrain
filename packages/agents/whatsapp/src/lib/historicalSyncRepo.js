'use strict';

const LOCK_PREFIX = 'secondbrain:whatsapp:historical-sync:';

function runningError() {
  const error = new Error('historical sync already running');
  error.code = 'SYNC_RUNNING';
  return error;
}

class DurableSyncLease {
  constructor(client, clientId, run) {
    this.client = client;
    this.clientId = clientId;
    this.run = run;
    this.released = false;
  }

  async query(sql, params = []) {
    return this.client.query(sql, params);
  }

  async transaction(callback) {
    await this.client.query('BEGIN');
    try {
      const result = await callback(this.client);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      try { await this.client.query('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  async manifests() {
    const { rows } = await this.client.query(`
      SELECT chat_id, is_group, status
      FROM whatsapp_sync_checkpoints
      WHERE run_id = $1 AND checkpoint_kind = 'chat'
      ORDER BY chat_id
    `, [this.run.id]);
    return rows;
  }

  async seedManifests(chats) {
    if (chats.length) {
      await this.client.query(`
        INSERT INTO whatsapp_sync_checkpoints (
          run_id, client_id, chat_id, is_group, checkpoint_kind,
          page_number, window_start, window_end, status
        )
        SELECT $1, $2, manifest.chat_id, manifest.is_group,
               'chat', -1, $3, $4, 'pending'
        FROM UNNEST($5::text[], $6::boolean[]) AS manifest(chat_id, is_group)
        ON CONFLICT (run_id, chat_id, checkpoint_kind, page_number) DO NOTHING
      `, [
        this.run.id,
        this.clientId,
        this.run.window_start,
        this.run.window_end,
        chats.map(chat => chat.chatId),
        chats.map(chat => chat.isGroup),
      ]);
    }
    const { rows } = await this.client.query(`
      UPDATE whatsapp_sync_runs
      SET total_chats = $2, heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [this.run.id, chats.length]);
    this.run = rows[0] || this.run;
  }

  async markChatRunning(chatId) {
    await this.client.query(`
      UPDATE whatsapp_sync_checkpoints
      SET status = 'running', started_at = COALESCE(started_at, NOW()),
          error = NULL, updated_at = NOW()
      WHERE run_id = $1 AND chat_id = $2
        AND checkpoint_kind = 'chat' AND page_number = -1
        AND status <> 'completed'
    `, [this.run.id, chatId]);
  }

  async markChatFailed(chatId, error) {
    const message = String(error?.message || error).slice(0, 2000);
    const { rows } = await this.transaction(async client => {
      await client.query(`
        UPDATE whatsapp_sync_checkpoints
        SET status = 'failed', failed_count = failed_count + 1,
            error = $3, completed_at = NOW(), updated_at = NOW()
        WHERE run_id = $1 AND chat_id = $2
          AND checkpoint_kind = 'chat' AND page_number = -1
          AND status <> 'completed'
      `, [this.run.id, chatId, message]);
      return client.query(`
        UPDATE whatsapp_sync_runs
        SET failed_count = failed_count + 1, heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [this.run.id]);
    });
    this.run = rows[0] || this.run;
    return this.run;
  }

  async completedPages(chatId) {
    const { rows } = await this.client.query(`
      SELECT page_number, cursor_wa_msg_id, fetched_count
      FROM whatsapp_sync_checkpoints
      WHERE run_id = $1 AND chat_id = $2
        AND checkpoint_kind = 'page' AND status = 'completed'
    `, [this.run.id, chatId]);
    return new Map(rows.map(row => [Number(row.page_number), {
      cursorWaMsgId: row.cursor_wa_msg_id,
      fetchedCount: Number(row.fetched_count),
    }]));
  }

  async markPageRunning({ chatId, isGroup, pageNumber, pageStart, pageEnd, cursorWaMsgId, fetchedCount }) {
    await this.client.query(`
      INSERT INTO whatsapp_sync_checkpoints (
        run_id, client_id, chat_id, is_group, checkpoint_kind,
        page_number, window_start, window_end, page_start_ts,
        page_end_ts, cursor_wa_msg_id, fetched_count, status, started_at
      ) VALUES ($1,$2,$3,$4,'page',$5,$6,$7,$8,$9,$10,$11,'running',NOW())
      ON CONFLICT (run_id, chat_id, checkpoint_kind, page_number) DO UPDATE SET
        status = CASE
          WHEN whatsapp_sync_checkpoints.status = 'completed'
            AND whatsapp_sync_checkpoints.cursor_wa_msg_id IS NOT DISTINCT FROM EXCLUDED.cursor_wa_msg_id
            AND whatsapp_sync_checkpoints.fetched_count = EXCLUDED.fetched_count
            THEN 'completed'
          ELSE 'running'
        END,
        page_start_ts = EXCLUDED.page_start_ts,
        page_end_ts = EXCLUDED.page_end_ts,
        cursor_wa_msg_id = EXCLUDED.cursor_wa_msg_id,
        fetched_count = EXCLUDED.fetched_count,
        error = CASE
          WHEN whatsapp_sync_checkpoints.status = 'completed'
            AND whatsapp_sync_checkpoints.cursor_wa_msg_id IS NOT DISTINCT FROM EXCLUDED.cursor_wa_msg_id
            AND whatsapp_sync_checkpoints.fetched_count = EXCLUDED.fetched_count
            THEN whatsapp_sync_checkpoints.error
          ELSE NULL
        END,
        started_at = COALESCE(whatsapp_sync_checkpoints.started_at, NOW()),
        updated_at = NOW()
    `, [
      this.run.id,
      this.clientId,
      chatId,
      isGroup,
      pageNumber,
      this.run.window_start,
      this.run.window_end,
      pageStart,
      pageEnd,
      cursorWaMsgId,
      fetchedCount,
    ]);
  }

  async completePage(chatId, pageNumber, counts) {
    const result = await this.transaction(async client => {
      const { rows: previousRows } = await client.query(`
        SELECT status, saved_count, duplicate_count
        FROM whatsapp_sync_checkpoints
        WHERE run_id = $1 AND chat_id = $2
          AND checkpoint_kind = 'page' AND page_number = $3
        FOR UPDATE
      `, [this.run.id, chatId, pageNumber]);
      const previous = previousRows[0];
      if (!previous || previous.status === 'completed') return null;
      await client.query(`
        UPDATE whatsapp_sync_checkpoints
        SET status = 'completed', fetched_count = $3,
            saved_count = saved_count + $4,
            duplicate_count = duplicate_count + $5,
            failed_count = 0, error = NULL,
            completed_at = NOW(), updated_at = NOW()
        WHERE run_id = $1 AND chat_id = $2
          AND checkpoint_kind = 'page' AND page_number = $6
      `, [this.run.id, chatId, counts.fetched, counts.saved, counts.duplicates, pageNumber]);
      return client.query(`
        UPDATE whatsapp_sync_runs
        SET saved_count = saved_count + $2,
            duplicate_count = duplicate_count + $3,
            heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [this.run.id, counts.saved, counts.duplicates]);
    });
    if (result?.rows?.[0]) this.run = result.rows[0];
    return this.run;
  }

  async markPageFailed(chatId, pageNumber, fetchedCount, error) {
    const message = String(error?.message || error).slice(0, 2000);
    const { rows } = await this.transaction(async client => {
      await client.query(`
        UPDATE whatsapp_sync_checkpoints
        SET status = 'failed', fetched_count = $3,
            failed_count = failed_count + 1, error = $4,
            completed_at = NOW(), updated_at = NOW()
        WHERE run_id = $1 AND chat_id = $2
          AND checkpoint_kind = 'page' AND page_number = $5
          AND status <> 'completed'
      `, [this.run.id, chatId, fetchedCount, message, pageNumber]);
      return client.query(`
        UPDATE whatsapp_sync_runs
        SET failed_count = failed_count + 1,
            heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [this.run.id]);
    });
    this.run = rows[0] || this.run;
    return this.run;
  }

  async completeChat({ chatId, isGroup, highWatermarkTs, highWatermarkWaMsgId }) {
    const result = await this.transaction(async client => {
      const completed = await client.query(`
        UPDATE whatsapp_sync_checkpoints
        SET status = 'completed', error = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE run_id = $1 AND chat_id = $2
          AND checkpoint_kind = 'chat' AND page_number = -1
          AND status <> 'completed'
        RETURNING id
      `, [this.run.id, chatId]);
      await client.query(`
        INSERT INTO whatsapp_sync_watermarks (
          client_id, chat_id, is_group, high_watermark_ts,
          high_watermark_wa_msg_id, last_completed_window_start,
          last_completed_window_end, last_run_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (client_id, chat_id) DO UPDATE SET
          is_group = EXCLUDED.is_group,
          high_watermark_ts = CASE
            WHEN EXCLUDED.high_watermark_ts IS NULL THEN whatsapp_sync_watermarks.high_watermark_ts
            ELSE GREATEST(
              COALESCE(whatsapp_sync_watermarks.high_watermark_ts, EXCLUDED.high_watermark_ts),
              EXCLUDED.high_watermark_ts
            )
          END,
          high_watermark_wa_msg_id = CASE
            WHEN EXCLUDED.high_watermark_ts IS NULL THEN whatsapp_sync_watermarks.high_watermark_wa_msg_id
            WHEN whatsapp_sync_watermarks.high_watermark_ts IS NULL
              OR EXCLUDED.high_watermark_ts >= whatsapp_sync_watermarks.high_watermark_ts
              THEN EXCLUDED.high_watermark_wa_msg_id
            ELSE whatsapp_sync_watermarks.high_watermark_wa_msg_id
          END,
          last_completed_window_start = EXCLUDED.last_completed_window_start,
          last_completed_window_end = EXCLUDED.last_completed_window_end,
          last_run_id = EXCLUDED.last_run_id,
          updated_at = NOW()
      `, [
        this.clientId,
        chatId,
        isGroup,
        highWatermarkTs,
        highWatermarkWaMsgId,
        this.run.window_start,
        this.run.window_end,
        this.run.id,
      ]);
      if (!completed.rowCount) return null;
      return client.query(`
        UPDATE whatsapp_sync_runs
        SET completed_chats = completed_chats + 1,
            heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [this.run.id]);
    });
    if (result?.rows?.[0]) this.run = result.rows[0];
    return this.run;
  }

  async finish(status, error = null) {
    const { rows } = await this.client.query(`
      UPDATE whatsapp_sync_runs
      SET status = $2, error = $3, heartbeat_at = NOW(),
          completed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [this.run.id, status, error ? String(error).slice(0, 2000) : null]);
    this.run = rows[0] || this.run;
    return this.run;
  }

  async release() {
    if (this.released) return;
    this.released = true;
    try {
      await this.client.query(
        'SELECT pg_advisory_unlock(hashtext($1))',
        [`${LOCK_PREFIX}${this.clientId}`]
      );
    } finally {
      this.client.release();
    }
  }
}

async function claimDurableSyncRun(pool, clientId, options) {
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [`${LOCK_PREFIX}${clientId}`]
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) throw runningError();

    await client.query('BEGIN');
    const { rows: resumableRows } = await client.query(`
      SELECT *
      FROM whatsapp_sync_runs
      WHERE client_id = $1
        AND status IN ('running','failed','interrupted')
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `, [clientId]);
    const resumable = resumableRows[0] || null;
    let run;
    if (options.resume && resumable) {
      const { rows } = await client.query(`
        UPDATE whatsapp_sync_runs
        SET status = 'running', trigger = $2, attempt = attempt + 1,
            error = NULL, completed_at = NULL, heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [resumable.id, options.trigger]);
      run = rows[0];
    } else {
      if (resumable?.status === 'running') {
        await client.query(`
          UPDATE whatsapp_sync_runs
          SET status = 'interrupted', error = 'superseded by a new non-resume run',
              completed_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [resumable.id]);
      }
      const { rows } = await client.query(`
        INSERT INTO whatsapp_sync_runs (
          client_id, trigger, status, window_start, window_end,
          lookback_days, overlap_minutes, msg_limit, page_size,
          chat_offset, chat_batch_size, download_media
        ) VALUES ($1,$2,'running',$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        clientId,
        options.trigger,
        options.windowStart,
        options.windowEnd,
        options.lookbackDays,
        options.overlapMinutes,
        options.msgLimit,
        options.pageSize,
        options.chatOffset,
        options.chatBatchSize,
        options.downloadMedia,
      ]);
      run = rows[0];
    }
    await client.query('COMMIT');
    return new DurableSyncLease(client, clientId, run);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${LOCK_PREFIX}${clientId}`]);
      } catch (_) {}
    }
    client.release();
    throw error;
  }
}

async function latestDurableSyncRun(pool, clientId) {
  if (!clientId) return null;
  const { rows } = await pool.query(`
    SELECT id, client_id, trigger, status, window_start, window_end,
           attempt, total_chats, completed_chats, saved_count,
           duplicate_count, failed_count, error, started_at,
           heartbeat_at, completed_at
    FROM whatsapp_sync_runs
    WHERE client_id = $1
    ORDER BY id DESC
    LIMIT 1
  `, [clientId]);
  return rows[0] || null;
}

module.exports = {
  DurableSyncLease,
  claimDurableSyncRun,
  latestDurableSyncRun,
  runningError,
};
