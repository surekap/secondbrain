// packages/telemetry/writer.js
'use strict'
const db = require('@secondbrain/db')

async function writeBatch(events) {
  if (!events || events.length === 0) return

  const requests = events.filter(e => e._type === 'llm_request')
  const samples  = events.filter(e => e._type === 'llm_request_sample')
  const runs     = events.filter(e => e._type === 'agent_run_update')
  const progress = events.filter(e => e._type === 'work_progress')
  const quality  = events.filter(e => e._type === 'quality_score')

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    for (const r of requests) {
      await client.query(`
        INSERT INTO telemetry.llm_requests (
          request_id, trace_id, run_id, agent_name, workflow_name, task_type,
          model, provider_type, started_at, ended_at, duration_ms,
          prompt_tokens, completion_tokens, total_tokens,
          input_chars, output_chars, success, error_type, retry_count,
          stream_mode, prompt_hash, output_hash, prompt_preview, output_preview,
          full_trace_stored
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,$25
        ) ON CONFLICT (request_id) DO NOTHING
      `, [
        r.requestId, r.traceId, r.runId || null, r.agentName, r.workflowName || null,
        r.taskType || null, r.model || null, r.providerType || null,
        r.startedAt, r.endedAt || null, r.durationMs || null,
        r.promptTokens || null, r.completionTokens || null,
        (r.promptTokens || 0) + (r.completionTokens || 0) || null,
        r.inputChars || null, r.outputChars || null,
        r.success != null ? r.success : null, r.errorType || null,
        r.retryCount || 0, r.streamMode || false,
        r.promptHash || null, r.outputHash || null,
        r.promptPreview || null, r.outputPreview || null,
        r.fullTraceStored || false,
      ])
    }

    for (const s of samples) {
      await client.query(`
        INSERT INTO telemetry.llm_request_samples (request_id, full_prompt, full_output)
        VALUES ($1, $2, $3) ON CONFLICT (request_id) DO NOTHING
      `, [s.requestId, s.fullPrompt || null, s.fullOutput || null])
    }

    for (const run of runs) {
      if (run.action === 'start') {
        await client.query(`
          INSERT INTO telemetry.agent_runs (run_id, agent_name, workflow_name, started_at, status, host_name, pid, config_version)
          VALUES ($1,$2,$3,$4,'running',$5,$6,$7) ON CONFLICT (run_id) DO NOTHING
        `, [run.runId, run.agentName, run.workflowName || null, run.startedAt, run.hostName || null, run.pid || null, run.configVersion || null])
      } else if (run.action === 'end') {
        await client.query(`
          UPDATE telemetry.agent_runs SET ended_at=$2, status=$3 WHERE run_id=$1
        `, [run.runId, run.endedAt, run.status || 'completed'])
      }
    }

    for (const p of progress) {
      await client.query(`
        INSERT INTO telemetry.work_progress (run_id, stage_name, units_total, units_completed, units_failed, units_skipped, rate_units_per_min, eta_seconds, last_updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (run_id, stage_name) DO UPDATE SET
          units_total        = EXCLUDED.units_total,
          units_completed    = EXCLUDED.units_completed,
          units_failed       = EXCLUDED.units_failed,
          units_skipped      = EXCLUDED.units_skipped,
          rate_units_per_min = EXCLUDED.rate_units_per_min,
          eta_seconds        = EXCLUDED.eta_seconds,
          last_updated_at    = NOW()
      `, [p.runId, p.stageName, p.total || null, p.completed || 0, p.failed || 0, p.skipped || 0, p.rate || null, p.eta || null])
    }

    for (const q of quality) {
      await client.query(`
        INSERT INTO telemetry.quality_scores (request_id, evaluation_type, score_numeric, score_label, evaluator, notes)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [q.requestId, q.evaluationType, q.scoreNumeric || null, q.scoreLabel || null, q.evaluator || null, q.notes || null])
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function updateCounters(agentName, counts) {
  try {
    for (const [name, value] of Object.entries(counts)) {
      await db.query(`
        INSERT INTO telemetry.counters (agent_name, counter_name, value, last_updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (agent_name, counter_name) DO UPDATE
          SET value = telemetry.counters.value + EXCLUDED.value,
              last_updated_at = NOW()
      `, [agentName, name, value])
    }
  } catch (_) {
    // Counter update failure is non-critical
  }
}

module.exports = { writeBatch, updateCounters }
