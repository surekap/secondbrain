'use strict'

const OpenAI = require('openai')
const { getConfig } = require('../../shared/config')

async function researchContact(contact) {
  const apiKey = process.env.OPENAI_API_KEY || await getConfig('system.OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')
  const c = new OpenAI.default({ apiKey })

  const name    = contact.display_name
  const context = [contact.job_title, contact.company].filter(Boolean).join(' at ')
  const query   = context ? `${name} (${context})` : name

  const prompt = `Search the public web for reliable, current information about ${query}.
Please include (only if known with confidence):
- Professional background and career history
- Current role and company details
- Notable work, achievements, or public reputation
- Recent news or developments as of ${new Date().toISOString().slice(0, 10)}
- Social/professional presence (LinkedIn, publications, talks)
Be factual and distinguish this person from people with similar names. If you are uncertain about something, say so. Do not invent information. Keep the response under 300 words and preserve source citations.`

  const requestedModel = process.env.RESEARCH_OPENAI_MODEL || 'gpt-5.6-luna'
  const response = await c.responses.create({
    model: requestedModel,
    input: prompt,
    tools: [{ type: 'web_search' }],
    reasoning: { effort: 'low' },
    max_output_tokens: 600,
    store: false,
  })

  const text = response.output_text || ''
  const model = response.model || requestedModel

  return {
    query,
    result_json: { model, response_id: response.id, response: text },
    summary: text || `No information found for ${name}.`,
  }
}

module.exports = { researchContact }
