'use strict'

const serpapi = require('serpapi')
const { getConfig } = require('../../shared/config')

async function researchContact(contact) {
  const apiKey = await getConfig('system.SERPAPI_API_KEY')
  if (!apiKey) throw new Error('SERPAPI_API_KEY not configured')

  const name    = contact.display_name
  const company = contact.company || ''

  const q = company
    ? `"${name}" "${company}"`
    : `"${name}"`

  const raw = await serpapi.getJson({
    api_key: apiKey,
    engine:  'google',
    q,
    num: 10,
  })

  const kg      = raw.knowledge_graph || null
  const organic = (raw.organic_results || []).slice(0, 5).map(r => ({
    title:   r.title,
    link:    r.link,
    snippet: (r.snippet || '').slice(0, 300),
  }))

  const result_json = { query: q, knowledge_graph: kg, organic }

  const lines = []
  if (kg) {
    if (kg.title)       lines.push(`${kg.title}`)
    if (kg.type)        lines.push(`Type: ${kg.type}`)
    if (kg.description) lines.push(kg.description.slice(0, 300))
  }
  for (const r of organic.slice(0, 3)) {
    lines.push(`[${r.title}] ${r.snippet}`)
  }

  const summary = lines.length > 0
    ? lines.join('\n')
    : `No Google results found for ${name}.`

  return { query: q, result_json, summary }
}

module.exports = { researchContact }
