#!/usr/bin/env node
'use strict'

const cron       = require('node-cron')
const crypto     = require('node:crypto')
const db         = require('@secondbrain/db')
const { cleanupOrphanedRuns } = require('../shared/cleanup')

const discoverer = require('./services/discoverer')
const classifier = require('./services/classifier')
const analyzer   = require('./services/analyzer')
const { acquireRunLease } = require('../shared/run-lease')
let schemaReadiness = null

let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null
let _analysisPromise = null
let _shutdownPromise = null
const RUN_ONCE = process.argv.includes('--once')

console.log('🗂  Projects Agent v1.0')
console.log('📊 Discovers and tracks projects from WhatsApp, Email & Limitless\n')

// ── Schema bootstrap ───────────────────────────────────────────────────────────

async function ensureSchema() {
  if (schemaReadiness) return schemaReadiness
  const fs   = require('fs')
  const path = require('path')
  schemaReadiness = (async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
    await db.query(sql)
    console.log('✅ Schema ready')
  })()
  try {
    await schemaReadiness
  } catch (error) {
    schemaReadiness = null
    throw error
  }
}

// ── Upsert project by name ────────────────────────────────────────────────────

async function upsertProject(proj) {
  try {
    // Existing identity is explicit. Exact names provide idempotency only for
    // genuinely new candidates; similarity never merges project lifecycles.
    const { rows: existing } = await db.query(`
      SELECT id, name FROM projects.projects
      WHERE (id = $2::bigint OR ($2::bigint IS NULL AND LOWER(TRIM(name)) = LOWER(TRIM($1))))
        AND is_archived = FALSE
      LIMIT 1
    `, [proj.name, proj.existing_project_id || null])

    let matchId = existing[0]?.id

    if (matchId) {
      const id = matchId
      // Discovery refreshes lineage, not established project definitions.
      // Mutable model prose/tags would destabilize catalog identity and force
      // unnecessary full communication reclassification.
      await db.query(`
        UPDATE projects.projects SET
          discovery_evidence_refs = CASE WHEN jsonb_array_length($1::jsonb) > 0 THEN $1::jsonb ELSE discovery_evidence_refs END,
          discovery_version = COALESCE($2, discovery_version)
        WHERE id = $3
      `, [
        JSON.stringify(proj.evidence_refs || []),
        proj.discovery_version || null,
        id,
      ])
      return { id, isNew: false }
    }

    // Novel model suggestions are candidates, not immediate catalog truth.
    // Require recurrence and at least two independent canonical references.
    const candidateFingerprint = crypto.createHash('sha256')
      .update(proj.name.toLowerCase().replace(/\s+/g, ' ').trim())
      .digest('hex')
    const { rows: candidates } = await db.query(`
      INSERT INTO projects.project_candidates (
        candidate_fingerprint, proposed_name, payload, evidence_refs
      ) VALUES ($1, $2, $3::jsonb, $4::jsonb)
      ON CONFLICT (candidate_fingerprint) DO UPDATE SET
        proposed_name = EXCLUDED.proposed_name,
        payload = EXCLUDED.payload,
        evidence_refs = (
          SELECT COALESCE(jsonb_agg(ref ORDER BY ref), '[]'::jsonb)
          FROM (
            SELECT DISTINCT ref
            FROM jsonb_array_elements_text(
              projects.project_candidates.evidence_refs || EXCLUDED.evidence_refs
            ) ref
          ) merged
        ),
        occurrences = projects.project_candidates.occurrences + 1,
        last_seen_at = NOW()
      RETURNING occurrences, evidence_refs, status, admitted_project_id
    `, [candidateFingerprint, proj.name, JSON.stringify(proj), JSON.stringify(proj.evidence_refs || [])])
    const candidate = candidates[0]
    if (candidate.status !== 'admitted' && (
      Number(candidate.occurrences) < 2 || (candidate.evidence_refs || []).length < 2
    )) {
      return { id: null, isNew: false, pending: true }
    }

    // Insert a recurrent, independently evidenced candidate.
    const { rows: inserted } = await db.query(`
      INSERT INTO projects.projects
        (name, description, status, health, priority, tags, discovery_evidence_refs, discovery_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING id
    `, [
      proj.name,
      proj.description || null,
      proj.status      || 'active',
      proj.health      || 'unknown',
      proj.priority    || 'medium',
      proj.tags        || [],
      JSON.stringify(proj.evidence_refs || []),
      proj.discovery_version || null,
    ])
    await db.query(`
      UPDATE projects.project_candidates
      SET status = 'admitted', admitted_project_id = $2, last_seen_at = NOW()
      WHERE candidate_fingerprint = $1
    `, [candidateFingerprint, inserted[0].id])
    return { id: inserted[0].id, isNew: true }
  } catch (err) {
    console.error('[index] upsertProject error:', err.message)
    throw err
  }
}

async function recoverInterruptedRuns() {
  const { rows } = await db.query(`
    UPDATE projects.analysis_runs
    SET status = 'failed', completed_at = NOW(),
        error = COALESCE(error, 'Agent process was replaced before the run completed')
    WHERE status = 'running'
    RETURNING id
  `)
  if (rows.length > 0) console.log(`🧹 Recovered ${rows.length} interrupted analysis run(s)`)
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function getLastRunAt() {
  try {
    const { rows } = await db.query(`
      SELECT completed_at FROM projects.analysis_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `)
    return rows[0]?.completed_at || null
  } catch { return null }
}

async function runAnalysis() {
  const lease = await acquireRunLease(db, 207202602)
  if (!lease.acquired) {
    console.log('⏭  Another projects process owns the analysis lease')
    return { status: 'skipped' }
  }

  try {
  await ensureSchema()
  await recoverInterruptedRuns()

  let telemetryStatus = 'failed'
  let telemetryError = null

  if (telemetry) {
    _runId = await telemetry.startRun({ agentId: 'projects', workflowName: 'project_discovery' })
  }

  let runId           = null
  let projectsFound   = 0
  let commsClassified = 0

  try {
    // Get incremental watermark
    const lastRunAt = await getLastRunAt()
    if (lastRunAt) {
      console.log(`⏱  Incremental mode: only processing activity since ${lastRunAt.toISOString()}`)
    } else {
      console.log('🆕 First run: full analysis')
    }

    // Create run record
    const { rows } = await db.query(`
      INSERT INTO projects.analysis_runs (status) VALUES ('running')
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
    if (!rows.length) return { status: 'skipped' }
    runId = rows[0].id
    console.log(`\n🔍 Starting analysis run #${runId}`)

    // ── 1. Gather discovery data ───────────────────────────────────────────
    console.log('📡 Gathering communications data...')
    const data = await discoverer.gatherDiscoveryData()
    console.log(`   Canonical episodes: ${data.episodes.length}`)

    // ── 2. Discover projects via the configured reasoning model ───────────
    console.log('🤖 Discovering projects with the reasoning model...')
    const discoveredProjects = await discoverer.discoverProjects(data)
    console.log(`   Discovered ${discoveredProjects.length} projects`)

    // ── 3. Upsert projects into DB ─────────────────────────────────────────
    const projectsWithIds = []
    for (const proj of discoveredProjects) {
      if (!proj.name) continue
      const result = await upsertProject(proj)
      if (result.pending) {
        console.log(`   🧪 ${proj.name} (pending recurrent evidence)`)
        continue
      }
      projectsWithIds.push({
        ...proj,
        id: result.id,
        isNew: result.isNew,
      })
      projectsFound++
      console.log(`   ${result.isNew ? '✨' : '♻️'} ${proj.name} (${proj.status}, ${proj.priority})`)
    }

    // Update run count
    await db.query(`
      UPDATE projects.analysis_runs SET projects_found = $1 WHERE id = $2
    `, [projectsFound, runId])
    if (telemetry && _runId) {
      telemetry.progress(_runId, 'tasks_extracted', { completed: projectsFound })
    }

    // ── 4. Classify NEW communications only ───────────────────────────────
    const { rows: projectsForClassification } = await db.query(`
      SELECT id, name, description, tags AS keywords
      FROM projects.projects
      WHERE is_archived = FALSE
        AND status NOT IN ('completed')
      ORDER BY priority = 'high' DESC, updated_at DESC
    `)
    if (!projectsForClassification.length) throw new Error('No active outcome-bearing projects are available for classification')

    const sinceLabel = lastRunAt ? `since ${new Date(lastRunAt).toLocaleDateString()}` : 'all'

    console.log(`\n📧 Classifying emails (${sinceLabel})...`)
    const emailCount = await classifier.classifyEmails(projectsForClassification, lastRunAt)
    console.log(`   Classified ${emailCount} email communications`)
    commsClassified += emailCount

    console.log(`🎙  Classifying lifelogs (${sinceLabel})...`)
    const lifelogCount = await classifier.classifyLifelogs(projectsForClassification, lastRunAt)
    console.log(`   Classified ${lifelogCount} lifelog communications`)
    commsClassified += lifelogCount

    console.log(`💬 Classifying WhatsApp chats (${sinceLabel})...`)
    const waCount = await classifier.classifyWhatsAppChats(projectsForClassification, lastRunAt)
    console.log(`   Classified ${waCount} WhatsApp communications`)
    commsClassified += waCount
    if (telemetry && _runId) {
      telemetry.progress(_runId, 'projects_created', { completed: commsClassified })
    }

    // ── 5. Update comm_count and last_activity_at on each project ─────────
    console.log('\n📊 Updating project communication counts...')
    await db.query(`
      WITH current_stats AS (
        SELECT p.id AS project_id,
               COUNT(pc.id)::integer AS cnt,
               MAX(pc.occurred_at) AS latest
        FROM projects.projects p
        LEFT JOIN projects.project_communications pc ON pc.project_id = p.id
        GROUP BY p.id
      )
      UPDATE projects.projects p SET
        comm_count       = current_stats.cnt,
        last_activity_at = current_stats.latest,
        updated_at       = NOW()
      FROM current_stats
      WHERE p.id = current_stats.project_id
        AND (
          p.comm_count IS DISTINCT FROM current_stats.cnt
          OR p.last_activity_at IS DISTINCT FROM current_stats.latest
        )
    `)

    // ── 6. Re-analyze only projects that received new communications ───────
    console.log('\n🧠 Analyzing updated projects...')

    // On first run analyze all; on incremental runs only those with new comms
    let projectsToAnalyze
    if (!lastRunAt) {
      const { rows } = await db.query(`
        SELECT * FROM projects.projects
        WHERE is_archived = FALSE AND comm_count > 0
        ORDER BY last_activity_at DESC NULLS LAST
      `)
      projectsToAnalyze = rows
    } else {
      // Re-analyze changes to both links and classifications. Projects whose
      // final link was removed are included so stale insights can be closed.
      const { rows } = await db.query(`
        SELECT DISTINCT p.* FROM projects.projects p
        WHERE p.is_archived = FALSE
          AND (
            (p.comm_count > 0 AND p.ai_summary IS NULL)
            OR EXISTS (
              SELECT 1 FROM projects.project_communications pc
              WHERE pc.project_id = p.id
                AND COALESCE(pc.updated_at, pc.created_at) > $1
                AND pc.occurred_at > $1
            )
          )
        ORDER BY p.last_activity_at DESC NULLS LAST
      `, [lastRunAt])
      projectsToAnalyze = rows
    }

    console.log(`   ${projectsToAnalyze.length} projects to analyze`)
    const analysisErrors = []
    for (const project of projectsToAnalyze) {
      try {
        const comms = await analyzer.getProjectCommunications(project.id, 100)
        console.log(`   Analyzing "${project.name}" (${comms.length} comms)...`)
        await analyzer.analyzeProject(project, comms)
        await analyzer.sleep(3000)
      } catch (err) {
        console.error(`   ✗ Error analyzing "${project.name}":`, err.message)
        analysisErrors.push(`${project.id}:${err.message}`)
      }
    }

    if (analysisErrors.length) {
      throw new Error(`${analysisErrors.length} project analyses failed: ${analysisErrors.slice(0, 5).join('; ')}`)
    }

    // ── 7. Mark run complete ───────────────────────────────────────────────
    await db.query(`
      UPDATE projects.analysis_runs SET
        status           = 'completed',
        projects_found   = $1,
        comms_classified = $2,
        completed_at     = NOW()
      WHERE id = $3
    `, [projectsFound, commsClassified, runId])

    console.log(`\n✅ Analysis run #${runId} complete`)
    console.log(`   Projects found:      ${projectsFound}`)
    console.log(`   Comms classified:    ${commsClassified}\n`)
    telemetryStatus = 'completed'
    return { run_id: runId, projects_found: projectsFound, communications_classified: commsClassified }

  } catch (err) {
    telemetryError = err.message
    console.error('❌ Analysis run failed:', err.message)
    if (runId) {
      try {
        await db.query(`
          UPDATE projects.analysis_runs SET
            status = 'failed', error = $1, completed_at = NOW()
          WHERE id = $2
        `, [err.message, runId])
      } catch { /* ignore */ }
    }
    throw err
  } finally {
    const telemetryRunId = _runId
    _runId = null
    if (telemetry && telemetryRunId) {
      try {
        await telemetry.endRun(telemetryRunId, {
          status: telemetryStatus,
          error: telemetryError,
          projectsFound,
          communicationsClassified: commsClassified,
        })
        await telemetry.flush()
      } catch (error) {
        console.warn('[telemetry] endRun failed:', error.message)
      }
    }
  }
  } finally {
    await lease.release()
  }
}

async function startAnalysis() {
  if (_analysisPromise) {
    console.log('⏭  Analysis already active in this process, skipping')
    return _analysisPromise
  }
  _analysisPromise = runAnalysis()
  try {
    return await _analysisPromise
  } finally {
    _analysisPromise = null
  }
}

// ── Schedule & start ──────────────────────────────────────────────────────────

async function main() {
  await ensureSchema()
  await cleanupOrphanedRuns(db, 'projects')

  // Run immediately on startup
  console.log('🏁 Starting initial analysis...\n')
  await startAnalysis()

  if (RUN_ONCE) {
    await db.end()
    console.log('✅ One-shot projects analysis complete')
    return
  }

  // Then every 12 hours
  console.log('⏰ Scheduling analysis every 12 hours')
  cron.schedule('0 */12 * * *', () => {
    console.log('⏰ Scheduled analysis triggered')
    startAnalysis().catch(err => console.error('❌ Scheduled analysis error:', err.message))
  })
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Fatal startup error:', err.message)
    process.exit(1)
  })
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

async function shutdown() {
  if (_shutdownPromise) return _shutdownPromise
  _shutdownPromise = (async () => {
    console.log('\n🛑 Graceful shutdown requested...')
    if (_analysisPromise) await _analysisPromise.catch(() => {})
    if (telemetry) await telemetry.flush().catch(() => {})
    try {
      await db.end()
      console.log('✅ Database closed')
    } catch { /* ignore */ }
    console.log('👋 Projects Agent stopped')
  })()
  await _shutdownPromise
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

module.exports = {
  ensureSchema,
  main,
  recoverInterruptedRuns,
  runAnalysis,
  startAnalysis,
  upsertProject,
}
