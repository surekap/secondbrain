// packages/telemetry/sampling.js
'use strict'

/**
 * Decide whether to store full prompt/output for a request.
 */
function shouldStoreFull({
  success,
  retryCount,
  sampleRate       = 0.02,
  debugMode        = false,
  jsonFailed       = false,
  qualityScore     = null,
  qualityThreshold = 0.5,
}) {
  if (!success)                                                  return true
  if (retryCount > 0)                                            return true
  if (debugMode)                                                 return true
  if (jsonFailed)                                                return true
  if (qualityScore != null && qualityScore < qualityThreshold)   return true
  if (sampleRate > 0 && Math.random() < sampleRate)              return true
  return false
}

module.exports = { shouldStoreFull }
