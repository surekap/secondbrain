'use strict';

const vCard = require('vcf');

/**
 * Parse a .vcf file string into an array of normalized contact objects.
 * @param {string} vcfText
 * @returns {Array<NormalizedContact>}
 */
function parseVcf(vcfText) {
  // Ensure proper line endings for vcf parser (uses \r\n)
  const normalizedText = vcfText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  const cards = vCard.parse(normalizedText);
  // vCard.parse returns vCard objects (not jCard)
  return cards.map(normalizeCard).filter(Boolean);
}

function normalizeCard(card) {
  const get = (field) => {
    const f = card.get(field);
    if (!f) return null;
    return Array.isArray(f) ? f[0].valueOf() : f.valueOf();
  };

  const getAll = (field) => {
    const f = card.get(field);
    if (!f) return [];
    return (Array.isArray(f) ? f : [f]).map(x => x.valueOf()).filter(Boolean);
  };

  // UID — stable ID; prefix vcf: to avoid collisions with native Apple IDs
  let uid = get('uid');
  const fn = get('fn') || '';
  const emails = getAll('email').map(e => e.toLowerCase().trim()).filter(Boolean);

  if (!uid) {
    // deterministic fallback from FN + first email
    uid = 'vcf:' + Buffer.from((fn + (emails[0] || '')).toLowerCase()).toString('base64');
  } else {
    uid = 'vcf:' + uid;
  }

  // N field: "Last;First;Middle;Prefix;Suffix"
  let firstName = null;
  let lastName = null;
  const n = card.get('n');
  if (n) {
    try {
      const parts = String(n.valueOf()).split(';');
      lastName  = (parts[0] || '').trim() || null;
      firstName = (parts[1] || '').trim() || null;
    } catch { /* malformed N field — skip */ }
  }

  const displayName = fn ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    null;

  if (!displayName) return null; // skip empty cards

  // Phone numbers — digits only, keep last 10
  const phoneNumbers = getAll('tel')
    .map(t => t.replace(/\D/g, ''))
    .filter(t => t.length >= 7)
    .map(t => t.slice(-10));

  // Company
  const org = get('org');
  const company = org ? String(org).split(';')[0].trim() || null : null;

  // Job title
  const jobTitle = get('title') || null;

  // Avatar — PHOTO field
  let avatarData = null;
  const photo = card.get('photo');
  if (photo) {
    const raw = photo.valueOf();
    // raw may be base64 or a URL; only store base64 blobs
    if (raw && !raw.startsWith('http') && raw.length > 100) {
      // Strip any data URI prefix if present
      avatarData = raw.replace(/^data:[^;]+;base64,/, '').trim() || null;
    }
  }

  return {
    apple_contact_id: uid,
    display_name:     displayName,
    first_name:       firstName,
    last_name:        lastName,
    emails,
    phone_numbers:    phoneNumbers,
    company,
    job_title:        jobTitle,
    avatar_data:      avatarData,
  };
}

module.exports = { parseVcf };
