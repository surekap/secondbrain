const test = require('node:test');
const assert = require('node:assert');
const { extractOrganizations } = require('../services/organization-extractor');

test('organization-extractor: extracts org from contact company field', async () => {
  const mockContact = {
    id: 'alice@example.com',
    company: 'Acme Corporation',
    email_domain: 'acme.com'
  };

  const { organizations, contactLinks } = await extractOrganizations([mockContact], 'contacts');
  assert.ok(organizations.some(o => o.name === 'Acme Corporation'), 'should extract company name');
});

test('organization-extractor: extracts org from email domain', async () => {
  const mockContact = {
    id: 'bob@techcorp.io',
    company: null,
    email_domain: 'techcorp.io',
    summary: ''
  };

  const { organizations, contactLinks } = await extractOrganizations([mockContact], 'contacts');
  assert.ok(organizations.some(o => o.domain === 'techcorp.io'), 'should extract from email domain');
});

test('organization-extractor: extracts org from summary text patterns', async () => {
  const mockContact = {
    id: 'charlie@example.com',
    company: null,
    summary: 'Works at Google on the Cloud division'
  };

  const { organizations } = await extractOrganizations([mockContact], 'contacts');
  assert.ok(organizations.some(o => o.name.includes('Google')), 'should extract org from text');
});

test('organization-extractor: extracts org-like WhatsApp group names', async () => {
  const mockGroup = {
    id: 'group_1',
    name: 'Acme Product Team',
    topic: 'Product development'
  };

  const { organizations } = await extractOrganizations([mockGroup], 'groups');
  assert.ok(organizations.length > 0, 'should extract org-like group names');
});

test('organization-extractor: extracts both company and email domain when both exist', async () => {
  const mockContact = {
    id: 'alice@example.com',
    company: 'Acme Corporation',
    email_domain: 'acme.com'
  };

  const { organizations } = await extractOrganizations([mockContact], 'contacts');
  assert.ok(organizations.some(o => o.name === 'Acme Corporation' && o.domain === 'acme.com'), 'should extract company with domain');
  assert.ok(organizations.some(o => o.name === 'ACME' && o.domain === 'acme.com'), 'should extract email domain independently');
  assert.strictEqual(organizations.length, 2, 'should extract both company and email domain (different names create separate orgs)');
});
