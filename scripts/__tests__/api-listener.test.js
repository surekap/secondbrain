'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isTailnetIPv4 } = require('../../packages/ui/services/api-listener');

test('recognises only Tailscale IPv4 addresses', () => {
  assert.equal(isTailnetIPv4('100.105.11.84'), true);
  assert.equal(isTailnetIPv4('100.63.255.1'), false);
  assert.equal(isTailnetIPv4('192.168.1.20'), false);
  assert.equal(isTailnetIPv4('not-an-ip'), false);
});
