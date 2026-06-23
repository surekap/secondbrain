'use strict'

const db = require('@secondbrain/db')

/**
 * Cache for processed items to avoid redundant LLM calls
 * Tracks: what's been processed, when, and whether it has new activity
 */

/**
 * Create cache entry for processed item
 * @param {string} agentId - Which agent processed this
 * @param {string} itemType - Type of item (contact, email, project, etc)
 * @param {string} itemId - Unique ID of the item
 * @param {Object} metadata - Additional metadata to store
 */
async function recordProcessed(agentId, itemType, itemId, metadata = {}) {
  try {
    await db.query(`
      INSERT INTO system.agent_cache (agent_id, item_type, item_id, processed_at, metadata)
      VALUES ($1, $2, $3, NOW(), $4)
      ON CONFLICT (agent_id, item_type, item_id) DO UPDATE
      SET processed_at = NOW(), metadata = $4
    `, [agentId, itemType, itemId, JSON.stringify(metadata)])
  } catch (err) {
    console.warn(`[caching] recordProcessed failed: ${err.message}`)
  }
}

/**
 * Check if item was processed recently and has no new activity
 * @param {string} agentId
 * @param {string} itemType
 * @param {string} itemId
 * @param {Date} lastActivityAt - When was the item last modified?
 * @returns {Promise<boolean>} true if item was processed and has no new activity
 */
async function hasNoNewActivity(agentId, itemType, itemId, lastActivityAt) {
  if (!lastActivityAt) return false

  try {
    const { rows } = await db.query(`
      SELECT processed_at FROM system.agent_cache
      WHERE agent_id = $1 AND item_type = $2 AND item_id = $3
      LIMIT 1
    `, [agentId, itemType, itemId])

    if (rows.length === 0) return false

    const processedAt = new Date(rows[0].processed_at)
    const activityAt = new Date(lastActivityAt)

    // Item was processed after last activity — no new changes
    return processedAt >= activityAt
  } catch (err) {
    console.warn(`[caching] hasNoNewActivity check failed: ${err.message}`)
    return false
  }
}

/**
 * Get items that need processing (skip cached items with no new activity)
 * @param {string} agentId
 * @param {string} itemType
 * @param {Array} items - Items with id and lastActivityAt fields
 * @returns {Promise<Array>} Filtered list of items needing processing
 */
async function filterUnprocessedItems(agentId, itemType, items) {
  if (items.length === 0) return []

  try {
    const itemIds = items.map(i => i.id || i.item_id)

    const { rows } = await db.query(`
      SELECT item_id, processed_at FROM system.agent_cache
      WHERE agent_id = $1 AND item_type = $2 AND item_id = ANY($3)
    `, [agentId, itemType, itemIds])

    // Build map of cached items
    const cachedMap = new Map()
    for (const row of rows) {
      cachedMap.set(row.item_id, new Date(row.processed_at))
    }

    // Filter items: keep if not cached OR if it has new activity since cached
    return items.filter(item => {
      const itemId = item.id || item.item_id
      const processedAt = cachedMap.get(itemId)

      if (!processedAt) {
        // Not cached, needs processing
        return true
      }

      // Check if has new activity
      const lastActivity = item.last_activity_at || item.lastActivityAt || item.last_msg_at || item.last_email_at
      if (!lastActivity) {
        // No activity timestamp, skip to be safe
        return false
      }

      const activityAt = new Date(lastActivity)
      // Process if activity is newer than cache
      return activityAt > processedAt
    })
  } catch (err) {
    console.warn(`[caching] filterUnprocessedItems failed: ${err.message}`)
    // On error, process everything to be safe
    return items
  }
}

/**
 * Clear cache for an agent
 * @param {string} agentId
 */
async function clearCache(agentId) {
  try {
    await db.query(`
      DELETE FROM system.agent_cache WHERE agent_id = $1
    `, [agentId])
  } catch (err) {
    console.warn(`[caching] clearCache failed: ${err.message}`)
  }
}

/**
 * Get cache statistics
 * @param {string} agentId
 * @returns {Promise<Object>} Cache stats
 */
async function getStats(agentId) {
  try {
    const { rows } = await db.query(`
      SELECT item_type, COUNT(*) as count,
             MAX(processed_at) as last_processed
      FROM system.agent_cache
      WHERE agent_id = $1
      GROUP BY item_type
    `, [agentId])

    return {
      byType: rows.reduce((acc, r) => {
        acc[r.item_type] = {
          count: parseInt(r.count),
          lastProcessed: r.last_processed,
        }
        return acc
      }, {}),
    }
  } catch (err) {
    console.warn(`[caching] getStats failed: ${err.message}`)
    return { byType: {} }
  }
}

module.exports = {
  recordProcessed,
  hasNoNewActivity,
  filterUnprocessedItems,
  clearCache,
  getStats,
}
