const crypto = require('crypto');

const ORG_PATTERNS = [
  /\bat\s+([A-Z][A-Za-z\s&]+?)(?:\s+on|\s+in|$)/i,
  /\bworks\s+for\s+([A-Z][A-Za-z\s&]+?)(?:\s+as|$)/i,
  /\b(?:CEO|CTO|VP|Head)\s+(?:of|at)\s+([A-Z][A-Za-z\s&]+?)(?:\s+and|$)/i,
];

async function extractOrganizations(records, sourceType) {
  const organizations = [];
  const contactLinks = [];
  const seenOrgs = new Set();

  for (const record of records) {
    const orgs = [];

    if (sourceType === 'contacts') {
      // Extract from company field
      if (record.company) {
        orgs.push({
          name: record.company,
          domain: record.email_domain || null,
          source: 'contact_company'
        });
      }

      // Extract from email domain
      if (record.email_domain && !record.company) {
        orgs.push({
          name: record.email_domain.split('.')[0].toUpperCase(),
          domain: record.email_domain,
          source: 'email_domain'
        });
      }

      // Extract from summary text
      if (record.summary) {
        for (const pattern of ORG_PATTERNS) {
          const match = record.summary.match(pattern);
          if (match && match[1]) {
            const orgName = match[1].trim();
            if (orgName.length > 2 && orgName.length < 100) {
              orgs.push({
                name: orgName,
                domain: null,
                source: 'summary_pattern'
              });
            }
          }
        }
      }
    }
    else if (sourceType === 'groups') {
      // Extract org-like WhatsApp group names
      if (record.name && record.name.includes('Team')) {
        orgs.push({
          name: record.name,
          domain: null,
          source: 'group_name'
        });
      }
    }

    // Deduplicate and create contact links
    for (const org of orgs) {
      const orgHash = crypto
        .createHash('sha256')
        .update(`${org.name}:${org.domain || ''}`)
        .digest('hex');

      if (!seenOrgs.has(orgHash)) {
        organizations.push({
          ...org,
          org_id_hash: orgHash,
          created_at: new Date()
        });
        seenOrgs.add(orgHash);

        if (sourceType === 'contacts') {
          contactLinks.push({
            contact_id: record.id,
            org_id_hash: orgHash,
            role: record.job_title || null,
            start_date: record.start_date || null,
            created_at: new Date()
          });
        }
      }
    }
  }

  return { organizations, contactLinks };
}

module.exports = { extractOrganizations };
