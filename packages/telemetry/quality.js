// packages/telemetry/quality.js
'use strict'

/**
 * Run automatic structural quality checks on an LLM output.
 * Returns { score: 0.0–1.0, issues: string[] }
 */
function scoreStructural(output, { expectJson = false, schema = null } = {}) {
  const issues = []
  if (!output || output.trim().length === 0) {
    return { score: 0, issues: ['empty output'] }
  }

  if (!expectJson) {
    return { score: 1, issues: [] }
  }

  let parsed = null
  try {
    // Handle markdown code blocks
    const raw = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
    parsed = JSON.parse(raw)
  } catch (_) {
    issues.push('invalid JSON')
    return { score: 0, issues }
  }

  if (parsed === null) {
    issues.push('null output')
    return { score: 0.1, issues }
  }

  // Schema compliance: required top-level keys
  if (schema && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(key in parsed)) issues.push(`missing required key: ${key}`)
    }
  }

  // Truncation heuristic
  const str = typeof output === 'string' ? output : JSON.stringify(output)
  if (str.length > 100 && !str.trimEnd().endsWith('}') && !str.trimEnd().endsWith(']')) {
    issues.push('possible truncation')
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0.1, 1 - issues.length * 0.25)
  return { score: parseFloat(score.toFixed(2)), issues }
}

module.exports = { scoreStructural }
