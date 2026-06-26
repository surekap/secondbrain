'use strict'

function compact(value, max = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

const JXTAPOSE_PATTERNS = [
  /\bjxtapose\b/i,
  /\bjx\s*tapose\b/i,
  /\bjust\s+to\s+pose\b/i,
]

const HOME_PROJECT_PATTERNS = [
  /\bhouse\s+renovation\b/i,
  /\bhome\s+renovation\b/i,
  /\bhome\s+improvement\b/i,
  /\binterior\s+pmc\b/i,
  /\brenovation\b/i,
  /\bcivil\b/i,
  /\belectrical\b/i,
  /\bplumbing\b/i,
  /\bprojector\b/i,
  /\bvalue\s+engineering\b/i,
]

const MEMBER_PATTERNS = [
  ['Gayatri', /\bgayatri\b/i],
  ['Nandita', /\bnandita\b/i],
  ['Prateek', /\bprateek\b/i],
]

function textForLifelog(lifelog = {}) {
  return [lifelog.title, lifelog.markdown, lifelog.contents, lifelog.summary]
    .filter(Boolean)
    .join('\n')
}

function isHomeImprovementLifelog(lifelog = {}) {
  const text = textForLifelog(lifelog)
  if (!text) return false
  const hasVendor = JXTAPOSE_PATTERNS.some(p => p.test(text))
  const hasProject = HOME_PROJECT_PATTERNS.some(p => p.test(text))
  return hasVendor && hasProject
}

function extractMembers(text) {
  const members = []
  for (const [name, pattern] of MEMBER_PATTERNS) {
    if (pattern.test(text)) members.push(name)
  }
  return Array.from(new Set(members))
}

function detectHomeImprovementOpportunities(input = {}) {
  const lifelogs = input.lifelogs || []
  const candidates = lifelogs
    .filter(isHomeImprovementLifelog)
    .sort((a, b) => new Date(b.start_time || b.created_at || 0) - new Date(a.start_time || a.created_at || 0))

  return candidates.slice(0, 3).map(lifelog => {
    const text = textForLifelog(lifelog)
    const occurredAt = lifelog.start_time || lifelog.created_at || null
    const members = extractMembers(text)
    const sourceId = lifelog.id || lifelog.source_id || 'unknown'
    const quote = compact(text, 900)
    return {
      opportunity_type: 'project_opportunity',
      title: 'Home renovation with Jxtapose / Gayatri: clarify PMC scope, decisions, and owners',
      description: compact(`Limitless meeting evidence indicates a home-renovation discussion with Jxtapose (transcribed as “just to pose”) and Gayatri. Key themes include renovation of the house, interior/PMC coordination, project-cost/value-engineering decisions, and member alignment${members.length ? ` involving ${members.join(', ')}` : ''}. Evidence: “${quote}”`, 1400),
      recommended_next_action: 'Create or update the home-improvement project with Jxtapose/Gayatri; extract owner/date/decision list from the lifelog and ask for only the next blocked decision.',
      why_now: occurredAt ? `Home-renovation/Jxtapose meeting evidence last seen ${occurredAt}; it is currently buried inside broad real-estate project context.` : 'Home-renovation/Jxtapose meeting evidence exists but is not surfaced as its own project.',
      priority: 'high',
      confidence: 0.86,
      impact_score: 72,
      urgency_score: 70,
      relationship_score: 62,
      expected_value_score: 74,
      source_system: 'signals',
      source_ref: `home_improvement_project:limitless:${sourceId}`,
      dedupe_key: `home_improvement_project:limitless:${sourceId}`,
      primary_project_id: null,
      metadata: {
        detector: 'home_improvement_project',
        vendor: 'Jxtapose',
        asr_aliases: ['just to pose'],
        members,
        lifelog_title: lifelog.title || null,
      },
      evidence: [{
        source_table: 'limitless.lifelogs',
        source_id: sourceId,
        source_ref: `limitless:${sourceId}`,
        occurred_at: occurredAt,
        quote,
        relevance: 0.95,
        metadata: { title: lifelog.title || null, detector: 'home_improvement_project' },
      }],
    }
  })
}

module.exports = { detectHomeImprovementOpportunities, isHomeImprovementLifelog }
