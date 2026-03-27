'use strict'

const OpenAI = require('openai')
const { getConfig } = require('../../shared/config')

async function researchContact(contact) {
  const apiKey = await getConfig('system.OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')
  const c = new OpenAI.default({ apiKey })

  const name    = contact.display_name
  const context = [contact.job_title, contact.company].filter(Boolean).join(' at ')
  const query   = context ? `${name} (${context})` : name

  const prompt = `What is publicly known about ${query}?
Please include (only if known with confidence):
- Professional background and career history
- Current role and company details
- Notable work, achievements, or public reputation
- Recent news or developments (2024-2025)
- Social/professional presence (LinkedIn, publications, talks)
Be factual. If you are uncertain about something, say so. Do not invent information. Keep response under 300 words.`

  const response = await c.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
  })

  const text = response.choices?.[0]?.message?.content || ''

  return {
    query,
    result_json: { model: 'gpt-4o', response: text },
    summary: text || `No information found for ${name}.`,
  }
}

module.exports = { researchContact }
