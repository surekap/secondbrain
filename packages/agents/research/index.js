#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const cron      = require('node-cron')
const Anthropic = require('@anthropic-ai/sdk')
const db        = require('@secondbrain/db')

const tavily        = require('./providers/tavily')
const openaiProv    = require('./providers/openai')
const pdl           = require('./providers/peopledatalabs')
const serpapiProv   = require('./providers/serpapi')

const MODEL = 'claude-sonnet-4-6'

let anthropic = null
function getAnthropic() {
  if (!anthropic) anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
  return anthropic
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log('🔬 Research Agent v1.0')
console.log('📡 Enriches contacts via Tavily, OpenAI, PDL, SerpAPI\n')

// ── Find stale contacts ────────────────────────────────────────────────────────

async function findStaleContacts(limit = 20) {
  const { rows } = await db.query(`
    SELECT c.id, c.display_name, c.job_title, c.company, c.emails, c.relationship_strength
    FROM relationships.contacts c
    WHERE c.is_noise = false
      AND c.relationship_strength IN ('strong', 'moderate')
      AND (
        NOT EXISTS (
          SELECT 1 FROM relationships.contact_research r WHERE r.contact_id = c.id
        )
        OR EXISTS (
          SELECT 1 FROM relationships.contact_research r
          WHERE r.contact_id = c.id
          GROUP BY r.contact_id
          HAVING MAX(r.researched_at) < NOW() - INTERVAL '7 days'
        )
        OR EXISTS (
          SELECT 1 FROM relationships.contact_research r
          WHERE r.contact_id = c.id
            AND r.researched_name IS DISTINCT FROM c.display_name
        )
      )
    ORDER BY c.last_interaction_at DESC NULLS LAST
    LIMIT $1
  `, [limit])
  return rows
}

// ── Synthesise dossier with Claude ────────────────────────────────────────────

async function synthesiseDossier(contact, providerResults) {
  const parts = providerResults
    .filter(r => r.status === 'fulfilled' && r.value?.summary)
    .map(r => r.value.summary)

  if (parts.length === 0) return null

  const combined = parts.join('\n\n---\n\n').slice(0, 6000)

  const prompt = `Based on the following research from multiple sources, write a concise professional dossier paragraph (4-6 sentences) about ${contact.display_name}.

Focus on: who they are professionally, their current role, reputation, recent news, and anything particularly notable.
Be factual. Flag uncertainty with "reportedly" or "according to". Do not invent information.

Research sources:
${combined}

Write ONLY the dossier paragraph, no preamble.`

  try {
    const response = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })
    return response.content?.[0]?.text?.trim() || null
  } catch (err) {
    console.error('[research] synthesis error:', err.message)
    return null
  }
}

// ── Run research for one contact ───────────────────────────────────────────────

async function researchContact(contact) {
  console.log(`  🔍 Researching ${contact.display_name}…`)

  const providers = [
    { name: 'tavily',         fn: () => tavily.researchContact(contact) },
    { name: 'openai',         fn: () => openaiProv.researchContact(contact) },
    { name: 'peopledatalabs', fn: () => pdl.researchContact(contact) },
    { name: 'serpapi',        fn: () => serpapiProv.researchContact(contact) },
  ]

  const keyMap = {
    tavily:         'TAVILY_API_KEY',
    openai:         'OPENAI_API_KEY',
    peopledatalabs: 'PEOPLEDATALABS_API_KEY',
    serpapi:        'SERPAPI_API_KEY',
  }

  const activeProviders = providers.filter(p => !!process.env[keyMap[p.name]])

  if (activeProviders.length === 0) {
    console.log('    ⚠ No research API keys configured — skipping')
    return
  }

  const results = await Promise.allSettled(activeProviders.map(p => p.fn()))

  for (let i = 0; i < activeProviders.length; i++) {
    const providerName = activeProviders[i].name
    const result       = results[i]
    if (result.status === 'rejected') {
      console.error(`    ✗ ${providerName}: ${result.reason?.message || 'failed'}`)
      continue
    }
    const { query, result_json, summary } = result.value
    await db.query(`
      INSERT INTO relationships.contact_research
        (contact_id, source, query, result_json, summary, researched_name, researched_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (contact_id, source) DO UPDATE SET
        query           = EXCLUDED.query,
        result_json     = EXCLUDED.result_json,
        summary         = EXCLUDED.summary,
        researched_name = EXCLUDED.researched_name,
        researched_at   = NOW()
    `, [contact.id, providerName, query, result_json, summary, contact.display_name])
  }

  const dossier = await synthesiseDossier(contact, results)
  if (dossier) {
    await db.query(
      `UPDATE relationships.contacts SET research_summary = $1, updated_at = NOW() WHERE id = $2`,
      [dossier, contact.id]
    )
  }

  const succeeded = results.filter(r => r.status === 'fulfilled').length
  console.log(`    ✓ ${succeeded}/${activeProviders.length} providers succeeded`)
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function runResearch() {
  console.log('\n🏁 Starting research run…')
  try {
    const contacts = await findStaleContacts(20)
    console.log(`   Found ${contacts.length} contacts to research`)

    for (const contact of contacts) {
      try {
        await researchContact(contact)
        await sleep(1000)
      } catch (err) {
        console.error(`  ✗ Error researching ${contact.display_name}:`, err.message)
      }
    }

    console.log('\n✅ Research run complete\n')
  } catch (err) {
    console.error('❌ Research run failed:', err.message)
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function main() {
  // RESEARCH_CONTACT_ID=<id> researches a single contact and exits
  const singleId = process.env.RESEARCH_CONTACT_ID
  if (singleId) {
    const { rows } = await db.query(
      `SELECT id, display_name, job_title, company, emails FROM relationships.contacts WHERE id = $1`,
      [parseInt(singleId, 10)]
    )
    if (rows.length === 0) { console.error('Contact not found'); process.exit(1) }
    await researchContact(rows[0])
    await db.end()
    process.exit(0)
  }

  await runResearch()

  console.log('⏰ Scheduling research every 24 hours')
  cron.schedule('0 3 * * *', () => {
    console.log('⏰ Scheduled research triggered')
    runResearch().catch(err => console.error('❌ Scheduled run error:', err.message))
  })
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message)
  process.exit(1)
})

process.on('SIGINT', async () => {
  console.log('\n🛑 Research Agent stopped')
  try { await db.end() } catch { /* ignore */ }
  process.exit(0)
})
