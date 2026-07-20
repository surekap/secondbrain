'use strict'

const defaultSource = require('./extractor')
const defaultStore = require('./communication')
const { runLidOwnershipCorrection } = require('./lid-ownership-correction')
const { canonicalWhatsAppChatIdSql } = require('../../shared/whatsapp-chat')

function emptyStage(cursor) {
  return {
    cursor,
    pages: 0,
    read: 0,
    inserted: 0,
    updated: 0,
    unresolved: 0,
    linked: 0,
    fallback_ids: 0,
    skipped: 0,
    semantic_media_rows: 0,
    done: false,
  }
}

function initialStats(previous = {}) {
  return {
    email: { ...emptyStage(0), ...(previous.email || {}) },
    whatsapp: { ...emptyStage(0), ...(previous.whatsapp || {}) },
    limitless: { ...emptyStage(''), ...(previous.limitless || {}) },
  }
}

function addResult(stage, result = {}) {
  for (const key of ['inserted', 'updated', 'unresolved', 'linked', 'fallback_ids', 'skipped']) {
    stage[key] += Number(result[key] || 0)
  }
}

async function checkpoint(client, runId, stats, pagesProcessed) {
  await client.query(`
    UPDATE relationships.communication_recovery_runs
    SET stats = $2::jsonb, pages_processed = $3, updated_at = NOW()
    WHERE id = $1
  `, [runId, JSON.stringify(stats), pagesProcessed])
}

async function loadResumeStats(client) {
  const { rows } = await client.query(`
    SELECT id, status, stats
    FROM relationships.communication_recovery_runs
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `)
  const latest = rows[0] || null
  return latest && ['failed', 'partial'].includes(latest.status) ? latest : null
}

async function processEmail(client, source, store, stage, pageSize, onPage) {
  while (!stage.done) {
    const rows = await source.getEmailRecoveryPage(stage.cursor, pageSize)
    if (!rows.length) {
      stage.done = true
      break
    }
    const previousCursor = stage.cursor
    const result = await store.upsertEmailCommunications(client, rows)
    stage.cursor = Number(rows[rows.length - 1].source_row_id)
    if (!(stage.cursor > Number(previousCursor))) throw new Error('email recovery cursor did not advance')
    stage.pages++
    stage.read += rows.length
    addResult(stage, result)
    await onPage('email', stage)
  }
}

async function processWhatsApp(client, source, store, stage, pageSize, onPage) {
  while (!stage.done) {
    const rows = await source.getWhatsAppRecoveryPage(stage.cursor, pageSize)
    if (!rows.length) {
      stage.done = true
      break
    }
    const previousCursor = stage.cursor
    const direct = rows.filter(row => !row.is_group)
    const groups = rows.filter(row => row.is_group)
    const directResult = await store.upsertDirectCommunications(client, direct)
    const groupResult = await store.upsertGroupCommunications(client, groups)
    stage.cursor = Number(rows[rows.length - 1].source_row_id)
    if (!(stage.cursor > Number(previousCursor))) throw new Error('WhatsApp recovery cursor did not advance')
    stage.pages++
    stage.read += rows.length
    stage.semantic_media_rows += rows.filter(row => row.semantic_text || row.extracted_text).length
    addResult(stage, directResult)
    addResult(stage, groupResult)
    await onPage('whatsapp', stage)
  }
}

async function processLimitless(client, source, store, stage, pageSize, onPage) {
  while (!stage.done) {
    const rows = await source.getLimitlessRecoveryPage(stage.cursor, pageSize)
    if (!rows.length) {
      stage.done = true
      break
    }
    const previousCursor = String(stage.cursor || '')
    const result = await store.upsertLimitlessCommunications(client, rows)
    stage.cursor = String(rows[rows.length - 1].source_row_id)
    if (stage.cursor <= previousCursor) throw new Error('Limitless recovery cursor did not advance')
    stage.pages++
    stage.read += rows.length
    addResult(stage, result)
    await onPage('limitless', stage)
  }
}

async function validateCanonicalParticipantLinks(client, options = {}) {
  const selfJid = options.selfJid || defaultSource.MY_WA_JID
  const chatSql = canonicalWhatsAppChatIdSql({
    dataExpression: 'm.data',
    storedChatExpression: 'm.chat_id',
    selfExpression: '$1',
  })
  const nativeIdSql = `COALESCE(NULLIF(m.wa_msg_id, ''), NULLIF(m.data->'id'->>'_serialized', ''))`
  const { rows } = await client.query(`
    WITH eligible_whatsapp AS (
      SELECT DISTINCT ON (${nativeIdSql})
             ${nativeIdSql} AS wa_msg_id,
             chat.chat_id,
             (chat.chat_id LIKE '%@g.us') AS is_group
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
      WHERE m.event IN ('message', 'message_create', 'message_historical')
        AND ${nativeIdSql} IS NOT NULL
        AND chat.chat_id IS NOT NULL
      ORDER BY ${nativeIdSql}, m.id DESC
    ), expected AS (
      SELECT c.id AS communication_id, ci.contact_id AS expected_contact_id
      FROM relationships.communications c
      JOIN eligible_whatsapp m
        ON c.source = 'whatsapp'
       AND c.source_id = 'wa:' || m.wa_msg_id
       AND c.is_group = m.is_group
      JOIN relationships.contact_identities ci
        ON ci.source = 'whatsapp'
       AND ci.identity_type = 'wa_jid'
       AND ci.identity_value = CASE
             WHEN c.is_group THEN c.metadata->>'author_jid'
             ELSE m.chat_id
           END
       AND ci.identity_value ~ '^([1-9][0-9]{6,14}@c\\.us|[1-9][0-9]{6,20}@lid)$'
       AND ci.is_active = TRUE
      UNION ALL
      SELECT c.id, ci.contact_id
      FROM relationships.communications c
      JOIN email.emails e ON c.source = 'email' AND c.source_id = 'email:' || e.id::text
      JOIN relationships.email_senders sender ON sender.raw_address = e.from_address
      JOIN relationships.contact_identities ci
        ON ci.source = 'email'
       AND ci.identity_type = 'email'
       AND ci.identity_value = LOWER(sender.parsed_email)
       AND ci.is_active = TRUE
    )
    SELECT COUNT(*) FILTER (
             WHERE communication.contact_id IS DISTINCT FROM expected.expected_contact_id
           )::int AS mismatches,
           COUNT(*)::int AS validated
    FROM expected
    JOIN relationships.communications communication ON communication.id = expected.communication_id
  `, [selfJid])
  return {
    mismatches: Number(rows[0]?.mismatches || 0),
    validated: Number(rows[0]?.validated || 0),
  }
}

async function runCommunicationRecovery(pool, options = {}) {
  const pageSize = Math.min(Math.max(Number(options.pageSize || 1000), 1), 5000)
  const source = options.source || defaultSource
  const store = options.store || defaultStore
  const correctLidOwnership = options.correctLidOwnership || runLidOwnershipCorrection
  const log = typeof options.log === 'function' ? options.log : () => {}
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  let locked = false
  let runId = null
  let pagesProcessed = 0

  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext('relationships.communication_recovery')) AS locked`)
    locked = lock.rows[0]?.locked !== false
    if (!locked) throw new Error('another communication recovery is already running')

    // Correct only versioned, derived ownership before replaying immutable
    // source rows. This prevents old name-only links from influencing the
    // recovery pass and makes NULL/stale participant correction auditable.
    const lidOwnershipCorrection = await correctLidOwnership(client)
    const resumed = options.resume === false ? null : await loadResumeStats(client)
    const stats = initialStats(resumed?.stats || {})
    stats.lid_ownership_correction = lidOwnershipCorrection
    // Completed stages remain complete when resuming; a fresh run starts all at
    // zero and scans every raw row, which also refreshes analyzed media text.
    const { rows: runs } = await client.query(`
      INSERT INTO relationships.communication_recovery_runs (status, page_size, stats)
      VALUES ('running', $1, $2::jsonb)
      RETURNING id
    `, [pageSize, JSON.stringify({ ...stats, resumed_from_run_id: resumed?.id || null })])
    runId = runs[0].id

    const onPage = async (stageName, stage) => {
      pagesProcessed++
      await checkpoint(client, runId, stats, pagesProcessed)
      log({ run_id: runId, stage: stageName, page: stage.pages, cursor: stage.cursor, read: stage.read })
    }

    await processEmail(client, source, store, stats.email, pageSize, onPage)
    await processWhatsApp(client, source, store, stats.whatsapp, pageSize, onPage)
    await processLimitless(client, source, store, stats.limitless, pageSize, onPage)
    const participantValidation = await validateCanonicalParticipantLinks(client)
    if (participantValidation.mismatches > 0) {
      throw new Error(`${participantValidation.mismatches} canonical communications still disagree with active source identities`)
    }
    stats.participant_validation = participantValidation

    await client.query(`
      UPDATE relationships.communication_recovery_runs
      SET status = 'completed', stats = $2::jsonb, pages_processed = $3,
          updated_at = NOW(), completed_at = NOW()
      WHERE id = $1
    `, [runId, JSON.stringify(stats), pagesProcessed])
    return { run_id: runId, status: 'completed', page_size: pageSize, pages_processed: pagesProcessed, stats }
  } catch (err) {
    if (runId) {
      await client.query(`
        UPDATE relationships.communication_recovery_runs
        SET status = 'failed', error = $2, updated_at = NOW(), completed_at = NOW()
        WHERE id = $1
      `, [runId, err.message]).catch(() => {})
    }
    throw err
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtext('relationships.communication_recovery'))`).catch(() => {})
    }
    if (client !== pool && typeof client.release === 'function') client.release()
  }
}

module.exports = {
  initialStats,
  loadResumeStats,
  validateCanonicalParticipantLinks,
  runCommunicationRecovery,
}
