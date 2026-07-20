const crypto = require('crypto');

const DORMANCY_THRESHOLDS = {
  tier_1: 30,
  tier_2: 60,
  tier_3: 120,
  noise: 180,
  unknown: 120,
};

function lastContactAt(contact) {
  return contact.last_contact_date || contact.last_interaction_at || contact.updated_at || null;
}

async function checkDormancy(contacts) {
  const opportunities = [];
  const now = new Date();

  for (const contact of contacts || []) {
    if (contact.is_noise || contact.relationship_tier === 'noise') continue;
    if (Object.prototype.hasOwnProperty.call(contact, 'next_suggested_touch_at') && !contact.next_suggested_touch_at) continue;
    // Dormancy is derived from absence, but the item still needs a positive,
    // inspectable anchor: the latest canonical communication whose age crossed
    // the cadence threshold. Contacts without that anchor remain data-quality
    // candidates and must not become attention items.
    if (!contact.canonical_communication_id) continue;
    const last = lastContactAt(contact);
    if (!last) continue;

    const threshold = contact.dormant_threshold_days || contact.preferred_cadence_days || DORMANCY_THRESHOLDS[contact.relationship_tier || 'unknown'] || 120;
    const daysSinceContact = Math.floor(
      (now.getTime() - new Date(last).getTime()) / (24 * 60 * 60 * 1000)
    );

    if (daysSinceContact > threshold) {
      const weekNumber = Math.floor(daysSinceContact / 7);
      const dedupeKey = crypto
        .createHash('sha256')
        .update(`dormancy:${contact.id}:${contact.relationship_tier || 'unknown'}:${weekNumber}`)
        .digest('hex');

      opportunities.push({
        contact_id: contact.id,
        title: `Check in with ${contact.display_name || contact.name || contact.id}`,
        description: `No meaningful interaction for ${daysSinceContact} days (threshold: ${threshold} days)`,
        source: 'dormancy',
        why_now: `${contact.relationship_tier || 'unknown'} relationship crossed dormancy threshold`,
        source_id: dedupeKey,
        source_id_hash: dedupeKey,
        threshold_days: threshold,
        days_since_contact: daysSinceContact,
        last_interaction_at: last,
        canonical_communication_id: contact.canonical_communication_id,
        canonical_communication_at: contact.canonical_communication_at || last,
        created_at: now,
      });
    }
  }

  return opportunities;
}

module.exports = { checkDormancy };
