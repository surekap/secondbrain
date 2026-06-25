'use strict'

const { execSync } = require('child_process')
const path         = require('path')

function _isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Marks telemetry.agent_runs rows as 'failed' when their recorded PID is no
 * longer alive. Call once at agent startup, before recording a new run.
 *
 * @param {object} db        - pg Pool (must have a .query() method)
 * @param {string} agentName - value stored in agent_runs.agent_name
 * @param {object} [log]     - optional logger with .info() / .warn()
 */
async function cleanupOrphanedRuns(db, agentName, log) {
  const info = (m) => log ? log.info(m)  : console.log(m)
  const warn = (m) => log ? log.warn(m)  : console.warn(m)
  try {
    const { rows } = await db.query(
      `SELECT run_id, pid FROM telemetry.agent_runs
       WHERE agent_name = $1 AND status = 'running' AND ended_at IS NULL`,
      [agentName]
    )
    if (!rows.length) return
    const orphaned = rows.filter(r => !r.pid || !_isPidAlive(r.pid))
    if (!orphaned.length) return
    await db.query(
      `UPDATE telemetry.agent_runs
       SET status = 'failed', ended_at = NOW()
       WHERE run_id = ANY($1::text[])`,
      [orphaned.map(r => r.run_id)]
    )
    info(`Cleaned up ${orphaned.length} orphaned ${agentName} run(s)`)
  } catch (err) {
    warn(`Orphaned run cleanup failed: ${err.message}`)
  }
}

/**
 * Scans running OS processes for any that are executing the same script as the
 * current process and sends SIGTERM to all of them except this process.
 * Prevents duplicate agent instances from accumulating.
 *
 * @param {string} [scriptPath] - defaults to process.argv[1]
 * @param {object} [log]        - optional logger with .info() / .warn()
 */
function killDuplicateProcesses(scriptPath, log) {
  const info = (m) => log ? log.info(m)  : console.log(m)
  const warn = (m) => log ? log.warn(m)  : console.warn(m)
  const script = scriptPath || process.argv[1]
  const rel    = path.relative(process.cwd(), script)
  const myPid  = process.pid
  try {
    const out = execSync('ps ax -o pid,command', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const duplicates = []
    for (const line of out.split('\n')) {
      if (!line.includes(script) && !line.includes(rel)) continue
      const pid = parseInt(line.trim().split(/\s+/)[0], 10)
      if (!isNaN(pid) && pid !== myPid) duplicates.push(pid)
    }
    for (const pid of duplicates) {
      try {
        process.kill(pid, 'SIGTERM')
        info(`Killed duplicate process (pid ${pid})`)
      } catch (err) {
        warn(`Could not kill duplicate pid ${pid}: ${err.message}`)
      }
    }
  } catch (err) {
    warn(`Duplicate process check failed: ${err.message}`)
  }
}

module.exports = { cleanupOrphanedRuns, killDuplicateProcesses }
