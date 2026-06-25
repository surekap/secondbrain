#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const cron       = require('node-cron')
const db         = require('@secondbrain/db')

const discoverer = require('./services/discoverer')
const classifier = require('./services/classifier')
const analyzer   = require('./services/analyzer')

let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null

console.log('🗂  Projects Agent v1.0')
console.log('📊 Discovers and tracks projects from WhatsApp, Email & Limitless\n')

// ── Schema bootstrap ───────────────────────────────────────────────────────────

async function ensureSchema() {
  const fs   = require('fs')
  const path = require('path')
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
    await db.query(sql)
    console.log('✅ Schema ready')
  } catch (err) {
    console.error('❌ Schema setup error:', err.message)
  }
}

// ── Upsert project by name ────────────────────────────────────────────────────

function nameWords(name) {
  return new Set(
    (name || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !['and','the','for','with','from','this','that'].includes(w))
  )
}

function wordOverlap(a, b) {
  const wa = nameWords(a)
  const wb = nameWords(b)
  if (!wa.size || !wb.size) return 0
  let common = 0
  for (const w of wa) if (wb.has(w)) common++
  return common / Math.min(wa.size, wb.size)
}

async function upsertProject(proj) {
  try {
    // First try exact case-insensitive match
    const { rows: existing } = await db.query(`
      SELECT id, name FROM projects.projects
      WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
        AND is_archived = FALSE
      LIMIT 1
    `, [proj.name])

    // Fall back to fuzzy word-overlap match (>= 70% of shorter name's words match)
    let matchId = existing[0]?.id
    if (!matchId) {
      const { rows: allProjs } = await db.query(`
        SELECT id, name FROM projects.projects WHERE is_archived = FALSE
      `)
      const fuzzy = allProjs.find(p => wordOverlap(p.name, proj.name) >= 0.70)
      if (fuzzy) {
        console.log(`   🔀 Fuzzy match: "${proj.name}" → "${fuzzy.name}"`)
        matchId = fuzzy.id
      }
    }

    if (matchId) {
      const id = matchId
      // On re-discovery, update description/tags — but respect manual overrides
      await db.query(`
        UPDATE projects.projects SET
          description = CASE WHEN manual_overrides ? 'description' THEN description ELSE COALESCE($1, description) END,
          tags        = CASE WHEN manual_overrides ? 'tags' THEN tags
                             WHEN array_length($2::text[], 1) > 0 THEN $2::text[]
                             ELSE tags END,
          updated_at  = NOW()
        WHERE id = $3
      `, [
        proj.description || null,
        proj.tags        || [],
        id,
      ])
      return { id, isNew: false }
    }

    // Insert new
    const { rows: inserted } = await db.query(`
      INSERT INTO projects.projects
        (name, description, status, health, priority, tags)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [
      proj.name,
      proj.description || null,
      proj.status      || 'active',
      proj.health      || 'unknown',
      proj.priority    || 'medium',
      proj.tags        || [],
    ])
    return { id: inserted[0].id, isNew: true }
  } catch (err) {
    console.error('[index] upsertProject error:', err.message)
    return null
  }
}

// ── Check if analysis is running ──────────────────────────────────────────────

async function cleanupStaleRuns() {
  try {
    const { rows } = await db.query(`
      UPDATE projects.analysis_runs
      SET status = 'failed', completed_at = NOW(), error = 'Agent crashed or was restarted'
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '3 hours'
      RETURNING id
    `)
    if (rows.length > 0) {
      console.log(`🧹 Cleaned up ${rows.length} stale analysis run(s)`)
    }
  } catch { /* ignore */ }
}

async function isAnalysisRunning() {
  try {
    const { rows } = await db.query(`
      SELECT id FROM projects.analysis_runs
      WHERE status = 'running'
        AND started_at > NOW() - INTERVAL '3 hours'
      LIMIT 1
    `)
    return rows.length > 0
  } catch { return false }
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
  await cleanupStaleRuns()
  const alreadyRunning = await isAnalysisRunning()
  if (alreadyRunning) {
    console.log('⏭  Analysis already running, skipping')
    return
  }

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
      INSERT INTO projects.analysis_runs (status) VALUES ('running') RETURNING id
    `)
    runId = rows[0].id
    console.log(`\n🔍 Starting analysis run #${runId}`)

    // ── 1. Gather discovery data ───────────────────────────────────────────
    console.log('📡 Gathering communications data...')
    const data = await discoverer.gatherDiscoveryData()
    console.log(`   Email subjects: ${data.emailSubjects.length}, Lifelogs: ${data.lifelogTitles.length}, WhatsApp chats: ${data.whatsappChats.length}`)

    // ── 2. Discover projects via Claude ───────────────────────────────────
    console.log('🤖 Discovering projects with Claude...')
    const discoveredProjects = await discoverer.discoverProjects(data)
    console.log(`   Discovered ${discoveredProjects.length} projects`)

    if (!discoveredProjects.length) {
      throw new Error('No projects discovered — check data sources')
    }

    // ── 3. Upsert projects into DB ─────────────────────────────────────────
    const projectsWithIds = []
    for (const proj of discoveredProjects) {
      if (!proj.name) continue
      const result = await upsertProject(proj)
      if (!result) continue

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
    const projectsForClassification = projectsWithIds.map(p => ({
      id:       p.id,
      name:     p.name,
      keywords: p.keywords || [],
    }))

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
      UPDATE projects.projects p SET
        comm_count       = sub.cnt,
        last_activity_at = sub.latest,
        updated_at       = NOW()
      FROM (
        SELECT project_id, COUNT(*) AS cnt, MAX(occurred_at) AS latest
        FROM projects.project_communications
        GROUP BY project_id
      ) sub
      WHERE p.id = sub.project_id
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
      // Re-analyze projects that got new comms since lastRunAt OR have comms but no ai_summary yet
      const { rows } = await db.query(`
        SELECT DISTINCT p.* FROM projects.projects p
        WHERE p.is_archived = FALSE
          AND p.comm_count > 0
          AND (
            p.ai_summary IS NULL
            OR EXISTS (
              SELECT 1 FROM projects.project_communications pc
              WHERE pc.project_id = p.id AND pc.created_at > $1
            )
          )
        ORDER BY p.last_activity_at DESC NULLS LAST
      `, [lastRunAt])
      projectsToAnalyze = rows
    }

    console.log(`   ${projectsToAnalyze.length} projects to analyze`)
    for (const project of projectsToAnalyze) {
      try {
        const comms = await analyzer.getProjectCommunications(project.id, 30)
        console.log(`   Analyzing "${project.name}" (${comms.length} comms)...`)
        await analyzer.analyzeProject(project, comms)
        await analyzer.sleep(3000)
      } catch (err) {
        console.error(`   ✗ Error analyzing "${project.name}":`, err.message)
      }
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

  } catch (err) {
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
  }
}

// ── Schedule & start ──────────────────────────────────────────────────────────

async function main() {
  await ensureSchema()

  // Run immediately on startup
  console.log('🏁 Starting initial analysis...\n')
  await runAnalysis()

  // Then every 12 hours
  console.log('⏰ Scheduling analysis every 12 hours')
  cron.schedule('0 */12 * * *', () => {
    console.log('⏰ Scheduled analysis triggered')
    runAnalysis().catch(err => console.error('❌ Scheduled analysis error:', err.message))
  })
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err.message)
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

process.on('SIGINT', async () => {
  console.log('\n🛑 Graceful shutdown...')
  if (telemetry && _runId) {
    await telemetry.flush()
    await telemetry.endRun(_runId, { status: 'completed' })
  }
  try {
    await db.end()
    console.log('✅ Database closed')
  } catch { /* ignore */ }
  console.log('👋 Projects Agent stopped')
  process.exit(0)
})
