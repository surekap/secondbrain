// packages/sampler/process-stats.js
'use strict'

const { exec } = require('child_process')

/**
 * Returns CPU% and RSS MB for processes whose command line matches namePattern.
 */
function getProcessStats(namePattern) {
  return new Promise((resolve) => {
    exec('ps aux', (err, stdout) => {
      if (err) return resolve([])
      const results = []
      for (const line of stdout.split('\n').slice(1)) {
        if (!line.includes(namePattern)) continue
        const parts = line.trim().split(/\s+/)
        // USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
        const pid   = parseInt(parts[1], 10)
        const cpu   = parseFloat(parts[2])
        const rssMb = Math.round(parseInt(parts[5], 10) / 1024)
        const name  = parts.slice(10).join(' ').slice(0, 80)
        if (!isNaN(pid)) results.push({ pid, name, cpu, rss_mb: rssMb })
      }
      resolve(results)
    })
  })
}

module.exports = { getProcessStats }
