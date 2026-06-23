# Batching & Caching Implementation Guide

## Overview

Two key optimizations have been implemented to dramatically improve agent performance:

1. **Parallel Batching** — Process multiple items simultaneously instead of sequentially
2. **Smart Caching** — Skip items that haven't changed since last analysis

**Expected improvements**:
- Email processing: 17 hours → 2-3 hours (5-10x speedup)
- Relationships incremental: 5 min → 2-3 min (60% reduction)
- Projects discovery: 15 min → 10 min (25% reduction)

---

## What Changed

### 1. New Shared Utilities

#### `packages/agents/shared/batching.js`
Provides two functions for parallel processing:

```javascript
// Process items in parallel batches
const results = await processBatch(items, processor, {
  batchSize: 10,              // Process 10 items simultaneously
  delayBetweenBatches: 0,     // Delay between batches (ms)
  onBatchComplete: callback   // Called after each batch
});

// Example usage in relationships agent:
const results = await batching.processBatch(
  contactsToAnalyze,
  async (contact) => {
    // Process individual contact (parallel with others)
    const profile = await analyzer.analyzeDirectChatContact(contact.chat_id);
    return { success: true };
  },
  {
    batchSize: 5,
    onBatchComplete: (info) => {
      console.log(`Batch ${info.batchNum}/${info.totalBatches}: ${info.successCount} done`);
    }
  }
);
```

#### `packages/agents/shared/caching.js`
Tracks processed items to avoid redundant work:

```javascript
// Record that an item was processed
await caching.recordProcessed(agentId, itemType, itemId, metadata);

// Check if item needs re-processing
const needsProcessing = await caching.hasNoNewActivity(
  'relationships',
  'direct_contact',
  contactId,
  lastActivityTime
);

// Filter items that have changed since last processing
const itemsNeedingUpdate = await caching.filterUnprocessedItems(
  'relationships',
  'email_sender',
  allSenders  // Only returns senders with new activity
);

// Get cache stats
const stats = await caching.getStats('relationships');
console.log(stats);
// Output: { byType: { direct_contact: { count: 42, lastProcessed: '...' } } }
```

#### `packages/agents/shared/sql/system-schema.sql`
New table created:

```sql
CREATE TABLE system.agent_cache (
  agent_id    TEXT NOT NULL,
  item_type   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL,
  metadata    JSONB
);
```

### 2. Updated Agents

#### Relationships Agent (`packages/agents/relationships/index.js`)

**Before**:
```javascript
// Sequential processing
for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
  const batch = contacts.slice(i, i + BATCH_SIZE);
  for (const contact of batch) {  // ← Sequential within batch
    await analyzer.analyzeDirectChatContact(...);
  }
}
```

**After**:
```javascript
// Parallel batching with caching
const contactsNeedingAnalysis = await caching.filterUnprocessedItems(
  'relationships', 'direct_contact', meaningfulContacts
);

const results = await batching.processBatch(
  contactsNeedingAnalysis,
  async (contact) => {
    return await analyzer.analyzeDirectChatContact(...);
  },
  {
    batchSize: 5,  // Process 5 in parallel
    onBatchComplete: updateProgress
  }
);
```

**Benefits**:
- 5 contacts analyzed in parallel (one LLM call takes ~3s, so 5 in parallel = ~3s total vs 15s sequential)
- Caching skips contacts with no new messages
- Progress updates as batches complete

#### Email Agent (`packages/agents/email/cron/fetchEmails.js`)

**Before**:
```javascript
for (const uid of batch) {
  const source = await gmailClient.fetchMessage(uid);
  await parseEmail(source);
  await saveEmail(...);
}
```

**After**:
```javascript
const results = await batching.processBatch(
  uids,
  async (uid) => {
    const source = await gmailClient.fetchMessage(uid);
    await parseEmail(source);
    await saveEmail(...);
  },
  {
    batchSize: 5,  // Fetch 5 emails in parallel
    delayBetweenBatches: 500  // Rate limit respect
  }
);
```

**Benefits**:
- 5 emails fetched & parsed simultaneously
- Network I/O is parallelized (not CPU bound)
- 24,566 emails: 17 hours → 2-3 hours

---

## Configuration

### Email Agent Batching

Set these in `.env.local` or via UI:

```bash
# Batch size for parallel processing
EMAIL_BATCH_SIZE=5

# Delay between batches (ms) — respect Gmail rate limits
EMAIL_BATCH_DELAY=500
```

### Relationships Agent Batching

Settings in `packages/agents/relationships/index.js`:

```javascript
const PARALLEL_BATCH_SIZE = 5  // Process 5 contacts simultaneously
const DELAY_BETWEEN_BATCHES = 1000  // 1s between batches
```

To increase speed (less caution with LLM):
```javascript
const PARALLEL_BATCH_SIZE = 10  // 10 at once
const DELAY_BETWEEN_BATCHES = 100  // Minimal delay
```

To be conservative (avoid overwhelming LLM/API):
```javascript
const PARALLEL_BATCH_SIZE = 2  // 2 at once
const DELAY_BETWEEN_BATCHES = 2000  // 2s between batches
```

---

## Monitoring & Observability

### Check Cache Stats

```bash
node -e "
const db = require('@secondbrain/db');
(async () => {
  const { rows } = await db.query(\`
    SELECT agent_id, item_type, COUNT(*) as cached_items,
           MAX(processed_at) as last_processed
    FROM system.agent_cache
    GROUP BY agent_id, item_type
  \`);
  console.log('Cache stats:', JSON.stringify(rows, null, 2));
  process.exit(0);
})();
"
```

### Clear Cache (Full Reset)

```bash
node -e "
const db = require('@secondbrain/db');
(async () => {
  await db.query('DELETE FROM system.agent_cache WHERE agent_id = \$1', ['relationships']);
  console.log('Cache cleared for relationships agent');
  process.exit(0);
})();
"
```

### Monitor Real-Time Progress

Add this to agent logs:

```javascript
onBatchComplete: async (batchInfo) => {
  const rate = batchInfo.successCount / (DELAY_BETWEEN_BATCHES / 1000 + 3);
  const remainingBatches = batchInfo.totalBatches - batchInfo.batchNum;
  const estTimeRemaining = (remainingBatches * DELAY_BETWEEN_BATCHES) / 1000;
  
  console.log(`
    Batch ${batchInfo.batchNum}/${batchInfo.totalBatches}
    Rate: ${rate.toFixed(1)} items/sec
    ETA: ${estTimeRemaining.toFixed(0)}s remaining
  `);
}
```

---

## Testing the Implementation

### Run a Full Test

```bash
# Clear cache to process everything
npm run relationships 2>&1 | tee /tmp/relationships-parallel.log

# Check speed:
# - Batch complete logs will show parallel processing
# - Compare timestamps: if batch takes same time for 5 items, it's working
```

### Compare Before/After

Before running the new code, measure baseline:

```bash
time npm run email 2>&1 | tail -10
# Note total time

# After implementing:
time npm run email 2>&1 | tail -10
# Compare improvement
```

### Verify Caching Works

```bash
# First run (processes everything)
npm run relationships

# Second run (should be much faster due to caching)
npm run relationships

# Check logs for: "Filtered to X contacts needing analysis (Y cached)"
```

---

## Performance Expectations

### Email Agent
- **Cold run** (first time): 17 hours (no parallelization yet, just infrastructure)
  - With batching: ~2-3 hours (5x-10x improvement)
- **Warm run** (already processed, just new emails): ~5 minutes (incremental only)

### Relationships Agent
- **New contacts analyzed**: 5 in parallel ~3s each batch
  - Typical: 50-100 new contacts per run → 10-20 batches → 20-40 seconds
- **Incremental caching**: Skip 95% of contacts with no new messages
  - Typical: 5 minute run becomes 30 seconds

### Projects Agent
- **Discovery**: Already fast, no parallelization needed
- **Group analysis**: Batches 5 groups at once (if implemented)

---

## Troubleshooting

### Batching Not Working (Items Still Sequential)

**Check**: Are you seeing "Batch N/M" logs with multiple items in one log?

```javascript
// If not, verify processBatch is being called:
console.log(`Processing ${items.length} items in parallel batches...`);
const results = await batching.processBatch(items, processor, options);
console.log(`Completed ${results.length} items`);
```

### Cache Not Skipping Items

**Check**: Is `filterUnprocessedItems` being called?

```javascript
const before = contactsNeedingAnalysis.length;
const filtered = await caching.filterUnprocessedItems(...);
const after = filtered.length;
console.log(`Filtered from ${before} to ${after} items`);
```

**If before === after**: Cache may not be working. Check:
1. Is the cache table created? `SELECT * FROM system.agent_cache LIMIT 1;`
2. Are records being inserted? `INSERT INTO system.agent_cache ... RETURNING *;`
3. Is `lastActivityAt` field being set? `contact.last_msg_at` must be defined

### Memory Issues with Parallel Processing

If you see memory spikes:

```javascript
// Reduce batch size
const PARALLEL_BATCH_SIZE = 3;  // Instead of 5

// Or add GC between batches
onBatchComplete: async () => {
  if (global.gc) global.gc();  // Manual garbage collection
}
```

### LLM Timeouts with Batching

If you see "timeout" or "connection reset" errors:

```javascript
// Increase delay between batches
const DELAY_BETWEEN_BATCHES = 5000;  // 5 seconds instead of 1

// Or reduce batch size
const PARALLEL_BATCH_SIZE = 2;  // Instead of 5
```

---

## Next Steps

### Week 1: Stabilize
- [x] Deploy batching utility
- [x] Deploy caching utility
- [x] Update relationships agent
- [x] Update email agent
- [ ] Test thoroughly in staging
- [ ] Monitor error rates and memory usage

### Week 2: Optimize
- [ ] Tune batch sizes based on observed metrics
- [ ] Add cache statistics to monitoring dashboard
- [ ] Implement cache invalidation strategy

### Week 3: Extend
- [ ] Apply batching to projects agent
- [ ] Apply caching to limitless agent
- [ ] Implement adaptive batching (adjust size based on success rate)

---

## Architecture Notes

### Design Decisions

**Why parallel batching?**
- Network I/O (email fetching) is I/O-bound → parallelization provides 3-5x speedup
- LLM API calls (relationships) have latency → 5 items in parallel takes ~same time as 1 sequential
- Respects rate limits with `delayBetweenBatches`

**Why caching?**
- Most contact data doesn't change between runs
- Incremental mode already skips old data, but cache adds finer-grained tracking
- Avoids redundant LLM calls when contact has no new messages

**Why not job queues (Bull, RabbitMQ)?**
- Overhead not justified yet — cron-based scheduling is sufficient
- Easier to debug and monitor without additional services
- Can be added later if needed for real-time processing

**Why metadata in cache?**
- Allows quick lookups without querying original data
- Examples: `is_noise: true`, `relationship_type: 'colleague'`
- Enables future filtering ("skip noise contacts") without DB hits

---

## Code Examples

### Using Batching in a New Agent

```javascript
const batching = require('../shared/batching');

async function processItems() {
  const items = await fetchItemsFromDB();
  
  const results = await batching.processBatch(
    items,
    async (item) => {
      const analysis = await analyzeItem(item);
      await saveAnalysis(item.id, analysis);
      return { success: true };
    },
    {
      batchSize: 10,
      delayBetweenBatches: 500,
      onBatchComplete: (info) => {
        console.log(`${info.batchNum}/${info.totalBatches}: ${info.successCount} done`);
      }
    }
  );
  
  const successCount = results.filter(r => r.success).length;
  console.log(`Processed ${successCount}/${items.length} items`);
}
```

### Using Caching in a New Agent

```javascript
const caching = require('../shared/caching');

async function processIncrementally() {
  const allItems = await getAllItems();
  
  // Get only items that need processing
  const itemsToProcess = await caching.filterUnprocessedItems(
    'my-agent',
    'item_type',
    allItems
  );
  
  for (const item of itemsToProcess) {
    const result = await processItem(item);
    
    // Record successful processing
    if (result.success) {
      await caching.recordProcessed(
        'my-agent',
        'item_type',
        item.id,
        { processed_at: new Date() }
      );
    }
  }
  
  // Get stats
  const stats = await caching.getStats('my-agent');
  console.log(`Cached: ${stats.byType.item_type.count} items`);
}
```

---

## Version History

- **v1.0 (2026-04-07)**: Initial implementation
  - Batching utility with configurable sizes
  - Caching utility with activity tracking
  - Relationships agent parallel processing
  - Email agent parallel fetching
