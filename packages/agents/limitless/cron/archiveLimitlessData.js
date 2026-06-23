require("dotenv").config({ path: require("path").resolve(__dirname, "../../../../.env.local") });
const crypto = require("crypto");
const pool = require("@secondbrain/db");
const { getLifelogs, getChats, downloadAudioRange } = require("../services/limitless");

function toApiDate(date) {
  return date.toISOString().slice(0, 10);
}

function toDatetimeStr(value) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

function parseDateInput(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: "${value}"`);
  }
  return parsed;
}

function parseAudioSources() {
  const raw = process.env.ARCHIVE_AUDIO_SOURCES || "auto,pendant";
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function ensureArchiveTables() {
  const conn = await pool.connect();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS limitless_chats (
        id VARCHAR(255) PRIMARY KEY,
        summary TEXT,
        visibility VARCHAR(64),
        created_at TIMESTAMP NULL,
        started_at TIMESTAMP NULL,
        is_scheduled BOOLEAN NULL,
        raw_json JSONB,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_limitless_chats_started_at ON limitless_chats(started_at)`);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_limitless_chats_is_scheduled ON limitless_chats(is_scheduled)`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS limitless_chat_messages (
        id VARCHAR(255) PRIMARY KEY,
        chat_id VARCHAR(255) NOT NULL,
        message_index INTEGER NOT NULL,
        role VARCHAR(64),
        user_name VARCHAR(255),
        message_text TEXT,
        created_at TIMESTAMP NULL,
        raw_json JSONB,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (chat_id, message_index),
        CONSTRAINT fk_limitless_chat_messages_chat
          FOREIGN KEY (chat_id) REFERENCES limitless_chats(id) ON DELETE CASCADE
      )
    `);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_limitless_chat_messages_chat_id ON limitless_chat_messages(chat_id)`);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_limitless_chat_messages_created_at ON limitless_chat_messages(created_at)`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS limitless_reminders (
        chat_id VARCHAR(255) PRIMARY KEY,
        title TEXT,
        created_at TIMESTAMP NULL,
        started_at TIMESTAMP NULL,
        source VARCHAR(64) NOT NULL DEFAULT 'scheduled_chat',
        raw_json JSONB,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_limitless_reminders_chat
          FOREIGN KEY (chat_id) REFERENCES limitless_chats(id) ON DELETE CASCADE
      )
    `);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_limitless_reminders_started_at ON limitless_reminders(started_at)`);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS limitless_audio_blobs (
        id BIGSERIAL PRIMARY KEY,
        lifelog_id VARCHAR(255) NOT NULL,
        audio_source VARCHAR(32) NOT NULL DEFAULT 'auto',
        start_ms BIGINT NOT NULL,
        end_ms BIGINT NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('downloaded', 'no_audio', 'error')),
        mime_type VARCHAR(128) NULL,
        byte_length INTEGER NULL,
        sha256 CHAR(64) NULL,
        audio_blob BYTEA NULL,
        error_message TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_limitless_audio_lifelog
          FOREIGN KEY (lifelog_id) REFERENCES lifelogs(id) ON DELETE CASCADE
      )
    `);

    const { rows: newIndex } = await conn.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'limitless_audio_blobs' AND indexname = 'uq_limitless_audio_segment_source'`
    );
    if (newIndex.length === 0) {
      await conn.query(
        `ALTER TABLE limitless_audio_blobs
         ADD CONSTRAINT uq_limitless_audio_segment_source UNIQUE (lifelog_id, start_ms, end_ms, audio_source)`
      );
    }

    const { rows: lifelogIndex } = await conn.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'limitless_audio_blobs' AND indexname = 'idx_limitless_audio_lifelog_id'`
    );
    if (lifelogIndex.length === 0) {
      await conn.query(
        `CREATE INDEX idx_limitless_audio_lifelog_id ON limitless_audio_blobs (lifelog_id)`
      );
    }

    const { rows: statusIndex } = await conn.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'limitless_audio_blobs' AND indexname = 'idx_limitless_audio_status'`
    );
    if (statusIndex.length === 0) {
      await conn.query(
        `CREATE INDEX idx_limitless_audio_status ON limitless_audio_blobs (status)`
      );
    }

    const { rows: startTimeIndex } = await conn.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'limitless_audio_blobs' AND indexname = 'idx_limitless_audio_start_time'`
    );
    if (startTimeIndex.length === 0) {
      await conn.query(
        `CREATE INDEX idx_limitless_audio_start_time ON limitless_audio_blobs (start_time)`
      );
    }

    const { rows: oldIndex } = await conn.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'limitless_audio_blobs' AND indexname = 'uq_limitless_audio_lifelog_source'`
    );
    if (oldIndex.length > 0) {
      await conn.query(`DROP INDEX IF EXISTS uq_limitless_audio_lifelog_source`);
    }
  } finally {
    conn.release();
  }
}

async function saveLifelogsToDB(logs) {
  const conn = await pool.connect();
  try {
    for (const log of logs) {
      const startValue = log.startTime || log.start_time || log.start;
      const endValue = log.endTime || log.end_time || log.end;
      const startTime = startValue ? toDatetimeStr(startValue) : null;
      const endTime = endValue ? toDatetimeStr(endValue) : null;
      const contents = log.contents ?? "";

      await conn.query(
        `INSERT INTO limitless.lifelogs (id, title, start_time, end_time, contents, markdown) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           contents = EXCLUDED.contents,
           markdown = EXCLUDED.markdown`,
        [
          log.id,
          log.title,
          startTime,
          endTime,
          JSON.stringify(contents),
          log.markdown || "",
        ]
      );
    }
  } finally {
    conn.release();
  }
}

async function getMinKnownLifelogStart() {
  const conn = await pool.connect();
  try {
    const { rows } = await conn.query(
      `SELECT MIN(start_time) AS min_start_time FROM limitless.lifelogs`
    );
    return rows[0]?.min_start_time ? new Date(rows[0].min_start_time) : null;
  } finally {
    conn.release();
  }
}

async function syncLifelogs({ startDate, endDate, timezone, windowDays }) {
  const apiKey = process.env.LIMITLESS_API_KEY;
  let totalFetched = 0;
  let totalSaved = 0;
  let windowStart = new Date(startDate);

  while (windowStart <= endDate) {
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + Math.max(1, windowDays) - 1);
    if (windowEnd > endDate) {
      windowEnd.setTime(endDate.getTime());
    }

    const apiStart = toApiDate(windowStart);
    const apiEnd = toApiDate(windowEnd);
    console.log(`[lifelogs] Fetching window ${apiStart} -> ${apiEnd}`);

    const lifelogs = await getLifelogs({
      apiKey,
      start: apiStart,
      end: apiEnd,
      timezone,
      direction: "asc",
      limit: null,
    });

    totalFetched += lifelogs.length;
    if (lifelogs.length > 0) {
      await saveLifelogsToDB(lifelogs);
      totalSaved += lifelogs.length;
    }

    windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() + 1);
  }

  return { totalFetched, totalSaved };
}

async function upsertChat(conn, chat, isScheduled) {
  await conn.query(
    `INSERT INTO limitless_chats (
      id, summary, visibility, created_at, started_at, is_scheduled, raw_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      summary = EXCLUDED.summary,
      visibility = EXCLUDED.visibility,
      created_at = EXCLUDED.created_at,
      started_at = EXCLUDED.started_at,
      is_scheduled = CASE
        WHEN EXCLUDED.is_scheduled = TRUE THEN TRUE
        WHEN limitless_chats.is_scheduled IS NULL THEN EXCLUDED.is_scheduled
        ELSE limitless_chats.is_scheduled
      END,
      raw_json = EXCLUDED.raw_json,
      synced_at = CURRENT_TIMESTAMP`,
    [
      chat.id,
      chat.summary || null,
      chat.visibility || null,
      chat.createdAt ? toDatetimeStr(chat.createdAt) : null,
      chat.startedAt ? toDatetimeStr(chat.startedAt) : null,
      typeof isScheduled === "boolean" ? isScheduled : null,
      JSON.stringify(chat),
    ]
  );
}

async function upsertMessages(conn, chat) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  let inserted = 0;
  for (let idx = 0; idx < messages.length; idx += 1) {
    const message = messages[idx];
    const messageId = message.id || `${chat.id}:${idx}`;
    await conn.query(
      `INSERT INTO limitless_chat_messages (
        id, chat_id, message_index, role, user_name, message_text, created_at, raw_json
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        user_name = EXCLUDED.user_name,
        message_text = EXCLUDED.message_text,
        created_at = EXCLUDED.created_at,
        raw_json = EXCLUDED.raw_json,
        synced_at = CURRENT_TIMESTAMP`,
      [
        messageId,
        chat.id,
        idx,
        message.user?.role || message.role || null,
        message.user?.name || null,
        message.text || null,
        message.createdAt ? toDatetimeStr(message.createdAt) : null,
        JSON.stringify(message),
      ]
    );
    inserted += 1;
  }
  return inserted;
}

async function upsertReminder(conn, chat) {
  await conn.query(
    `INSERT INTO limitless_reminders (
      chat_id, title, created_at, started_at, source, raw_json
    ) VALUES ($1, $2, $3, $4, 'scheduled_chat', $5)
    ON CONFLICT (chat_id) DO UPDATE SET
      title = EXCLUDED.title,
      created_at = EXCLUDED.created_at,
      started_at = EXCLUDED.started_at,
      raw_json = EXCLUDED.raw_json,
      synced_at = CURRENT_TIMESTAMP`,
    [
      chat.id,
      chat.summary || null,
      chat.createdAt ? toDatetimeStr(chat.createdAt) : null,
      chat.startedAt ? toDatetimeStr(chat.startedAt) : null,
      JSON.stringify(chat),
    ]
  );
}

async function syncChats() {
  const apiKey = process.env.LIMITLESS_API_KEY;
  const conn = await pool.connect();
  let totalChats = 0;
  let totalMessages = 0;
  let totalReminders = 0;

  try {
    const pulls = [
      { label: "regular", isScheduled: false },
      { label: "scheduled", isScheduled: true },
    ];

    for (const pull of pulls) {
      console.log(`[chats] Fetching ${pull.label} chats...`);
      const chats = await getChats({
        apiKey,
        isScheduled: pull.isScheduled,
        direction: "desc",
        limit: null,
      });
      console.log(`[chats] Retrieved ${chats.length} ${pull.label} chats`);

      for (const chat of chats) {
        await upsertChat(conn, chat, pull.isScheduled);
        totalChats += 1;
        totalMessages += await upsertMessages(conn, chat);
        if (pull.isScheduled) {
          await upsertReminder(conn, chat);
          totalReminders += 1;
        }
      }
    }
  } finally {
    conn.release();
  }

  return { totalChats, totalMessages, totalReminders };
}

function hashBytes(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function upsertAudioBlob(conn, row) {
  await conn.query(
    `INSERT INTO limitless_audio_blobs (
      lifelog_id, audio_source, start_ms, end_ms, start_time, end_time,
      status, mime_type, byte_length, sha256, audio_blob, error_message
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (lifelog_id, start_ms, end_ms, audio_source) DO UPDATE SET
      status = CASE WHEN limitless_audio_blobs.status = 'downloaded' THEN limitless_audio_blobs.status ELSE EXCLUDED.status END,
      mime_type = CASE WHEN limitless_audio_blobs.status = 'downloaded' THEN limitless_audio_blobs.mime_type ELSE EXCLUDED.mime_type END,
      byte_length = CASE WHEN limitless_audio_blobs.status = 'downloaded' THEN limitless_audio_blobs.byte_length ELSE EXCLUDED.byte_length END,
      sha256 = CASE WHEN limitless_audio_blobs.status = 'downloaded' THEN limitless_audio_blobs.sha256 ELSE EXCLUDED.sha256 END,
      audio_blob = CASE WHEN limitless_audio_blobs.status = 'downloaded' THEN limitless_audio_blobs.audio_blob ELSE EXCLUDED.audio_blob END,
      error_message = EXCLUDED.error_message,
      updated_at = CURRENT_TIMESTAMP`,
    [
      row.lifelogId,
      row.audioSource,
      row.startMs,
      row.endMs,
      row.startTime,
      row.endTime,
      row.status,
      row.mimeType,
      row.byteLength,
      row.sha256,
      row.audioBlob,
      row.errorMessage,
    ]
  );
}

async function getLifelogRangesForAudio(startDate, endDate) {
  const conn = await pool.connect();
  try {
    const { rows } = await conn.query(
      `SELECT id, start_time, end_time
       FROM limitless.lifelogs
       WHERE start_time IS NOT NULL
         AND end_time IS NOT NULL
         AND start_time >= $1
         AND start_time <= $2
       ORDER BY start_time ASC`,
      [toDatetimeStr(startDate), toDatetimeStr(endDate)]
    );
    return rows;
  } finally {
    conn.release();
  }
}

async function syncAudio({ startDate, endDate, audioSources }) {
  const apiKey = process.env.LIMITLESS_API_KEY;
  const audioTimeoutMs = parseInt(process.env.ARCHIVE_AUDIO_TIMEOUT_MS || "30000", 10);
  const audioRetries = parseInt(process.env.ARCHIVE_AUDIO_RETRIES || "1", 10);
  const audioRetryDelayMs = parseInt(
    process.env.ARCHIVE_AUDIO_RETRY_DELAY_MS || "750",
    10
  );
  const progressEvery = parseInt(process.env.ARCHIVE_AUDIO_PROGRESS_EVERY || "25", 10);
  const conn = await pool.connect();
  let downloaded = 0;
  let noAudio = 0;
  let errors = 0;
  let processed = 0;
  let skipped = 0;

  try {
    const lifelogRanges = await getLifelogRangesForAudio(startDate, endDate);
    const maxAudioWindowMs = 2 * 60 * 60 * 1000;
    const segments = [];
    for (const range of lifelogRanges) {
      const originalStartMs = new Date(range.start_time).getTime();
      const originalEndMs = new Date(range.end_time).getTime();
      if (
        !Number.isFinite(originalStartMs) ||
        !Number.isFinite(originalEndMs) ||
        originalEndMs <= originalStartMs
      ) {
        continue;
      }

      let segmentStartMs = originalStartMs;
      while (segmentStartMs < originalEndMs) {
        const segmentEndMs = Math.min(
          originalEndMs,
          segmentStartMs + maxAudioWindowMs
        );
        segments.push({
          lifelogId: range.id,
          startMs: segmentStartMs,
          endMs: segmentEndMs,
        });
        segmentStartMs = segmentEndMs + 1;
      }
    }

    const { rows: existingRows } = await conn.query(
      `SELECT lifelog_id, start_ms, end_ms, audio_source, status
       FROM limitless_audio_blobs
       WHERE status IN ('downloaded', 'no_audio')`
    );
    const existing = new Map(
      existingRows.map((row) => [
        `${row.lifelog_id}:${row.start_ms}:${row.end_ms}:${row.audio_source}`,
        row.status,
      ])
    );
    console.log(
      `[audio] Checking ${lifelogRanges.length} lifelog ranges (${segments.length} audio segments)`
    );

    for (const segment of segments) {
      for (const source of audioSources) {
        const key = `${segment.lifelogId}:${segment.startMs}:${segment.endMs}:${source}`;
        if (existing.has(key)) {
          skipped += 1;
          continue;
        }

        try {
          const result = await downloadAudioRange({
            apiKey,
            startMs: segment.startMs,
            endMs: segment.endMs,
            audioSource: source,
            timeoutMs: audioTimeoutMs,
            requestRetries: audioRetries,
            retryDelayMs: audioRetryDelayMs,
          });

          if (result.status === "downloaded") {
            downloaded += 1;
            await upsertAudioBlob(conn, {
              lifelogId: segment.lifelogId,
              audioSource: source,
              startMs: segment.startMs,
              endMs: segment.endMs,
              startTime: toDatetimeStr(new Date(segment.startMs)),
              endTime: toDatetimeStr(new Date(segment.endMs)),
              status: "downloaded",
              mimeType: result.mimeType,
              byteLength: result.byteLength,
              sha256: hashBytes(result.buffer),
              audioBlob: result.buffer,
              errorMessage: null,
            });
          } else {
            noAudio += 1;
            await upsertAudioBlob(conn, {
              lifelogId: segment.lifelogId,
              audioSource: source,
              startMs: segment.startMs,
              endMs: segment.endMs,
              startTime: toDatetimeStr(new Date(segment.startMs)),
              endTime: toDatetimeStr(new Date(segment.endMs)),
              status: "no_audio",
              mimeType: null,
              byteLength: 0,
              sha256: null,
              audioBlob: null,
              errorMessage: null,
            });
          }
        } catch (error) {
          errors += 1;
          await upsertAudioBlob(conn, {
            lifelogId: segment.lifelogId,
            audioSource: source,
            startMs: segment.startMs,
            endMs: segment.endMs,
            startTime: toDatetimeStr(new Date(segment.startMs)),
            endTime: toDatetimeStr(new Date(segment.endMs)),
            status: "error",
            mimeType: null,
            byteLength: null,
            sha256: null,
            audioBlob: null,
            errorMessage: error.message.slice(0, 4096),
          });
        }
      }

      processed += 1;
      if (processed % Math.max(1, progressEvery) === 0) {
        console.log(
          `[audio] Processed ${processed}/${segments.length} segments (${downloaded} downloaded, ${noAudio} no-audio, ${errors} errors, ${skipped} skipped)`
        );
      }
    }
  } finally {
    conn.release();
  }

  return { downloaded, noAudio, errors, processed, skipped };
}

async function run() {
  const timezone = process.env.LIMITLESS_TIMEZONE || "UTC";
  const lifelogWindowDays = parseInt(process.env.FETCH_WINDOW_DAYS || "30", 10);
  const skipLifelogs = process.env.ARCHIVE_SKIP_LIFELOGS === "1";
  const skipChats = process.env.ARCHIVE_SKIP_CHATS === "1";
  const skipAudio = process.env.ARCHIVE_SKIP_AUDIO === "1";
  const endDate = process.env.ARCHIVE_END_DATE
    ? parseDateInput(process.env.ARCHIVE_END_DATE, "ARCHIVE_END_DATE")
    : new Date();

  const minKnownStart = await getMinKnownLifelogStart();
  const startDate = process.env.ARCHIVE_START_DATE
    ? parseDateInput(process.env.ARCHIVE_START_DATE, "ARCHIVE_START_DATE")
    : minKnownStart || new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (startDate > endDate) {
    throw new Error("ARCHIVE_START_DATE is after ARCHIVE_END_DATE");
  }

  const audioSources = parseAudioSources();
  console.log(
    `Archive sync range: ${toApiDate(startDate)} -> ${toApiDate(endDate)} (${timezone}), audio sources: ${audioSources.join(", ")}`
  );

  await ensureArchiveTables();

  const summary = {};
  if (!skipLifelogs) {
    summary.lifelogs = await syncLifelogs({
      startDate,
      endDate,
      timezone,
      windowDays: lifelogWindowDays,
    });
  }
  if (!skipChats) {
    summary.chats = await syncChats();
  }
  if (!skipAudio) {
    summary.audio = await syncAudio({ startDate, endDate, audioSources });
  }

  console.log("Archive sync complete:");
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(async (error) => {
      console.error("Archive sync failed:", error);
      try {
        await pool.end();
      } catch (endError) {
        console.error("Failed to close pool:", endError);
      }
      process.exit(1);
    });
}

module.exports = { run };
