'use strict'

const PDLJS = require('peopledatalabs')
const { getConfig } = require('../../shared/config')

async function researchContact(contact) {
  const apiKey = await getConfig('system.PEOPLEDATALABS_API_KEY')
  if (!apiKey) {
    return { query: contact.display_name, result_json: { status: 'not_configured' }, summary: `PEOPLEDATALABS_API_KEY not configured.` }
  }
  const c = new PDLJS.default({ apiKey })

  const name    = contact.display_name
  const company = contact.company || ''
  const emails  = Array.isArray(contact.emails) ? contact.emails : []
  let raw = null
  let query = ''

  if (emails.length > 0) {
    query = emails[0]
    try {
      const result = await c.person.enrichment({ email: emails[0], pretty: false })
      if (result?.status === 200) raw = result.data
    } catch { /* fall through */ }
  }

  if (!raw && name) {
    query = `${name}${company ? ' | ' + company : ''}`
    try {
      const params = { name, pretty: false }
      if (company) params.company = company
      const result = await c.person.enrichment(params)
      if (result?.status === 200) raw = result.data
    } catch { /* no result */ }
  }

  if (!raw) {
    return {
      query,
      result_json: { status: 'not_found' },
      summary: `No PeopleDataLabs profile found for ${name}.`,
    }
  }

  const result_json = {
    full_name:    raw.full_name,
    job_title:    raw.job_title,
    job_company:  raw.job_company_name,
    location:     raw.location_name,
    linkedin:     raw.linkedin_url,
    industry:     raw.industry,
    skills:       (raw.skills || []).slice(0, 10),
    experience:   (raw.experience || []).slice(0, 3).map(e => ({
      title:   e.title?.name,
      company: e.company?.name,
      start:   e.start_date,
      end:     e.end_date,
    })),
    education:    (raw.education || []).slice(0, 2).map(e => ({
      school: e.school?.name,
      degree: e.degrees?.[0],
    })),
  }

  const summary = [
    raw.full_name && `Name: ${raw.full_name}`,
    raw.job_title && raw.job_company_name && `Role: ${raw.job_title} at ${raw.job_company_name}`,
    raw.location_name && `Location: ${raw.location_name}`,
    raw.linkedin_url && `LinkedIn: ${raw.linkedin_url}`,
    raw.industry && `Industry: ${raw.industry}`,
    result_json.experience.length > 0 && `Experience: ${result_json.experience.map(e => `${e.title} @ ${e.company}`).join(', ')}`,
  ].filter(Boolean).join('\n')

  return { query, result_json, summary: summary || `Profile found for ${name}.` }
}

module.exports = { researchContact }
