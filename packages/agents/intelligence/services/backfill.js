const crypto = require('crypto');

async function backfillOpportunities(records, sourceType) {
  const opportunities = [];
  const seen = new Set();

  for (const record of records) {
    let opportunityData, opportunityIdHash;

    if (sourceType === 'relationships.insights') {
      opportunityIdHash = crypto
        .createHash('sha256')
        .update(`insight:${record.id}`)
        .digest('hex');

      if (!seen.has(opportunityIdHash)) {
        opportunityData = {
          contact_id: record.contact_id,
          title: record.insight_type,
          description: record.insight,
          source: 'insight',
          source_type: sourceType,
          source_id: record.id,
          source_id_hash: opportunityIdHash,
          created_at: new Date(),
        };
        opportunities.push(opportunityData);
        seen.add(opportunityIdHash);
      }
    }
    else if (sourceType === 'projects.project_insights') {
      const contentHash = crypto
        .createHash('sha256')
        .update(record.insight)
        .digest('hex');

      opportunityIdHash = crypto
        .createHash('sha256')
        .update(`project_insight:${record.project_id}:${record.insight_type}:${contentHash}`)
        .digest('hex');

      if (!seen.has(opportunityIdHash)) {
        opportunityData = {
          project_id: record.project_id,
          title: record.insight_type,
          description: record.insight,
          source: 'insight',
          source_type: sourceType,
          source_id: record.id,
          source_id_hash: opportunityIdHash,
          created_at: new Date(),
        };
        opportunities.push(opportunityData);
        seen.add(opportunityIdHash);
      }
    }
    else if (sourceType === 'groups') {
      // Group opportunities from JSONB array
      if (record.opportunities && Array.isArray(record.opportunities)) {
        for (const opp of record.opportunities) {
          opportunityIdHash = crypto
            .createHash('sha256')
            .update(`group:${record.id}:${opp.title}`)
            .digest('hex');

          if (!seen.has(opportunityIdHash)) {
            opportunityData = {
              group_id: record.id,
              title: opp.title,
              description: opp.description || '',
              source: 'group_topic',
              source_type: sourceType,
              source_id: record.id,
              source_id_hash: opportunityIdHash,
              created_at: new Date(),
            };
            opportunities.push(opportunityData);
            seen.add(opportunityIdHash);
          }
        }
      }
    }
  }

  return opportunities;
}

module.exports = { backfillOpportunities };
