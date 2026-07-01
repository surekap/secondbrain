const crypto = require('crypto');

const COMPANY_SUFFIX_RE = /\b(pvt\.?\s*ltd\.?|private limited|limited|ltd\.?|llp|inc\.?|corp\.?|corporation|gmbh|llc|plc)\b/i;
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com'
]);

const ORG_PATTERNS = [
  /\b(?:at|with|from)\s+([A-Z][A-Za-z0-9 .&'/-]{2,80}?)(?:\s+(?:on|in|for|as|and|to|with)\b|[.,;]|$)/g,
  /\bworks\s+(?:for|at)\s+([A-Z][A-Za-z0-9 .&'/-]{2,80}?)(?:\s+(?:as|on|in|and)\b|[.,;]|$)/gi,
  /\b(?:CEO|CTO|CFO|COO|CIO|VP|Head|Director|Partner|Founder)\s+(?:of|at)\s+([A-Z][A-Za-z0-9 .&'/-]{2,80}?)(?:\s+(?:and|on|in|for)\b|[.,;]|$)/g,
];

const TOPIC_SEEDS = [
  ['investment', /\b(invest(?:ment|or|ing)?|fund|pms|portfolio|capital|deal|valuation|equity|debt)\b/i, 'investment'],
  ['distribution', /\b(distribution|distributor|dealer|channel|sales network)\b/i, 'operations'],
  ['supplier', /\b(supplier|vendor|procurement|sourcing|import|invoice)\b/i, 'operations'],
  ['Africa / Kenya / East Africa', /\b(africa|kenya|east africa|nairobi)\b/i, 'geography'],
  ['family office', /\b(family office|wealth|succession|governance)\b/i, 'domain'],
  ['travel', /\b(travel|flight|hotel|visa|trip|itinerary)\b/i, 'personal'],
  ['event', /\b(event|conference|summit|meeting|workshop)\b/i, 'event'],
  ['technology / API', /\b(api|software|system|integration|certificate|server|database|ai)\b/i, 'domain'],
];

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function domainFromEmail(email) {
  const match = String(email || '').toLowerCase().match(/@([^>\s]+)$/);
  if (!match) return null;
  const domain = match[1].replace(/[)>.,;]+$/, '');
  return GENERIC_DOMAINS.has(domain) ? null : domain;
}

function orgNameFromDomain(domain) {
  if (!domain) return null;
  const left = domain.split('.')[0];
  if (!left || left.length < 3) return null;
  return left.replace(/[-_]+/g, ' ').toUpperCase();
}

function cleanOrgName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:,-]+|[\s:,-]+$/g, '')
    .trim();
}

function looksLikeOrganization(name) {
  const clean = cleanOrgName(name);
  if (clean.length < 3 || clean.length > 100) return false;
  if (COMPANY_SUFFIX_RE.test(clean)) return true;
  if (/\b(bank|capital|ventures|industries|group|school|university|foundation|centre|center|team|club|association|company|systems|tech|labs)\b/i.test(clean)) return true;
  return /^[A-Z][A-Za-z0-9&.'/-]+(?:\s+[A-Z][A-Za-z0-9&.'/-]+){0,5}$/.test(clean);
}

function addOrganization(out, org, sourceRef) {
  const name = cleanOrgName(org.name);
  if (!looksLikeOrganization(name)) return;
  const domain = org.domain ? String(org.domain).toLowerCase() : null;
  const key = `${name.toLowerCase()}:${domain || ''}`;
  if (out.seenOrgs.has(key)) return;
  out.seenOrgs.add(key);
  out.organizations.push({
    name,
    domain,
    source: org.source || 'extracted',
    source_ref: sourceRef || null,
    org_id_hash: stableHash(key),
    metadata: org.metadata || {},
  });
}

function extractTopicsFromText(text, objectType, objectId, sourceRef) {
  const body = String(text || '');
  const topics = [];
  for (const [name, pattern, topicType] of TOPIC_SEEDS) {
    if (pattern.test(body)) {
      topics.push({
        name,
        topic_type: topicType,
        object_type: objectType,
        object_id: String(objectId),
        role: 'mentioned',
        confidence: 0.65,
        source_ref: sourceRef || null,
      });
    }
  }
  return topics;
}

async function extractOrganizations(records, sourceType) {
  const out = { organizations: [], contactLinks: [], topics: [], seenOrgs: new Set() };

  for (const record of records || []) {
    const sourceRef = `${sourceType}:${record.id || record.name || record.display_name || 'unknown'}`;
    const orgs = [];

    if (sourceType === 'contacts') {
      const emails = Array.isArray(record.emails) ? record.emails : [record.email, record.from_addr, record.parsed_email].filter(Boolean);
      const domain = record.email_domain || emails.map(domainFromEmail).find(Boolean);
      if (record.company) orgs.push({ name: record.company, domain, source: 'contact_company' });
      if (domain) orgs.push({ name: orgNameFromDomain(domain), domain, source: 'email_domain' });

      const text = [record.summary, record.job_title, record.tags && record.tags.join(' ')].filter(Boolean).join(' ');
      for (const pattern of ORG_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          if (match[1]) orgs.push({ name: match[1], domain: null, source: 'summary_pattern' });
        }
      }

      const before = out.organizations.length;
      for (const org of orgs) addOrganization(out, org, sourceRef);
      for (const org of out.organizations.slice(before)) {
        out.contactLinks.push({
          contact_id: record.id,
          org_id_hash: org.org_id_hash,
          role: record.job_title || null,
          relationship: 'employee',
          confidence: org.source === 'contact_company' ? 0.85 : 0.55,
          source_ref: sourceRef,
        });
      }
      out.topics.push(...extractTopicsFromText(text, 'contact', record.id, sourceRef));
    } else if (sourceType === 'groups') {
      const text = [record.name, record.summary, record.ai_summary, record.group_type, record.key_topics && JSON.stringify(record.key_topics), record.opportunities && JSON.stringify(record.opportunities)].filter(Boolean).join(' ');
      if (record.name && looksLikeOrganization(record.name)) orgs.push({ name: record.name, domain: null, source: 'group_name' });
      for (const pattern of ORG_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          if (match[1]) orgs.push({ name: match[1], domain: null, source: 'group_text' });
        }
      }
      for (const org of orgs) addOrganization(out, org, sourceRef);
      out.topics.push(...extractTopicsFromText(text, 'group', record.id, sourceRef));
    } else if (sourceType === 'opportunities') {
      const text = [record.title, record.description, record.why_now, record.metadata && JSON.stringify(record.metadata)].filter(Boolean).join(' ');
      for (const pattern of ORG_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          if (match[1]) orgs.push({ name: match[1], domain: null, source: 'opportunity_text' });
        }
      }
      for (const org of orgs) addOrganization(out, org, sourceRef);
      out.topics.push(...extractTopicsFromText(text, 'opportunity', record.id, sourceRef));
    }
  }

  delete out.seenOrgs;
  return out;
}

module.exports = { extractOrganizations, extractTopicsFromText };
