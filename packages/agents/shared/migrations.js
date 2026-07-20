'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MIGRATION_LOCK_ID = 20720260720
const MIGRATION_FILE_PATTERN = /^(\d{12,})_([a-z0-9][a-z0-9_-]*)\.sql$/

function checksumSql(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
}

function loadSqlMigrations(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => {
      const match = entry.name.match(MIGRATION_FILE_PATTERN)
      if (!match) {
        throw new Error(`Invalid migration filename: ${entry.name}`)
      }
      const sql = fs.readFileSync(path.join(directory, entry.name), 'utf8')
      return {
        version: match[1],
        name: match[2],
        sql,
      }
    })
    .sort((left, right) => left.version.localeCompare(right.version))
}

function normalizeMigrations(migrations) {
  const normalized = migrations.map(migration => {
    if (!migration?.version || !migration?.name || typeof migration.sql !== 'string') {
      throw new Error('Each migration requires version, name, and SQL')
    }
    return {
      ...migration,
      version: String(migration.version),
      checksum: checksumSql(migration.sql),
    }
  }).sort((left, right) => left.version.localeCompare(right.version))

  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index - 1].version === normalized[index].version) {
      throw new Error(`Duplicate migration version: ${normalized[index].version}`)
    }
  }
  return normalized
}

function migrationFailure(migration, error, ledgerError = null) {
  const suffix = ledgerError ? `; additionally failed to record ledger error: ${ledgerError.message}` : ''
  return new Error(`Migration ${migration.version}_${migration.name} failed: ${error.message}${suffix}`, { cause: error })
}

async function runMigrations(pool, migrations, options = {}) {
  if (!pool) throw new Error('Migration database is required')
  const ordered = normalizeMigrations(migrations)
  if (ordered.length === 0) return { applied: [], skipped: [] }

  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function'
    ? () => client.release()
    : () => {}
  const lockId = options.lockId || MIGRATION_LOCK_ID
  let locked = false
  const result = { applied: [], skipped: [] }

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [String(lockId)])
    locked = true

    for (const migration of ordered) {
      const existing = await client.query(`
        SELECT version, name, checksum, status
        FROM system.schema_migrations
        WHERE version = $1
      `, [migration.version])
      const record = existing.rows[0]

      if (record && record.checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum drift for ${migration.version}: recorded ${record.checksum}, current ${migration.checksum}`,
        )
      }
      if (record?.status === 'completed') {
        result.skipped.push(migration.version)
        continue
      }

      await client.query(`
        INSERT INTO system.schema_migrations (
          version, name, checksum, status, started_at, completed_at, error, attempt_count
        ) VALUES ($1, $2, $3, 'running', NOW(), NULL, NULL, 1)
        ON CONFLICT (version) DO UPDATE SET
          name = EXCLUDED.name,
          status = 'running',
          started_at = NOW(),
          completed_at = NULL,
          error = NULL,
          attempt_count = system.schema_migrations.attempt_count + 1
      `, [migration.version, migration.name, migration.checksum])

      try {
        await client.query('BEGIN')
        await client.query(migration.sql)
        await client.query(`
          UPDATE system.schema_migrations
          SET status = 'completed', completed_at = NOW(), error = NULL
          WHERE version = $1
        `, [migration.version])
        await client.query('COMMIT')
        result.applied.push(migration.version)
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        let ledgerError = null
        try {
          await client.query(`
            UPDATE system.schema_migrations
            SET status = 'failed', completed_at = NULL, error = $2
            WHERE version = $1
          `, [migration.version, String(error.message || error).slice(0, 4000)])
        } catch (recordError) {
          ledgerError = recordError
        }
        throw migrationFailure(migration, error, ledgerError)
      }
    }

    return result
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [String(lockId)])
      } catch (_) {}
    }
    release()
  }
}

module.exports = {
  MIGRATION_FILE_PATTERN,
  MIGRATION_LOCK_ID,
  checksumSql,
  loadSqlMigrations,
  normalizeMigrations,
  runMigrations,
}
