'use strict'

function compact(value, max = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

const JXTAPOSE_PATTERNS = [
  /\bjxtapose\b/i,
  /\bjx\s*tapose\b/i,
  /\bjust\s+to\s+pose\b/i,
  /\bjxp\s+designhouse\b/i,
  /\bjxpdesignhouse@gmail\.com\b/i,
]

const HOME_PROJECT_PATTERNS = [
  /\bhouse\s+renovation\b/i,
  /\bhome\s+renovation\b/i,
  /\bhome\s+improvement\b/i,
  /\bresidence\b/i,
  /\binterior\s+pmc\b/i,
  /\brenovation\b/i,
  /\bsite\s+documentation\b/i,
  /\bconcept\s+render/i,
  /\bservices?\s+drawings?\b/i,
  /\bwindow\s+drawing\b/i,
  /\bcivil\b/i,
  /\belectrical\b/i,
  /\bplumbing\b/i,
  /\bhvac\b/i,
  /\bprojector\b/i,
  /\bvalue\s+engineering\b/i,
]

const MEMBER_PATTERNS = [
  ['Gayatri', /\bgayatri\b/i],
  ['Nandita', /\bnandita\b|\bnanditha\b/i],
  ['Prateek', /\bprateek\b/i],
  ['Rahul', /\brahul\b/i],
  ['Vishal', /\bvishal\b/i],
]

function textForLifelog(lifelog = {}) {
  return [lifelog.title, lifelog.markdown, lifelog.contents, lifelog.summary]
    .filter(Boolean)
    .join('\n')
}

function textForEmail(email = {}) {
  return [email.subject, email.from_address, email.sender_email, email.body_text, email.body]
    .filter(Boolean)
    .join('\n')
}

function hasJxtapose(text) {
  return JXTAPOSE_PATTERNS.some(p => p.test(text || ''))
}

function hasHomeProject(text) {
  return HOME_PROJECT_PATTERNS.some(p => p.test(text || ''))
}

function isHomeImprovementLifelog(lifelog = {}) {
  const text = textForLifelog(lifelog)
  return Boolean(text && hasJxtapose(text) && hasHomeProject(text))
}

function isHomeImprovementEmail(email = {}) {
  const text = textForEmail(email)
  return Boolean(text && hasJxtapose(text) && hasHomeProject(text))
}

function extractMembers(text) {
  const members = []
  for (const [name, pattern] of MEMBER_PATTERNS) {
    if (pattern.test(text)) members.push(name)
  }
  return Array.from(new Set(members))
}

function dateValue(value) {
  const d = new Date(value || 0)
  return Number.isFinite(d.getTime()) ? d.getTime() : 0
}

function emailOccurredAt(email = {}) {
  return email.date || email.received_at || email.created_at || null
}

function detectHomeImprovementOpportunities(input = {}) {
  const lifelogs = (input.lifelogs || [])
    .filter(isHomeImprovementLifelog)
    .sort((a, b) => dateValue(b.start_time || b.created_at) - dateValue(a.start_time || a.created_at))
  const emails = (input.emails || [])
    .filter(isHomeImprovementEmail)
    .sort((a, b) => dateValue(emailOccurredAt(b)) - dateValue(emailOccurredAt(a)))

  if (!lifelogs.length && !emails.length) return []

  const latestAt = [
    ...lifelogs.map(x => x.start_time || x.created_at),
    ...emails.map(emailOccurredAt),
  ].filter(Boolean).sort().at(-1) || null
  const allText = [...lifelogs.map(textForLifelog), ...emails.map(textForEmail)].join('\n')
  const members = extractMembers(allText)
  const latestEmail = emails[0]
  const latestEmailSummary = latestEmail
    ? `${latestEmail.subject || 'Jxtapose email'} from ${latestEmail.from_address || latestEmail.sender_email || 'Jxtapose'} on ${emailOccurredAt(latestEmail) || 'unknown date'}`
    : null
  const lifelog = lifelogs[0]
  const lifelogText = lifelog ? textForLifelog(lifelog) : ''

  const evidence = []
  if (lifelog) {
    const sourceId = lifelog.id || lifelog.source_id || 'unknown'
    evidence.push({
      source_table: 'limitless.lifelogs',
      source_id: sourceId,
      source_ref: `limitless:${sourceId}`,
      occurred_at: lifelog.start_time || lifelog.created_at || null,
      quote: compact(lifelogText, 900),
      relevance: 0.95,
      metadata: { title: lifelog.title || null, detector: 'home_improvement_project' },
    })
  }
  for (const email of emails.slice(0, 8)) {
    evidence.push({
      source_table: 'email.emails',
      source_id: email.id,
      source_ref: `email:${email.id}`,
      occurred_at: emailOccurredAt(email),
      quote: compact(`${email.subject || ''}\n${email.body_text || email.body || ''}`, 900),
      relevance: 0.9,
      metadata: {
        subject: email.subject || null,
        from_address: email.from_address || email.sender_email || null,
        detector: 'home_improvement_project',
      },
    })
  }

  return [{
    opportunity_type: 'project_opportunity',
    title: 'Home renovation with Jxtapose: consolidate drawings, scope, payments, and next blocked decision',
    description: compact(`Jxtapose home-renovation evidence now spans ${emails.length} email(s)${lifelogs.length ? ` plus ${lifelogs.length} lifelog(s)` : ''}. Latest email: ${latestEmailSummary || 'none'}. The thread covers concept renders, floor/brick-demolition/electrical/plumbing/HVAC/RCP layouts, window drawing intent, site documentation/measurements, contractor site visit before GFC drawings, and smart-home/lighting quotation context${members.length ? ` involving ${members.join(', ')}` : ''}.`, 1400),
    recommended_next_action: 'Create a dedicated Home Renovation / Jxtapose project packet: confirm whether latest concept renders/window drawings are approved, whether site-documentation payment is closed, and what one decision blocks GFC drawings/contractor execution.',
    why_now: latestAt ? `Jxtapose email/lifelog evidence last seen ${latestAt}; recent design drawings and site-documentation/payment asks are not linked to a dedicated project/contact.` : 'Jxtapose home-renovation evidence exists but is not surfaced as its own project/contact packet.',
    priority: 'high',
    confidence: emails.length ? 0.92 : 0.86,
    impact_score: 76,
    urgency_score: emails.length ? 78 : 70,
    relationship_score: 62,
    expected_value_score: emails.length ? 82 : 74,
    source_system: 'signals',
    source_ref: 'home_improvement_project:jxtapose_residence',
    dedupe_key: 'home_improvement_project:jxtapose_residence',
    primary_project_id: null,
    metadata: {
      detector: 'home_improvement_project',
      vendor: 'Jxtapose',
      asr_aliases: ['just to pose'],
      members,
      email_count: emails.length,
      lifelog_count: lifelogs.length,
      latest_email_subject: latestEmail?.subject || null,
      latest_email_from: latestEmail?.from_address || latestEmail?.sender_email || null,
      lifelog_title: lifelog?.title || null,
    },
    evidence,
  }]
}

module.exports = { detectHomeImprovementOpportunities, isHomeImprovementLifelog, isHomeImprovementEmail }
