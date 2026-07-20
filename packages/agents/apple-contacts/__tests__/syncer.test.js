'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findMatch } = require('../services/syncer');

test('Apple sync never treats an equal display name as identity evidence', async () => {
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
  };

  const match = await findMatch(db, {
    apple_contact_id: 'apple-new',
    display_name: 'A Common Name',
    emails: [],
    phone_numbers: [],
  });

  assert.equal(match, null);
  assert.doesNotMatch(calls.join('\n'), /normalized_name\s*=/i);
});

test('Apple sync refuses to guess when stable identifiers have different owners', async () => {
  const db = {
    async query(sql) {
      if (/SELECT contact_id/.test(sql)) return { rows: [] };
      if (/apple_contact_id =/.test(sql)) return { rows: [] };
      if (/SELECT DISTINCT c\.id/.test(sql)) return { rows: [{ id: 10 }, { id: 20 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const match = await findMatch(db, {
    apple_contact_id: 'apple-new',
    display_name: 'Ambiguous',
    emails: ['same@example.com'],
    phone_numbers: ['+919876543210'],
  });
  assert.equal(match, null);
});
