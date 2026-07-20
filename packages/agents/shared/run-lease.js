'use strict'

/**
 * Hold a PostgreSQL advisory lock on a dedicated connection for the complete
 * lifetime of an analysis run. The caller may use the normal pool for work;
 * releasing this lease is what makes another process eligible to start.
 */
async function acquireRunLease(pool, lockId) {
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [String(lockId)],
    )
    if (rows[0]?.acquired !== true) {
      client.release()
      return { acquired: false, release: async () => {} }
    }
  } catch (error) {
    client.release()
    throw error
  }

  let released = false
  return {
    acquired: true,
    async release() {
      if (released) return
      released = true
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [String(lockId)])
      } finally {
        client.release()
      }
    },
  }
}

module.exports = { acquireRunLease }
