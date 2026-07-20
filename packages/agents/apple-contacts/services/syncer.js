'use strict';

const { Pool } = require('pg');
const path = require('path');
const dotenv = require('dotenv');
const identity = require('../../relationships/services/identity');

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
async function syncContacts(contacts, options = {}) {
  const db = options.db || getDb();
  let matched = 0;
  let created = 0;
  let skipped = 0;
  let conflicts = 0;

  await identity.ensureIdentitySchema(db);

  for (const contact of contacts) {
    try {
      const existing = await findMatch(db, contact);
      let target = existing;
      if (existing) {
        matched++;
      } else {
        target = await createContact(db, contact);
        created++;
      }
      const identityResult = await recordSafeIdentities(db, target.id, contact);
      conflicts += identityResult.conflicts;
      await enrichExisting(db, target, contact, identityResult.accepted);
    } catch (err) {
      console.error('[apple-contacts] Failed to sync contact:', contact.display_name, err.message);
      skipped++;
    }
  }

  return { total: contacts.length, matched, created, skipped, conflicts };
}

/**
 * Find an existing contact matching the incoming contact.
 * Match only stable identifiers. A name is search/display data, not identity.
 * If different stable identifiers point to different contacts, do not guess.
 */
async function findMatch(db, contact) {
  if (contact.apple_contact_id) {
    const identityOwner = await identity.findContactByIdentity(db, {
      source: 'apple_contacts',
      identity_type: 'apple_contact_id',
      identity_value: contact.apple_contact_id,
    });
    if (identityOwner) return getContact(db, identityOwner);

    // Compatibility path for Apple rows imported before contact_identities.
    const { rows } = await db.query(
      'SELECT * FROM relationships.contacts WHERE apple_contact_id = $1 LIMIT 1',
      [contact.apple_contact_id]
    );
    if (rows.length) return rows[0];
  }

  const ownerIds = new Set();
  for (const candidate of identity.identitiesForContactLike(contact)) {
    if (candidate.identity_type === 'apple_contact_id') continue;
    const ownerId = await identity.findContactByIdentity(db, candidate);
    if (ownerId) ownerIds.add(String(ownerId));
  }

  // Compatibility path for arrays populated before contact_identities existed.
  const normalizedEmails = (contact.emails || []).map(v => identity.normalizeIdentityValue('email', v));
  const normalizedPhones = (contact.phone_numbers || []).map(v => identity.normalizeIdentityValue('phone', v));
  if (normalizedEmails.length || normalizedPhones.length) {
    const { rows } = await db.query(`
      SELECT DISTINCT c.id
      FROM relationships.contacts c
      WHERE c.is_noise IS DISTINCT FROM TRUE
        AND (
          EXISTS (
            SELECT 1 FROM unnest(COALESCE(c.emails, '{}')) value
            WHERE LOWER(TRIM(value)) = ANY($1::text[])
          )
          OR EXISTS (
            SELECT 1 FROM unnest(COALESCE(c.phone_numbers, '{}')) value
            WHERE REGEXP_REPLACE(value, '[^0-9]', '', 'g') = ANY($2::text[])
          )
        )
    `, [normalizedEmails.filter(Boolean), normalizedPhones.filter(Boolean)]);
    for (const row of rows) ownerIds.add(String(row.id));
  }

  if (ownerIds.size === 1) return getContact(db, [...ownerIds][0]);
  return null;
}

async function getContact(db, contactId) {
  const { rows } = await db.query(
    'SELECT * FROM relationships.contacts WHERE id = $1 LIMIT 1',
    [contactId]
  );
  return rows[0] || null;
}

function identityKey(identityRow) {
  return `${identityRow.identity_type}:${identityRow.identity_value}`;
}

async function recordSafeIdentities(db, contactId, contact) {
  const candidates = identity.identitiesForContactLike(contact).map(candidate => ({
    ...candidate,
    metadata: {
      source_contact_id: contact.apple_contact_id || null,
      raw_emails: contact.raw_emails || [],
      raw_phone_numbers: contact.raw_phone_numbers || [],
    },
  }));
  const rows = await identity.recordContactIdentities(db, contactId, candidates);
  return {
    accepted: new Set(rows
      .filter(row => !row.conflict && String(row.contact_id) === String(contactId))
      .map(identityKey)),
    conflicts: rows.filter(row => row.conflict).length,
  };
}

/**
 * Enrich an existing contact with Apple Contacts data.
 * Respects manual_overrides for company and job_title.
 */
async function enrichExisting(db, existing, contact, accepted = new Set()) {
  const overrides = existing.manual_overrides || {};

  const acceptedEmails = (contact.emails || []).filter(value => accepted.has(
    `email:${identity.normalizeIdentityValue('email', value)}`
  ));
  const acceptedPhones = (contact.phone_numbers || []).filter(value => accepted.has(
    `phone:${identity.normalizeIdentityValue('phone', value)}`
  ));
  const acceptedAppleId = contact.apple_contact_id && accepted.has(
    `apple_contact_id:${identity.normalizeIdentityValue('apple_contact_id', contact.apple_contact_id)}`
  );

  // Merge emails (array union, deduped)
  const mergedEmails = Array.from(new Set([
    ...(existing.emails || []),
    ...acceptedEmails,
  ]));

  // Merge phone_numbers (array union, deduped)
  const mergedPhones = Array.from(new Set([
    ...(existing.phone_numbers || []),
    ...acceptedPhones,
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
       apple_contact_id = CASE WHEN $1::boolean THEN COALESCE(apple_contact_id, $2) ELSE apple_contact_id END,
       avatar_data      = $3,
       emails           = $4,
       phone_numbers    = $5,
       company          = $6,
       job_title        = $7,
       raw_data         = COALESCE(raw_data, '{}'::jsonb) || jsonb_build_object('apple_contacts', $8::jsonb),
       updated_at       = NOW()
     WHERE id = $9`,
    [
      Boolean(acceptedAppleId),
      contact.apple_contact_id,
      newAvatarData,
      mergedEmails,
      mergedPhones,
      newCompany,
      newJobTitle,
      JSON.stringify({
        source_contact_id: contact.apple_contact_id || null,
        raw_emails: contact.raw_emails || [],
        raw_phone_numbers: contact.raw_phone_numbers || [],
        synced_at: new Date().toISOString(),
      }),
      existing.id,
    ]
  );
}

/**
 * Create a new contact record from Apple Contacts data.
 */
async function createContact(db, contact) {
  const normalized = contact.display_name.toLowerCase().trim();
  const { rows } = await db.query(
    `INSERT INTO relationships.contacts
       (display_name, normalized_name, emails, phone_numbers,
        company, job_title, avatar_data,
        relationship_type, relationship_strength, is_noise)
     VALUES ($1,$2,'{}','{}',$3,$4,$5,'unknown','weak',false)
     RETURNING *`,
    [
      contact.display_name,
      normalized,
      contact.company      || null,
      contact.job_title    || null,
      contact.avatar_data  || null,
    ]
  );
  return rows[0];
}

module.exports = { syncContacts, findMatch, enrichExisting, createContact, recordSafeIdentities };
