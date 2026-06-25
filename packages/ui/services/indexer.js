'use strict';

/**
 * Background indexer — runs periodically, finds unembedded content from all sources,
 * generates embeddings via the configured provider, and upserts into search.embeddings.
 *
 * Sources:
 *   email          → email.emails
 *   lifelog        → limitless.lifelogs
 *   whatsapp       → public.messages
 *   contact        → relationships.contacts
 *   insight        → relationships.insights
 *   project        → projects.projects
 *   project_insight→ projects.project_insights
 */

const { embedBatch, toSql, getEmbeddingConfig } = require('./embedder');

let telemetry = null;
try { telemetry = require('@secondbrain/telemetry'); } catch (_) {}
if (telemetry) telemetry.init('indexer');

const INTERVAL_MS   = 10 * 60 * 1000; // 10 minutes
const BATCH_PER_RUN = 200;            // max items per source per run

let _db  = null;
let _tid = null;

// ── Status tracking ───────────────────────────────────────────────────────────

const _status = {
  running:      false,
  lastRunAt:    null,
  lastRunCount: null,
  lastRunError: null,
  nextRunAt:    null,
  startedAt:    null,
};

function getStatus() {
  return {
    running:      _status.running,
    lastRunAt:    _status.lastRunAt?.toISOString() ?? null,
    lastRunCount: _status.lastRunCount,
    lastRunError: _status.lastRunError,
    nextRunAt:    _status.nextRunAt?.toISOString() ?? null,
    startedAt:    _status.startedAt?.toISOString() ?? null,
    intervalMs:   INTERVAL_MS,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch all unindexed rows, embed them in one batch call, then upsert.
 * rows:       array of DB rows
 * toContent:  row → string to embed
 * toSourceId: row → string source_id
 * toMeta:     row → metadata object
 * source:     string source name
 */
async function indexSource(source, rows, toContent, toSourceId, toMeta, embeddingModel) {
  if (!rows.length) return 0;

  const contents  = rows.map(r => toContent(r).slice(0, 2000));
  const nonEmpty  = contents.map((c, i) => ({ i, c, row: rows[i] })).filter(x => x.c.trim());
  if (!nonEmpty.length) return 0;

  const { embeddings: vecs } = await embedBatch(nonEmpty.map(x => x.c));

  for (let j = 0; j < nonEmpty.length; j++) {
    const { c, row } = nonEmpty[j];
    await _db.query(`
      INSERT INTO search.embeddings (source, source_id, content, embedding, metadata, embedding_model)
      VALUES ($1, $2, $3, $4::public.vector, $5, $6)
      ON CONFLICT (source, source_id, embedding_model) DO UPDATE
        SET content    = EXCLUDED.content,
            embedding  = EXCLUDED.embedding,
            metadata   = EXCLUDED.metadata,
            indexed_at = NOW()
    `, [source, String(toSourceId(row)), c, toSql(vecs[j]), JSON.stringify(toMeta(row)), embeddingModel]);
  }

  return nonEmpty.length;
}

// ── Source indexers ───────────────────────────────────────────────────────────

async function indexEmails(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT e.id, e.subject, e.from_address, e.date,
             LEFT(e.body_text, 800) AS body
      FROM email.emails e
      WHERE NOT EXISTS (
        SELECT 1 FROM search.embeddings s
        WHERE s.source = 'email' AND s.source_id = e.id::text
          AND s.embedding_model = $1
      )
      ORDER BY e.date DESC
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('email', rows,
      r => [r.subject, r.body].filter(Boolean).join('\n'),
      r => r.id,
      r => ({ subject: r.subject, from_address: r.from_address, date: r.date }),
      embeddingModel,
    );
  } catch (e) {
    const msg = e.message || String(e);
    if (!msg.includes('does not exist')) {
      const hint = msg.includes('spending cap') || msg.includes('429') ? ' [Gemini spending cap]' : '';
      console.warn('[indexer] email:', msg + hint);
      _status.lastRunError = msg + hint;
    }
    return 0;
  }
}

async function indexLifelogs(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT l.id, l.title, l.start_time,
             LEFT(COALESCE(l.markdown, l.contents, ''), 800) AS body
      FROM limitless.lifelogs l
      WHERE NOT EXISTS (
        SELECT 1 FROM search.embeddings s
        WHERE s.source = 'lifelog' AND s.source_id = l.id::text
          AND s.embedding_model = $1
      )
      ORDER BY l.start_time DESC NULLS LAST
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('lifelog', rows,
      r => [r.title, r.body].filter(Boolean).join('\n'),
      r => r.id,
      r => ({ title: r.title, start_time: r.start_time }),
      embeddingModel,
    );
  } catch (e) {
    if (!e.message.includes('does not exist')) console.warn('[indexer] lifelog:', e.message);
    return 0;
  }
}

async function indexWhatsApp(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT
        chat_id,
        ts,
        EXTRACT(EPOCH FROM ts)::bigint AS epoch,
        (data->'id'->>'fromMe')::boolean          AS from_me,
        data->>'body'                              AS body,
        data->'_data'->>'notifyName'               AS notify_name
      FROM public.messages
      WHERE event IN ('message', 'message_create', 'message_historical')
        AND msg_type = 'chat'
        AND data->>'body' IS NOT NULL
        AND LENGTH(data->>'body') > 8
        AND NOT EXISTS (
          SELECT 1 FROM search.embeddings s
          WHERE s.source = 'whatsapp'
            AND s.source_id = chat_id || '::' || EXTRACT(EPOCH FROM ts)::bigint::text
            AND s.embedding_model = $1
        )
      ORDER BY ts DESC
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('whatsapp', rows,
      r => r.body.trim(),
      r => `${r.chat_id}::${r.epoch}`,
      r => ({ chat_id: r.chat_id, from_me: r.from_me, notify_name: r.notify_name, ts: r.ts }),
      embeddingModel,
    );
  } catch (e) {
    if (!e.message.includes('does not exist')) console.warn('[indexer] whatsapp:', e.message);
    return 0;
  }
}

async function indexContacts(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT c.id, c.display_name, c.company, c.job_title,
             c.relationship_type, c.summary
      FROM relationships.contacts c
      WHERE NOT c.is_noise
        AND NOT EXISTS (
          SELECT 1 FROM search.embeddings s
          WHERE s.source = 'contact' AND s.source_id = c.id::text
            AND s.embedding_model = $1
        )
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('contact', rows,
      r => [
        r.display_name,
        r.company && r.job_title ? `${r.job_title} at ${r.company}` : (r.company || r.job_title),
        r.summary,
      ].filter(Boolean).join('\n'),
      r => r.id,
      r => ({ display_name: r.display_name, company: r.company, relationship_type: r.relationship_type }),
      embeddingModel,
    );
  } catch (e) {
    if (!e.message.includes('does not exist')) console.warn('[indexer] contacts:', e.message);
    return 0;
  }
}

async function indexInsights(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT i.id, i.insight_type, i.title, i.description,
             i.priority, i.created_at,
             c.display_name AS contact_name
      FROM relationships.insights i
      LEFT JOIN relationships.contacts c ON c.id = i.contact_id
      WHERE NOT EXISTS (
        SELECT 1 FROM search.embeddings s
        WHERE s.source = 'insight' AND s.source_id = i.id::text
          AND s.embedding_model = $1
      )
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('insight', rows,
      r => [r.title, r.description].filter(Boolean).join('\n'),
      r => r.id,
      r => ({ title: r.title, insight_type: r.insight_type, priority: r.priority, contact_name: r.contact_name, created_at: r.created_at }),
      embeddingModel,
    );
  } catch (e) {
    if (!e.message.includes('does not exist')) console.warn('[indexer] insights:', e.message);
    return 0;
  }
}

async function indexProjects(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT p.id, p.name, p.description, p.status, p.health,
             LEFT(p.ai_summary, 500) AS ai_summary, p.last_activity_at
      FROM projects.projects p
      WHERE NOT p.is_archived
        AND NOT EXISTS (
          SELECT 1 FROM search.embeddings s
          WHERE s.source = 'project' AND s.source_id = p.id::text
            AND s.embedding_model = $1
        )
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('project', rows,
      r => [r.name, r.description, r.ai_summary].filter(Boolean).join('\n'),
      r => r.id,
      r => ({ name: r.name, status: r.status, health: r.health, last_activity_at: r.last_activity_at }),
      embeddingModel,
    );
  } catch (e) {
    if (!e.message.includes('does not exist')) console.warn('[indexer] projects:', e.message);
    return 0;
  }
}

async function indexProjectInsights(embeddingModel) {
  try {
    const { rows } = await _db.query(`
      SELECT pi.id, pi.insight_type, pi.content, pi.priority, pi.created_at,
             p.name AS project_name
      FROM projects.project_insights pi
      JOIN projects.projects p ON p.id = pi.project_id
      WHERE NOT pi.is_resolved
        AND NOT EXISTS (
          SELECT 1 FROM search.embeddings s
          WHERE s.source = 'project_insight' AND s.source_id = pi.id::text
            AND s.embedding_model = $1
        )
      LIMIT $2
    `, [embeddingModel, BATCH_PER_RUN]);
    return await indexSource('project_insight', rows,
      r => r.content || '',
      r => r.id,
      r => ({ insight_type: r.insight_type, priority: r.priority, project_name: r.project_name, created_at: r.created_at }),
      embeddingModel,
    );
  } catch (e) {
    if (!e.message.includes('does not exist')) console.warn('[indexer] project_insights:', e.message);
    return 0;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runOnce() {
  if (_status.running) return;
  _status.running = true;

  const runId = telemetry ? await telemetry.startRun({ agentId: 'indexer', workflowName: 'embedding_indexer' }) : null;
  let total = 0;

  try {
    const { model: embeddingModel, providerType } = await getEmbeddingConfig();
    const jobs = [
      ['email',           () => indexEmails(embeddingModel)],
      ['lifelog',         () => indexLifelogs(embeddingModel)],
      ['whatsapp',        () => indexWhatsApp(embeddingModel)],
      ['contact',         () => indexContacts(embeddingModel)],
      ['insight',         () => indexInsights(embeddingModel)],
      ['project',         () => indexProjects(embeddingModel)],
      ['project_insight', () => indexProjectInsights(embeddingModel)],
    ];
    for (const [source, job] of jobs) {
      const count = await job();
      total += count;
      if (runId && count > 0) telemetry.progress(runId, `embedded_${source}`, { completed: count });
    }
    if (runId && total > 0) telemetry.progress(runId, 'total_embedded', { completed: total });
  } catch (err) {
    const hint = err.message?.includes('spending cap') || err.message?.includes('429')
      ? ' (Gemini spending cap exceeded — check billing at console.cloud.google.com)'
      : '';
    console.warn(`[indexer] Run failed:`, err.message + hint);
    _status.lastRunError = err.message + hint;
  } finally {
    _status.running = false;
    _status.lastRunAt = new Date();
    _status.lastRunCount = total;
    if (runId) await telemetry.endRun(runId, { status: 'completed' });
  }

  if (total > 0) { console.log(`[indexer] Indexed ${total} new items`); _status.lastRunError = null; }
  else           console.log(`[indexer] Run complete — nothing new to index`);
}

function start(db) {
  if (_tid) return;
  _db = db;
  _status.startedAt = new Date();

  setTimeout(async () => {
    await runOnce();
    _status.nextRunAt = new Date(Date.now() + INTERVAL_MS);
    _tid = setInterval(() => {
      _status.nextRunAt = new Date(Date.now() + INTERVAL_MS);
      runOnce();
    }, INTERVAL_MS);
  }, 15_000);

  _status.nextRunAt = new Date(Date.now() + 15_000);
  console.log('[indexer] Started (runs every 10 min; first pass in 15 s)');
}

function stop() {
  clearInterval(_tid);
  _tid = null;
  _status.nextRunAt = null;
}

async function getPendingCounts(embeddingModel) {
  if (!_db) return [];
  try {
    const { rows } = await _db.query(`
      SELECT source, total, indexed, (total - indexed) AS pending FROM (
        SELECT 'email'           AS source,
          (SELECT COUNT(*) FROM email.emails)::int                                           AS total,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='email'        AND embedding_model=$1)::int AS indexed
        UNION ALL
        SELECT 'whatsapp',
          (SELECT COUNT(*) FROM public.messages
           WHERE event IN ('message','message_create','message_historical')
             AND msg_type='chat' AND data->>'body' IS NOT NULL AND LENGTH(data->>'body')>8)::int,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='whatsapp'     AND embedding_model=$1)::int
        UNION ALL
        SELECT 'lifelog',
          (SELECT COUNT(*) FROM limitless.lifelogs)::int,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='lifelog'      AND embedding_model=$1)::int
        UNION ALL
        SELECT 'contact',
          (SELECT COUNT(*) FROM relationships.contacts WHERE NOT is_noise)::int,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='contact'      AND embedding_model=$1)::int
        UNION ALL
        SELECT 'insight',
          (SELECT COUNT(*) FROM relationships.insights)::int,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='insight'      AND embedding_model=$1)::int
        UNION ALL
        SELECT 'project',
          (SELECT COUNT(*) FROM projects.projects WHERE NOT is_archived)::int,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='project'      AND embedding_model=$1)::int
        UNION ALL
        SELECT 'project_insight',
          (SELECT COUNT(*) FROM projects.project_insights WHERE NOT is_resolved)::int,
          (SELECT COUNT(*) FROM search.embeddings WHERE source='project_insight' AND embedding_model=$1)::int
      ) t
    `, [embeddingModel]);
    return rows;
  } catch (e) {
    return [];
  }
}

module.exports = { start, stop, runOnce, getStatus, getPendingCounts, BATCH_PER_RUN };
