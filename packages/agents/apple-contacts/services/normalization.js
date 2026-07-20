'use strict';

function valueOf(entry) {
  if (entry === null || entry === undefined) return '';
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (typeof entry === 'object' && entry.value !== null && entry.value !== undefined) {
    return String(entry.value);
  }
  return '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeEmail(entry) {
  const raw = valueOf(entry).trim();
  if (!raw) return null;
  return raw.replace(/^mailto:/i, '').trim().toLowerCase() || null;
}

/**
 * Preserve the complete number rather than truncating to a local suffix.
 * Local ten-digit numbers are only expanded when an explicit default country
 * code is configured. The identity layer removes the leading + for matching.
 */
function normalizePhone(entry, options = {}) {
  const raw = valueOf(entry).trim();
  if (!raw) return null;

  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;

  const defaultCountryCode = String(
    options.defaultCountryCode || process.env.CONTACTS_DEFAULT_COUNTRY_CODE || ''
  ).replace(/\D/g, '');
  if (!raw.startsWith('+') && !raw.startsWith('00') && digits.length === 10 && defaultCountryCode) {
    digits = `${defaultCountryCode}${digits}`;
  }

  return `+${digits}`;
}

function normalizeEmails(entries = []) {
  return unique(entries.map(normalizeEmail));
}

function normalizePhones(entries = [], options = {}) {
  return unique(entries.map(entry => normalizePhone(entry, options)));
}

function rawValues(entries = []) {
  return unique(entries.map(valueOf).map(v => v.trim()));
}

module.exports = {
  valueOf,
  normalizeEmail,
  normalizePhone,
  normalizeEmails,
  normalizePhones,
  rawValues,
};
