// packages/sampler/ollama-ps.js
'use strict'

const { exec } = require('child_process')

/**
 * Returns loaded Ollama models from `ollama ps`.
 */
function getLoadedModels() {
  return new Promise((resolve) => {
    exec('ollama ps', (err, stdout) => {
      if (err) return resolve([])
      const models = stdout.split('\n').slice(1)
        .filter(l => l.trim())
        .map(line => {
          const parts = line.trim().split(/\s{2,}/)
          return {
            model:     parts[0] || null,
            size:      parts[1] || null,
            processor: parts[2] || null,
            until:     parts[3] || null,
          }
        })
        .filter(m => m.model)
      resolve(models)
    })
  })
}

module.exports = { getLoadedModels }
