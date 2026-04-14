// packages/telemetry/index.js
'use strict'

const os     = require('os')
const crypto = require('crypto')
const { generateId }      = require('./ids')
const { shouldStoreFull } = require('./sampling')
const writer  = require('./writer')
const { createBuffer, DEFAULT_SPILL_DIR } = require('@secondbrain/telemetry-buffer')

// One buffer per process (shared across all agents in a process)
let _buffer    = null
let _agentName = 'unknown'

function _getBuffer() {
  if (!_buffer) {
    _buffer = createBuffer({ agentName: _agentName, spillDir: DEFAULT_SPILL_DIR })
    _buffer.start(writer.writeBatch)
  }
  return _buffer
}

function _hashPreview(text, maxLen = 500) {
  if (!text) return { hash: null, preview: null, chars: 0 }
  const str  = typeof text === 'string' ? text : JSON.stringify(text)
  const hash = crypto.createHash('sha256').update(str).digest('hex').slice(0, 16)
  return { hash, preview: str.slice(0, maxLen), chars: str.length }
}

/**
 * Register the agent name for this process. Call once at agent startup.
 */
function init(agentName) {
  _agentName = agentName
  if (_buffer) _buffer.stop()
  _buffer = null  // will recreate with new name on next use
}

/**
 * Record the start of an agent run. Returns runId string.
 */
async function startRun({ agentId, workflowName, pid, configVersion } = {}) {
  const runId = generateId()
  _getBuffer().enqueue({
    _type: 'agent_run_update',
    action: 'start',
    runId,
    agentName: agentId || _agentName,
    workflowName: workflowName || null,
    startedAt: new Date().toISOString(),
    hostName: os.hostname(),
    pid: pid || process.pid,
    configVersion: configVersion || null,
  })
  return runId
}

/**
 * Record the end of an agent run.
 */
async function endRun(runId, { status = 'completed' } = {}) {
  _getBuffer().enqueue({
    _type: 'agent_run_update',
    action: 'end',
    runId,
    endedAt: new Date().toISOString(),
    status,
  })
}

/**
 * Begin timing an LLM request. Returns handle with finish() method.
 */
function startRequest({
  agentId,
  runId        = null,
  taskType     = null,
  model        = null,
  providerType = null,
  prompt       = null,
  streamMode   = false,
  workflowName = null,
} = {}) {
  const requestId = generateId()
  const traceId   = generateId()
  const startedAt = new Date()
  const { hash: promptHash, preview: promptPreview, chars: inputChars } = _hashPreview(prompt)

  return {
    requestId,
    traceId,

    finish({
      tokensIn     = null,
      tokensOut    = null,
      success      = true,
      errorType    = null,
      retryCount   = 0,
      output       = null,
      debugMode    = false,
      jsonFailed   = false,
      qualityScore = null,
    } = {}) {
      const endedAt    = new Date()
      const durationMs = endedAt - startedAt
      const { hash: outputHash, preview: outputPreview, chars: outputChars } = _hashPreview(output)

      const storeFull = shouldStoreFull({ success, retryCount, debugMode, jsonFailed, qualityScore })

      _getBuffer().enqueue({
        _type: 'llm_request',
        requestId,
        traceId,
        runId,
        agentName: agentId || _agentName,
        workflowName,
        taskType,
        model,
        providerType,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
        promptTokens: tokensIn,
        completionTokens: tokensOut,
        inputChars,
        outputChars,
        success,
        errorType,
        retryCount,
        streamMode,
        promptHash,
        outputHash,
        promptPreview,
        outputPreview,
        fullTraceStored: storeFull,
      })

      if (storeFull) {
        _getBuffer().enqueue({
          _type: 'llm_request_sample',
          requestId,
          fullPrompt: typeof prompt === 'string' ? prompt : JSON.stringify(prompt),
          fullOutput: typeof output === 'string' ? output : JSON.stringify(output),
        })
      }

      return { requestId, durationMs }
    },
  }
}

/**
 * Emit a work-progress update for a stage.
 */
function progress(runId, stageName, { completed = 0, total = null, failed = 0, skipped = 0 } = {}) {
  _getBuffer().enqueue({
    _type: 'work_progress',
    runId,
    stageName,
    completed,
    total,
    failed,
    skipped,
  })
}

/**
 * Record a quality score for a request.
 */
function recordQuality({ requestId, evaluationType, scoreNumeric, scoreLabel, evaluator, notes } = {}) {
  _getBuffer().enqueue({
    _type: 'quality_score',
    requestId,
    evaluationType,
    scoreNumeric,
    scoreLabel,
    evaluator,
    notes,
  })
}

/**
 * Flush the in-memory buffer to DB immediately.
 */
async function flush() {
  if (_buffer) await _buffer.drain(writer.writeBatch)
}

/**
 * Expose current buffer counters for health checks.
 */
function counters() {
  return _buffer ? _buffer.counts() : { emitted: 0, dropped: 0, written: 0, failed: 0 }
}

module.exports = { init, startRun, endRun, startRequest, progress, recordQuality, flush, counters }
