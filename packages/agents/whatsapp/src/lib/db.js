'use strict';

const { Pool } = require('pg');

// SSL is required for CockroachDB/remote Postgres but must be disabled for local Postgres.
// Set DATABASE_SSL=false to disable (default: enabled when connection string contains 'ssl').
const connStr = process.env.DATABASE_URL ?? '';
const sslEnv  = process.env.DATABASE_SSL;

let ssl;
if (sslEnv === 'false') {
  ssl = false;
} else if (sslEnv === 'true' || connStr.includes('sslmode=require') || connStr.includes('cockroachdb')) {
  ssl = { rejectUnauthorized: true };
} else {
  ssl = false;
}

const pool = new Pool({ connectionString: connStr, ssl });

// Always use the public schema regardless of the database user's search_path setting.
// Defer to next event loop to avoid concurrent query deprecation warning
pool.on('connect', (client) => {
  setImmediate(() => {
    client.query("SET search_path TO public").catch(err => {
      // Silently ignore if this fails (e.g., some users may not have permissions)
    });
  });
});

module.exports = pool;
