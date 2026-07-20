'use strict';

const { normalizeEmails, normalizePhones, rawValues } = require('./normalization');

function loadNativeContacts() {
  if (process.platform !== 'darwin') {
    throw new Error('Native Apple Contacts sync requires macOS');
  }
  try {
    return require('node-mac-contacts');
  } catch (err) {
    throw new Error(
      'node-mac-contacts is not installed or could not be loaded. ' +
      'Run: npm install --optional  (Error: ' + err.message + ')'
    );
  }
}

/**
 * Read all contacts from Apple Contacts (macOS only).
 * Triggers the macOS Contacts privacy permission dialog on first access.
 * @returns {Promise<Array<NormalizedContact>>}
 */
async function readNativeContacts() {
  const contacts = loadNativeContacts();
  // Check permission before calling getAllContacts — it returns [] silently when denied
  const authStatus = contacts.getAuthStatus();
  if (authStatus === 'Not Determined') {
    // First run — show the macOS permission dialog.
    // macOS will display "secondbrain wants access to your Contacts".
    console.log('[apple-contacts] Requesting Contacts permission…');
    await new Promise(resolve => contacts.requestAccess(resolve));
    const newStatus = contacts.getAuthStatus();
    if (newStatus !== 'Authorized') {
      printDeniedInstructions();
      throw new Error('Contacts access denied or not determined');
    }
  } else if (authStatus === 'Denied' || authStatus === 'Restricted') {
    printDeniedInstructions();
    throw new Error('Contacts access denied or restricted');
  }

  const raw = contacts.getAllContacts();

  if (!Array.isArray(raw)) {
    throw new Error('node-mac-contacts.getAllContacts() returned unexpected value');
  }

  return raw.map(normalizeNativeContact).filter(Boolean);
}

function normalizeNativeContact(c, options = {}) {
  const firstName = (c.firstName || '').trim() || null;
  const lastName  = (c.lastName  || '').trim() || null;
  const nickname  = (c.nickname  || '').trim() || null;
  const org       = (c.organization || '').trim() || null;

  const displayName =
    [firstName, lastName].filter(Boolean).join(' ') ||
    org ||
    nickname ||
    null;

  if (!displayName) return null;

  // node-mac-contacts currently returns strings. Older releases and test
  // fixtures may return { value, label } objects, so accept both shapes.
  const rawEmails = rawValues(c.emailAddresses || []);
  const rawPhoneNumbers = rawValues(c.phoneNumbers || []);
  const emails = normalizeEmails(c.emailAddresses || []);
  const phoneNumbers = normalizePhones(c.phoneNumbers || [], options);

  // image is a Buffer (JPEG data) when present
  let avatarData = null;
  if (c.image && Buffer.isBuffer(c.image) && c.image.length > 0) {
    avatarData = c.image.toString('base64');
  }

  return {
    apple_contact_id: c.identifier,  // stable UUID from macOS
    display_name:     displayName,
    first_name:       firstName,
    last_name:        lastName,
    emails,
    phone_numbers:    phoneNumbers,
    company:          org,
    job_title:        (c.jobTitle || '').trim() || null,
    avatar_data:      avatarData,
    raw_emails:       rawEmails,
    raw_phone_numbers: rawPhoneNumbers,
  };
}

function printDeniedInstructions() {
  console.error('');
  console.error('[apple-contacts] ❌ Contacts access denied.');
  console.error('');
  console.error('To fix this:');
  console.error('  1. Open: System Settings → Privacy & Security → Contacts');
  console.error('  2. Find "secondbrain" in the list and toggle it ON.');
  console.error('     (If it\'s not listed yet, click Sync Now once — macOS will prompt you.)');
  console.error('  3. If you previously denied the request, click the toggle to re-enable it.');
  console.error('  4. Click Sync Now on the Agents page to retry.');
  console.error('');
}

module.exports = { readNativeContacts, normalizeNativeContact };
