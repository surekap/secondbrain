'use strict'

/**
 * Batching utility for parallel processing
 * Processes items in configurable batch sizes with parallelization
 */

/**
 * Process items in parallel batches
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function to call for each item, returns result or null
 * @param {Object} options - Configuration
 *   @param {number} batchSize - Number of items to process in parallel (default: 10)
 *   @param {number} delayBetweenBatches - Delay in ms between batches (default: 0)
 *   @param {Function} onBatchComplete - Called after each batch completes
 * @returns {Promise<Array>} Results array
 */
async function processBatch(items, processor, options = {}) {
  const {
    batchSize = 10,
    delayBetweenBatches = 0,
    onBatchComplete = null,
  } = options

  const results = []
  const totalBatches = Math.ceil(items.length / batchSize)

  for (let batchIdx = 0; batchIdx < items.length; batchIdx += batchSize) {
    const batchNum = Math.floor(batchIdx / batchSize) + 1
    const batch = items.slice(batchIdx, batchIdx + batchSize)

    // Process all items in batch in parallel
    const batchResults = await Promise.all(
      batch.map(item => {
        try {
          return processor(item)
        } catch (err) {
          // Return error as result, don't throw
          return { error: err, item }
        }
      })
    )

    results.push(...batchResults)

    // Call batch complete callback
    if (onBatchComplete) {
      onBatchComplete({
        batchNum,
        totalBatches,
        itemsInBatch: batch.length,
        successCount: batchResults.filter(r => !r?.error).length,
        errorCount: batchResults.filter(r => r?.error).length,
      })
    }

    // Delay between batches (except after last)
    if (batchIdx + batchSize < items.length && delayBetweenBatches > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches))
    }
  }

  return results
}

/**
 * Process items with rate limiting (for API calls)
 * @param {Array} items - Items to process
 * @param {Function} processor - Async function for each item
 * @param {Object} options
 *   @param {number} concurrency - Max concurrent operations (default: 3)
 *   @param {number} delayMs - Delay between each operation (default: 0)
 * @returns {Promise<Array>} Results array
 */
async function processWithConcurrency(items, processor, options = {}) {
  const {
    concurrency = 3,
    delayMs = 0,
  } = options

  const results = []
  const inProgress = new Set()

  for (const item of items) {
    // Wait if we've hit concurrency limit
    while (inProgress.size >= concurrency) {
      await Promise.race(inProgress)
    }

    // Start processing this item
    const promise = (async () => {
      try {
        const result = await processor(item)
        results.push(result)
        return result
      } catch (err) {
        results.push({ error: err, item })
        return { error: err }
      }
    })()

    inProgress.add(promise)
    promise.finally(() => {
      inProgress.delete(promise)
    })

    // Add delay if configured
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  // Wait for remaining
  if (inProgress.size > 0) {
    await Promise.all(inProgress)
  }

  return results
}

module.exports = {
  processBatch,
  processWithConcurrency,
}
