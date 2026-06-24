const crypto = require('crypto');

const DORMANCY_THRESHOLDS = {
  tier_1: 30,
  tier_2: 60,
  tier_3: 120,
  noise: 180,
};

async function checkDormancy(contacts) {
  const opportunities = [];
  const now = new Date();

  for (const contact of contacts) {
    if (!contact.last_contact_date) continue;

    const threshold = DORMANCY_THRESHOLDS[contact.relationship_tier] || 120;
    const daysSinceContact = Math.floor(
      (now.getTime() - new Date(contact.last_contact_date).getTime()) / (24 * 60 * 60 * 1000)
    );

    if (daysSinceContact > threshold) {
      const weekNumber = Math.floor(daysSinceContact / 7);
      const dedupeKey = crypto
        .createHash('sha256')
        .update(`dormancy:${contact.id}:${contact.relationship_tier}:${weekNumber}`)
        .digest('hex');

      opportunities.push({
        contact_id: contact.id,
        title: `Check in with ${contact.name || contact.id}`,
        description: `No contact for ${daysSinceContact} days (threshold: ${threshold} days)`,
        source: 'dormancy',
        why_now: 'dormancy threshold hit',
        source_id: dedupeKey,
        source_id_hash: dedupeKey,
        created_at: now,
      });
    }
  }

  return opportunities;
}

module.exports = { checkDormancy };
