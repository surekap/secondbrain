'use strict'

const llm = require('../../shared/llm')
const db        = require('@secondbrain/db')

function parseJSON(text) {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(clean)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Analyze a single project and generate a status report with insights.
 * Updates project record and inserts insights into DB.
 */
async function analyzeProject(project, communications) {
  if (!project) return

  const commList = communications.slice(0, 50).map(c => {
    const date = c.occurred_at ? new Date(c.occurred_at).toLocaleDateString() : 'unknown'
    const source = c.source === 'email' ? '📧' : c.source === 'whatsapp' ? '💬' : '🎙'
    const subject = c.subject ? ` [${c.subject}]` : ''
    return `  [${date}] ${source}${subject}: ${(c.content_snippet || '').slice(0, 200)}`
  }).join('\n')

  // Include any manually-confirmed facts as ground truth for Claude
  const overrides = project.manual_overrides || {}
  const overrideKeys = Object.keys(overrides)
  const overrideContext = overrideKeys.length > 0
    ? `\nUser-confirmed facts (treat as ground truth, do not contradict):\n${overrideKeys.map(k => `- ${k}: ${JSON.stringify(overrides[k].value)}`).join('\n')}\n`
    : ''

  const prompt = `You are analyzing a project from this person's communications. Be specific — name actual people, companies, amounts, and dates from the communications. Do not use vague language.

Project: ${project.name}${project.description ? ` — ${project.description}` : ''}
${overrideContext}Communications (newest first):
${commList || '(no communications found)'}

Return JSON:
{
  "status": "active|stalled|completed|on_hold|unknown",
  "health": "on_track|at_risk|blocked|unknown",
  "ai_summary": "2-3 sentence summary naming specific developments, people, or decisions from the communications",
  "next_action": "Specific next step — name actual people/entities and what they need to do",
  "insights": [
    {"insight_type": "opportunity|risk|blocker|decision|next_action|status", "content": "Specific insight naming entities, amounts, or dates from the communications", "priority": "high|medium|low"}
  ]
}

Rules:
- "on_track" = active progress with no blockers. "at_risk" = delays, unresolved issues, or inaction despite active topic. "blocked" = something actively preventing progress.
- insight_type guide: "opportunity" = actionable upside or deal to pursue, "risk" = something that could go wrong, "blocker" = preventing progress now, "decision" = a choice pending, "next_action" = concrete step needed, "status" = current state
- For investment/financial projects: name the specific companies, funds, or deals discussed; include amounts if mentioned; note whether follow-up has occurred
- For operational projects: name the specific system, vendor, or person causing the issue
- Prioritize "high" only for time-sensitive or high financial/operational impact items
- Generate 3-5 insights. Specific always beats generic.
- If there are no communications, set health=unknown, status=unknown, ai_summary to null, insights to []`

  try {
    const response = await llm.create('projects', {
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.text || ''
    const result = parseJSON(text)

    // Update project — skip any fields the user has manually overridden
    await db.query(`
      UPDATE projects.projects SET
        status      = CASE WHEN manual_overrides ? 'status'      THEN status      ELSE $1 END,
        health      = CASE WHEN manual_overrides ? 'health'      THEN health      ELSE $2 END,
        ai_summary  = $3,
        next_action = CASE WHEN manual_overrides ? 'next_action' THEN next_action ELSE $4 END,
        updated_at  = NOW()
      WHERE id = $5
    `, [
      result.status  || project.status  || 'unknown',
      result.health  || project.health  || 'unknown',
      result.ai_summary  || null,
      result.next_action || null,
      project.id,
    ])

    // Insert insights (only new ones — clear old unresolved ones first)
    if (Array.isArray(result.insights) && result.insights.length > 0) {
      // Delete old unresolved insights for this project to avoid stale accumulation
      await db.query(`
        DELETE FROM projects.project_insights
        WHERE project_id = $1 AND is_resolved = FALSE
      `, [project.id])

      for (const insight of result.insights.slice(0, 5)) {
        try {
          await db.query(`
            INSERT INTO projects.project_insights (project_id, insight_type, content, priority)
            VALUES ($1, $2, $3, $4)
          `, [
            project.id,
            insight.insight_type || 'status',
            insight.content      || '',
            insight.priority     || 'medium',
          ])
        } catch (err) {
          // ignore
        }
      }
    }

    return result
  } catch (err) {
    console.error(`[analyzer] analyzeProject error for "${project.name}":`, err.message)
    return null
  }
}

/**
 * Load recent communications for a project from DB.
 */
async function getProjectCommunications(projectId, limit) {
  limit = limit || 50
  try {
    const { rows } = await db.query(`
      SELECT source, source_id, content_snippet, subject, occurred_at, relevance_score
      FROM projects.project_communications
      WHERE project_id = $1
      ORDER BY occurred_at DESC NULLS LAST
      LIMIT $2
    `, [projectId, limit])
    return rows
  } catch (err) {
    console.error('[analyzer] getProjectCommunications error:', err.message)
    return []
  }
}

module.exports = { analyzeProject, getProjectCommunications, sleep }
