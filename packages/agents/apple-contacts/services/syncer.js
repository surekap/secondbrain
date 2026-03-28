'use strict';

const { Pool } = require('pg');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') });

let _db = null;
function getDb() {
  if (!_db) _db = new Pool({ connectionString: process.env.DATABASE_URL });
  return _db;
}

/**
 * Sync an array of normalized contact objects into relationships.contacts.
 * @param {Array<NormalizedContact>} contacts
 * @returns {{ total: number, matched: number, created: number, skipped: number }}
 */
async function syncContacts(contacts) {
  const db = getDb();
  let matched = 0;
  let created = 0;
  let skipped = 0;

  for (const contact of contacts) {
    try {
      const existing = await findMatch(db, contact);
      if (existing) {
        await enrichExisting(db, existing, contact);
        matched++;
      } else {
        await createContact(db, contact);
        created++;
      }
    } catch (err) {
      console.error('[apple-contacts] Failed to sync contact:', contact.display_name, err.message);
      skipped++;
    }
  }

  return { total: contacts.length, matched, created, skipped };
}

/**
 * Find an existing contact matching the incoming contact.
 * Priority: apple_contact_id → phone → email → normalized name
 */
async function findMatch(db, contact) {
  // 1. apple_contact_id (fast re-sync path)
  if (contact.apple_contact_id) {
    const { rows } = await db.query(
      'SELECT * FROM relationships.contacts WHERE apple_contact_id = $1 LIMIT 1',
      [contact.apple_contact_id]
    );
    if (rows.length) return rows[0];
  }

  // 2. Phone number match (last 10 digits against phone_numbers array)
  if (contact.phone_numbers && contact.phone_numbers.length > 0) {
    const { rows } = await db.query(
      `SELECT * FROM relationships.contacts
       WHERE phone_numbers && $1::text[]
       LIMIT 1`,
      [contact.phone_numbers]
    );
    if (rows.length) return rows[0];
  }

  // 3. Email match (lowercase exact)
  if (contact.emails && contact.emails.length > 0) {
    const { rows } = await db.query(
      `SELECT * FROM relationships.contacts
       WHERE emails && $1::text[]
       LIMIT 1`,
      [contact.emails]
    );
    if (rows.length) return rows[0];
  }

  // 4. Normalized name (last resort, no fuzzy)
  if (contact.display_name) {
    const normalized = contact.display_name.toLowerCase().trim();
    const { rows } = await db.query(
      'SELECT * FROM relationships.contacts WHERE normalized_name = $1 LIMIT 1',
      [normalized]
    );
    if (rows.length) return rows[0];
  }

  return null;
}

/**
 * Enrich an existing contact with Apple Contacts data.
 * Respects manual_overrides for company and job_title.
 */
async function enrichExisting(db, existing, contact) {
  const overrides = existing.manual_overrides || {};

  // Merge emails (array union, deduped)
  const mergedEmails = Array.from(new Set([
    ...(existing.emails || []),
    ...(contact.emails  || []),
  ]));

  // Merge phone_numbers (array union, deduped)
  const mergedPhones = Array.from(new Set([
    ...(existing.phone_numbers || []),
    ...(contact.phone_numbers  || []),
  ]));

  // company — only fill if null AND not overridden
  const newCompany = (!existing.company && !overrides.company && contact.company)
    ? contact.company
    : existing.company;

  // job_title — only fill if null AND not overridden
  const newJobTitle = (!existing.job_title && !overrides.job_title && contact.job_title)
    ? contact.job_title
    : existing.job_title;

  // avatar_data — only update if incoming has a value (don't clear existing photo)
  const newAvatarData = contact.avatar_data !== null ? contact.avatar_data : existing.avatar_data;

  await db.query(
    `UPDATE relationships.contacts SET
       apple_contact_id = $1,
       avatar_data      = $2,
       emails           = $3,
       phone_numbers    = $4,
       company          = $5,
       job_title        = $6,
       updated_at       = NOW()
     WHERE id = $7`,
    [
      contact.apple_contact_id,
      newAvatarData,
      mergedEmails,
      mergedPhones,
      newCompany,
      newJobTitle,
      existing.id,
    ]
  );
}

/**
 * Create a new contact record from Apple Contacts data.
 */
async function createContact(db, contact) {
  const normalized = contact.display_name.toLowerCase().trim();
  await db.query(
    `INSERT INTO relationships.contacts
       (display_name, normalized_name, emails, phone_numbers,
        company, job_title, apple_contact_id, avatar_data,
        relationship_type, relationship_strength, is_noise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unknown','weak',false)`,
    [
      contact.display_name,
      normalized,
      contact.emails       || [],
      contact.phone_numbers || [],
      contact.company      || null,
      contact.job_title    || null,
      contact.apple_contact_id,
      contact.avatar_data  || null,
    ]
  );
}

module.exports = { syncContacts };
