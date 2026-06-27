# Data Retention & Cleanup Strategy

> Written: 2026-06-27 | Based on actual DB measurements taken at ~4.5 GB total

## Current State

| Schema | Size | Rows / Notes |
|---|---|---|
| email | **2,513 MB** | 37,078 emails; body_html alone ~3 GB uncompressed (TOAST) |
| public (WhatsApp) | **964 MB** | 187,100 messages; raw `data` JSONB ~461 MB uncompressed |
| limitless | **621 MB** | 1,832 audio blobs = 562 MB stored directly in Postgres |
| search (pgvector) | **322 MB** | 65,536 embeddings @ 3072 dims |
| intelligence | 64 MB | Small; keep all |
| telemetry | 29 MB | Rolling logs; prune aggressively |
| relationships | 16 MB | Keep all |
| projects / ai / system | < 10 MB | Keep all |

The top three schemas (email, WhatsApp, limitless) account for **~90% of total usage** and are where all meaningful cleanup opportunity lives.

---

## Schema-by-Schema Plan

### 1. Email — 2,513 MB ⚠️ Biggest win available

**Root cause:** `body_html` is the primary offender. Emails store both the full HTML source (can be 100s of KB each for newsletters) and plain text. HTML is only useful for rendering in a browser; the intelligence pipeline reads `body_text`.

**Also:** 57% of emails (21,082 rows) are older than 1 year. 48% (17,982) are older than 2 years.

#### Actions

**Phase 1 — Strip HTML bodies (immediate, high impact)**

```sql
-- Null out body_html for all emails. body_text is the authoritative content for search/AI.
-- Estimated reclaim: ~2 GB after VACUUM FULL.
UPDATE email.emails SET body_html = NULL WHERE body_html IS NOT NULL;
VACUUM FULL email.emails;
```

Consider keeping body_html only for emails < 30 days old, or skipping it at ingest time entirely by nulling it in `parseEmail()` before saving.

**Phase 2 — Drop raw_headers for old emails (183 MB)**

`raw_headers` is a JSONB dump of every MIME header. After 90 days it has no operational value.

```sql
UPDATE email.emails SET raw_headers = NULL WHERE date < NOW() - INTERVAL '90 days';
VACUUM FULL email.emails;
```

**Phase 3 — Delete emails older than 2 years**

17,982 emails pre-date 2024. Unless there's a specific reason to keep them, delete the oldest tier:

```sql
DELETE FROM email.emails WHERE date < NOW() - INTERVAL '2 years';
-- Also cascade-clean search.embeddings for these deleted rows.
DELETE FROM search.embeddings WHERE source = 'email'
  AND source_id NOT IN (SELECT id::text FROM email.emails);
VACUUM FULL email.emails;
```

**Phase 4 — Prevent recurrence at ingest**

In `fetchEmails.js` → `parseEmail()`:
- Set `body_html = null` before saving (never write it to DB)
- Set `raw_headers = null` after 90 days (or just don't store it for new emails)

**Projected savings: ~2.2–2.4 GB** (HTML strip alone recovers ~2 GB)

---

### 2. WhatsApp — 964 MB

**Root cause:** The `data` column stores the full raw `wwebjs` message object as JSONB (~461 MB uncompressed). This includes internal wwebjs state, media keys, serialisation artefacts — almost none of which the intelligence pipeline uses. The useful fields (`body`, `from`, `to`, `timestamp`, `type`) are already extracted into dedicated columns.

**Also:** 22,707 system/notification messages (`e2e_notification`, `gp2`, `notification_template`, `ciphertext`, `initial_pHash_mismatch`, `pinned_message`) are noise for intelligence purposes.

#### Actions

**Phase 1 — Slim the `data` JSONB (immediate)**

Keep only the fields actually used downstream: `body`, `from`, `to`, `id`, `timestamp`, `type`, `isGroup`, `author`, `hasMedia`, `caption`.

```sql
UPDATE public.messages
SET data = jsonb_build_object(
  'body',      data->>'body',
  'from',      data->>'from',
  'to',        data->>'to',
  'id',        data->'id',
  'timestamp', data->>'timestamp',
  'type',      data->>'type',
  'isGroup',   data->'isGroup',
  'author',    data->>'author',
  'hasMedia',  data->'hasMedia',
  'caption',   data->>'caption'
)
WHERE data IS NOT NULL;
VACUUM FULL public.messages;
```

**Phase 2 — Delete pure system/notification messages**

These are group membership changes, encryption notifications, etc. They have no conversational value.

```sql
DELETE FROM public.messages
WHERE msg_type IN ('e2e_notification', 'gp2', 'notification_template',
                   'initial_pHash_mismatch', 'ciphertext', 'pinned_message');
-- ~22,707 rows
```

**Phase 3 — Time-based rolling window**

WhatsApp is high-volume. Define a retention window (suggested: 18 months) after which messages are dropped unless from a contact in `relationships.contacts` with `relationship_strength >= 3`.

**Phase 4 — Null data for old messages**

After 90 days, the `data` JSONB has no additional value over the extracted columns.

```sql
UPDATE public.messages SET data = NULL WHERE ts < NOW() - INTERVAL '90 days';
VACUUM FULL public.messages;
```

**Projected savings: ~400–600 MB**

---

### 3. Limitless Audio Blobs — 584 MB ⚠️ Easy win

**Root cause:** `limitless.limitless_audio_blobs` stores raw audio binary in Postgres. All 1,832 blobs are older than 3 months. The text transcripts and AI summaries live in `limitless.lifelogs` (only 27 MB). The audio binary serves no purpose once transcription is complete.

#### Actions

**Phase 1 — Delete all processed audio blobs (immediate)**

```sql
-- Safe: only delete blobs where transcription status is 'done' or equivalent.
-- Verify the status column values first:
SELECT DISTINCT status FROM limitless.limitless_audio_blobs;

-- Then delete processed ones:
DELETE FROM limitless.limitless_audio_blobs WHERE status = 'done';
-- Or if all are safe to delete:
DELETE FROM limitless.limitless_audio_blobs;
VACUUM FULL limitless.limitless_audio_blobs;
```

**Phase 2 — Prevent re-accumulation**

Modify the Limitless agent to delete the blob row immediately after successful transcription rather than leaving it in the DB.

**Projected savings: ~560 MB** (the full blob table)

---

### 4. Search / pgvector — 322 MB

**Root cause:** 65,536 embeddings @ 3072 dimensions. Embeddings are purely derivative — they can be regenerated from source data. The risk is orphaned embeddings pointing to deleted source rows.

#### Actions

**Phase 1 — Orphan cleanup (safe, run regularly)**

```sql
-- Delete embeddings whose source rows no longer exist.
DELETE FROM search.embeddings e
WHERE source = 'email'
  AND NOT EXISTS (SELECT 1 FROM email.emails WHERE id::text = e.source_id);

DELETE FROM search.embeddings e
WHERE source = 'whatsapp'
  AND NOT EXISTS (SELECT 1 FROM public.messages WHERE id::text = e.source_id);

DELETE FROM search.embeddings e
WHERE source IN ('contact', 'insight', 'lifelog', 'project', 'project_insight')
  AND NOT EXISTS (
    SELECT 1 FROM relationships.contacts WHERE id::text = e.source_id
    UNION ALL
    SELECT 1 FROM limitless.lifelogs WHERE id::text = e.source_id
  );
```

**Phase 2 — Reduce embedding dimensions**

Currently using `gemini-embedding-2-preview` at 3072 dims. Consider switching to 768 dims (task_retrieval_document truncation) — 4× smaller vectors, ~80 MB instead of 322 MB, with modest quality tradeoff for short-text retrieval.

**Phase 3 — Don't embed noise**

Stop embedding WhatsApp system messages (`e2e_notification`, `gp2`, etc.) and emails older than 2 years. These inflate the index without improving recall.

**Projected savings: ~150–200 MB** (orphans + system message embeddings)

---

### 5. Telemetry — 29 MB (low priority)

Small but grows indefinitely. Prune on a rolling window.

```sql
-- Keep 30 days of agent runs and LLM request logs.
DELETE FROM telemetry.agent_runs WHERE started_at < NOW() - INTERVAL '30 days';
DELETE FROM telemetry.llm_requests WHERE created_at < NOW() - INTERVAL '30 days';
DELETE FROM telemetry.llm_request_samples WHERE created_at < NOW() - INTERVAL '30 days';
DELETE FROM telemetry.system_samples WHERE sampled_at < NOW() - INTERVAL '7 days';
VACUUM telemetry.agent_runs, telemetry.llm_requests, telemetry.llm_request_samples, telemetry.system_samples;
```

Add this as a nightly cron in the server.

---

## Execution Order (prioritised by impact/effort)

| Priority | Action | Est. Savings | Risk | Effort |
|---|---|---|---|---|
| 🔴 1 | Strip `email.body_html` | ~2,000 MB | None — body_text is the source of truth | Low (one UPDATE) |
| 🔴 2 | Delete `limitless_audio_blobs` | ~560 MB | None once transcribed | Low (one DELETE) |
| 🟡 3 | Slim WhatsApp `data` JSONB | ~400 MB | Low — verify fields used downstream first | Medium |
| 🟡 4 | Delete WhatsApp system messages | ~50 MB | Low — noise not used by intelligence | Low |
| 🟡 5 | Drop `email.raw_headers` > 90 days | ~150 MB | None | Low |
| 🟢 6 | Orphan-clean `search.embeddings` | ~100 MB | None | Low |
| 🟢 7 | Delete emails > 2 years | ~500 MB | Medium — verify no active intelligence refs | Medium |
| 🟢 8 | Telemetry rolling purge | ~20 MB | None | Low (add cron) |
| ⚪ 9 | Reduce embedding dimensions | ~240 MB | Requires re-indexing all documents | High |

**Total potential reclaim if all actions taken: ~3.5–4 GB** (reducing total DB from 4.5 GB to ~1 GB)

---

## Ongoing Prevention

1. **Never store `body_html` at ingest** — modify `parseEmail()` to null it before saving.
2. **Auto-delete audio blobs** after Limitless transcription completes.
3. **Null WhatsApp `data`** for messages older than 90 days via a nightly job.
4. **Nightly telemetry purge** — rolling 30-day window on agent_runs and LLM logs.
5. **Orphan embedding sweep** — run weekly after any bulk delete.
6. **VACUUM schedule** — add `VACUUM ANALYZE` to the nightly cron; Postgres won't reclaim dead tuple space automatically after bulk deletes without it.

---

## Safety Notes

- Always run `VACUUM FULL` after bulk deletes to actually reclaim disk space (regular `VACUUM` marks space as reusable but doesn't shrink the file).
- `VACUUM FULL` takes an exclusive lock — run during off-peak hours.
- For the email body_html strip, confirm first that no part of the UI renders `body_html` in a way that would break (search results page uses `body_text`).
- Before deleting emails > 2 years, verify `relationships.communications` doesn't have FK references to `email.emails.id` that would cascade-delete relationship data you want to keep.
