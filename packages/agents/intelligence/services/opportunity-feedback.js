'use strict'

const VALID_ACTIONS = new Set(['wrong_person','wrong_project','already_closed','not_useful','suppress_pattern'])
const PATCHABLE = new Set(['status','priority','recommended_next_action','snoozed_until','expires_at','feedback','feedback_note'])

function lifecycleForStatus(status) {
  if (status === 'actioned') return 'resolved'
  if (status === 'dismissed') return 'dismissed'
  if (status === 'expired') return 'expired'
  return 'active'
}

function feedbackForAction(action) {
  if (action === 'already_closed') return 'too_late'
  if (action === 'not_useful') return 'not_useful'
  return 'false_positive'
}

async function applyOpportunityFeedback(pool, opportunityId, input = {}) {
  if (!pool?.query) throw new Error('A database query interface is required')
  const action = String(input.action || input.feedback_action || '').trim()
  if (action && !VALID_ACTIONS.has(action)) throw new Error('Invalid feedback action')
  const updates = Object.fromEntries(Object.entries(input.updates || input).filter(([key]) => PATCHABLE.has(key)))
  const isLinkCorrection = action === 'wrong_person' || action === 'wrong_project'
  if (action) {
    if (!isLinkCorrection) {
      updates.feedback = updates.feedback || feedbackForAction(action)
      updates.status = action === 'already_closed' ? 'actioned' : 'dismissed'
    } else {
      delete updates.status
      delete updates.feedback
    }
    updates.feedback_note = updates.feedback_note || input.note || null
  }
  if (!Object.keys(updates).length && !action) throw new Error('Nothing to update')

  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = client !== pool && typeof client.release === 'function' ? () => client.release() : () => {}
  try {
    await client.query('BEGIN')
    const currentResult = await client.query('SELECT * FROM intelligence.opportunities WHERE id = $1 FOR UPDATE', [opportunityId])
    const current = currentResult.rows[0]
    if (!current) {
      await client.query('ROLLBACK')
      return null
    }

    const correction = {}
    if (action === 'wrong_person' && current.primary_contact_id) {
      correction.removed_contact_id = current.primary_contact_id
      await client.query('DELETE FROM intelligence.opportunity_contacts WHERE opportunity_id = $1 AND contact_id = $2', [opportunityId, current.primary_contact_id])
      updates.primary_contact_id = null
    }
    if (action === 'wrong_project' && current.primary_project_id) {
      correction.removed_project_id = current.primary_project_id
      await client.query('DELETE FROM intelligence.opportunity_projects WHERE opportunity_id = $1 AND project_id = $2', [opportunityId, current.primary_project_id])
      updates.primary_project_id = null
    }

    if (updates.status) updates.lifecycle_state = lifecycleForStatus(updates.status)
    const allowedColumns = new Set([...PATCHABLE, 'primary_contact_id','primary_project_id','lifecycle_state'])
    const entries = Object.entries(updates).filter(([key]) => allowedColumns.has(key))
    const values = []
    const clauses = entries.map(([key, value], index) => {
      values.push(value)
      return `${key} = $${index + 1}`
    })
    if (updates.status === 'actioned') clauses.push('actioned_at = NOW()')
    if (updates.status === 'dismissed') clauses.push('dismissed_at = NOW()')
    clauses.push('updated_at = NOW()')
    values.push(opportunityId)
    const updated = await client.query(`
      UPDATE intelligence.opportunities
      SET ${clauses.join(', ')}
      WHERE id = $${values.length}
      RETURNING *
    `, values)

    let feedbackEvent = null
    if (action || updates.feedback) {
      const event = await client.query(`
        INSERT INTO intelligence.opportunity_feedback_events (opportunity_id, feedback, note, action, metadata)
        VALUES ($1,$2,$3,$4,$5::jsonb)
        RETURNING *
      `, [
        opportunityId,
        updates.feedback || feedbackForAction(action),
        updates.feedback_note || input.note || null,
        action || null,
        JSON.stringify({ link_correction: correction }),
      ])
      feedbackEvent = event.rows[0] || null
    }
    await client.query('COMMIT')
    return { opportunity: updated.rows[0], feedback_event: feedbackEvent, link_correction: correction }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (_) {}
    throw error
  } finally {
    release()
  }
}

module.exports = { VALID_ACTIONS, applyOpportunityFeedback, feedbackForAction, lifecycleForStatus }
