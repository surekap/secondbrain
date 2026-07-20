'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNativeContact } = require('../services/nativeReader');
const { normalizePhone } = require('../services/normalization');

test('native reader accepts the current node-mac-contacts string arrays', () => {
  const contact = normalizeNativeContact({
    identifier: 'apple-123',
    firstName: 'Ada',
    lastName: 'Lovelace',
    emailAddresses: [' ADA@Example.COM ', 'ada@example.com'],
    phoneNumbers: ['+91 98765 43210'],
  });

  assert.equal(contact.display_name, 'Ada Lovelace');
  assert.deepEqual(contact.emails, ['ada@example.com']);
  assert.deepEqual(contact.phone_numbers, ['+919876543210']);
  assert.deepEqual(contact.raw_emails, ['ADA@Example.COM', 'ada@example.com']);
  assert.deepEqual(contact.raw_phone_numbers, ['+91 98765 43210']);
});

test('native reader remains compatible with legacy labelled value objects', () => {
  const contact = normalizeNativeContact({
    identifier: 'apple-456',
    organization: 'Analytical Engines',
    emailAddresses: [{ label: 'work', value: 'Office@Example.com' }],
    phoneNumbers: [{ label: 'mobile', value: '98765 43210' }],
  }, { defaultCountryCode: '91' });

  assert.equal(contact.display_name, 'Analytical Engines');
  assert.deepEqual(contact.emails, ['office@example.com']);
  assert.deepEqual(contact.phone_numbers, ['+919876543210']);
});

test('phone normalization never truncates international country codes', () => {
  assert.equal(normalizePhone('+1 (415) 555-0123'), '+14155550123');
  assert.equal(normalizePhone('98765 43210', { defaultCountryCode: '91' }), '+919876543210');
  assert.equal(normalizePhone('123'), null);
});
