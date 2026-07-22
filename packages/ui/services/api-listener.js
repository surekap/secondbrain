'use strict';

const net = require('node:net');
const os = require('node:os');

function isTailnetIPv4(address) {
  if (!net.isIPv4(address)) return false;
  const octets = address.split('.').map(Number);
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function findTailnetIPv4() {
  const configured = String(process.env.SECOND_BRAIN_TAILSCALE_IP || '').trim();
  if (configured) {
    if (!isTailnetIPv4(configured)) {
      throw new Error('SECOND_BRAIN_TAILSCALE_IP must be a Tailscale IPv4 address in 100.64.0.0/10');
    }
    return configured;
  }
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && isTailnetIPv4(address.address)) {
        return address.address;
      }
    }
  }
  return null;
}

function listenOnHosts(app, port, hosts, onReady) {
  const uniqueHosts = [...new Set(hosts.filter(Boolean))];
  const servers = [];
  return new Promise((resolve, reject) => {
    if (uniqueHosts.length === 0) return reject(new Error('No API bind hosts configured'));
    let remaining = uniqueHosts.length;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      for (const server of servers) server.close();
      reject(error);
    };
    for (const host of uniqueHosts) {
      const server = app.listen(port, host, () => {
        servers.push(server);
        remaining -= 1;
        if (remaining === 0 && !settled) {
          settled = true;
          onReady?.(uniqueHosts);
          resolve(servers);
        }
      });
      server.once('error', fail);
    }
  });
}

module.exports = { findTailnetIPv4, isTailnetIPv4, listenOnHosts };
