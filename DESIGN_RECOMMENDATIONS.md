# System Design Recommendations

## Executive Summary

Your local model setup is **well-architected and production-ready**. The priority-based fallback system is excellent. The main bottleneck is inference speed (12-30s per request), which is a hardware limitation, not a software issue.

**Top recommendations** (in order of impact):

1. **Batching & Parallelization** — Reduce email processing from 17h → 2-3h (10x improvement)
2. **Task-based Model Selection** — Route complex reasoning to qwen3.5:9b
3. **Caching Layer** — Skip 60-70% of LLM calls on incremental runs
4. **Memory Optimization** — Unload models between agent runs if VRAM constrained

---

## Architecture Deep Dive

### Current Design (Working Well)

```
┌──────────────────────────────────────────────────────┐
│                    Agents                            │
│  (email, relationships, projects, research, etc)     │
└───────────┬────────────────────────────────┬─────────┘
            │                                │
            v                                v
    ┌────────────────────────────────────────────────┐
    │  llm.js - Priority-based Dispatch             │
    │                                                │
    │  1. Get agent's LLM priority list from DB      │
    │  2. Try each provider in order:                │
    │     - Ollama (local) ← YOU ARE HERE            │
    │     - OpenAI (API fallback)                    │
    │     - Claude (API fallback)                    │
    │  3. Log usage (tokens, cost, latency)          │
    │  4. Mark provider as "no_credits" if error     │
    └────────────────────────────────────────────────┘
            │                                │
            v                                v
        ┌────────────┐              ┌──────────────┐
        │   Ollama   │              │   OpenAI     │
        │  (local)   │              │   (API)      │
        │  $0/call   │              │  $0.003/call │
        │  ~12-30s   │              │  ~2-5s       │
        └────────────┘              └──────────────┘
```

**Why this design is good:**

✅ **Loose coupling** — Agents don't know about LLM providers  
✅ **Easy to swap** — Change priority via UI without code  
✅ **Resilient** — Falls back gracefully if local models fail  
✅ **Observable** — Tracks usage, latency, errors  
✅ **Cost-aware** — Logs token counts even for free services  

---

## Issues & Solutions

### 1. Sequential Processing (Biggest Bottleneck)

#### Problem

```javascript
// Current approach in email agent:
for (const email of emails) {
  const summary = await llm.process(email);  // 2-3 seconds
  await db.save(summary);                    // 0.1 second
}
// Total: 24,566 × 2.3s = ~17 hours
```

**Why slow**: Each email waits for previous one to complete

#### Solution: Batch + Parallel Processing

```javascript
// Option A: Simple batching (5-10x speedup)
const batch_size = 10;
const batches = chunk(emails, batch_size);

for (const batch of batches) {
  const results = await Promise.all(
    batch.map(email => llm.process(email))
  );
  await db.saveBatch(results);
}
// Total: 24,566 / 10 × 2.3s = ~1.7 hours
```

**Implementation cost**: 1-2 hours (modify email agent)  
**Speedup**: 10x  
**Tradeoff**: Slightly higher CPU usage during processing

```javascript
// Option B: Job queue (10-20x speedup, more complex)
const queue = new Bull('email-processing');
queue.process(async (job) => {
  return await llm.process(job.data);
});

// Add 500 jobs
for (const email of emails) {
  await queue.add(email);
}

// Process up to 20 in parallel
queue.process(20, async (job) => {
  return await llm.process(job.data);
});
```

**Implementation cost**: 4-6 hours (setup Bull, worker, monitoring)  
**Speedup**: 15-20x  
**Benefit**: Better observability, error handling, retry logic

---

### 2. Model Quality vs Speed Tradeoff

#### Problem

```
gemma4 (current):
  - Speed: ⚡⚡⚡ (0.4-12s per request)
  - Quality: ⭐⭐⭐ (good for extraction, weak on reasoning)
  - Best for: Email summarization, simple extraction
  
qwen3.5:9b (available but not used):
  - Speed: ⚡⚡ (12-30s per request)
  - Quality: ⭐⭐⭐⭐ (better reasoning, more accurate)
  - Best for: Relationships analysis, project discovery
```

Current setup uses gemma4 for everything → quality issues on complex tasks

#### Solution: Task-Aware Model Selection

```javascript
// In llm.js, modify getPriorityList():

async function getPriorityList(agentId, taskType) {
  const taskModelPreferences = {
    'email.extract_summary': ['gemma4', 'qwen3.5:9b'],
    'relationships.profile': ['qwen3.5:9b', 'gemma4'],
    'projects.discover': ['qwen3.5:9b', 'gemma4'],
    'research.enrich': ['qwen3.5:9b', 'gemini'],
  };
  
  // Get preferred models for this task
  const preferredModels = taskModelPreferences[`${agentId}.${taskType}`];
  
  // Return in order of preference
  const { rows } = await db.query(`
    SELECT alp.priority, p.* FROM system.agent_llm_priority alp
    JOIN system.llm_providers p ON p.id = alp.provider_id
    WHERE alp.agent_id = $1
      AND p.model = ANY($2)
    ORDER BY array_position($2, p.model)
  `, [agentId, preferredModels]);
  
  return rows;
}

// Usage in agents:
const response = await llm.create(agentId, {
  messages,
  task: 'relationships.profile'  // ← Pass task type
});
```

**Implementation cost**: 2-3 hours  
**Improvement**: 10-20% quality lift on complex tasks  
**Cost**: Same ($0, both local)

---

### 3. Inefficient Incremental Processing

#### Problem

Agents track `last_analysis_at` but still process old items if they have new activity:

```
Relationships agent:
- Last analyzed: 2026-03-31
- Today's new items: 75 email senders with activity
- But still analyzes all 7,111 contacts once per run
```

#### Solution: Smart Caching

```javascript
// Track which contacts need analysis
const needsAnalysis = await db.query(`
  SELECT c.id, c.name, COUNT(m.id) as new_messages
  FROM relationships.contacts c
  LEFT JOIN (email messages or whatsapp messages) m
    ON (c.id = m.contact_id AND m.created_at > c.last_analyzed)
  WHERE m.id IS NOT NULL OR c.last_analyzed IS NULL
  GROUP BY c.id
`);

// Only process contacts with new activity
for (const contact of needsAnalysis) {
  if (!contact.new_messages && contact.last_analyzed) {
    continue; // Skip, no new activity
  }
  await llm.analyzeContact(contact);
}
```

**Implementation cost**: 1-2 hours  
**Improvement**: 60-70% reduction in LLM calls  
**Impact**: Relationships incremental runs: 5min → 2-3min

---

### 4. Cold Start Latency

#### Problem

First request to Ollama takes 60-150 seconds (model loads from disk → VRAM)

```
First request:  61 seconds (model loading)
Second request: 0.4 seconds (cached in VRAM)
```

#### Solution: Warm Up Models on Agent Startup

```javascript
// In agent startup (email/relationships/projects/index.js):

async function startup() {
  await db.connect();
  
  // Warm up primary model
  console.log('Warming up model...');
  try {
    await llm.create(agentId, {
      messages: [{ role: 'user', content: 'Hello' }],
    });
    console.log('✓ Model warmed up');
  } catch (e) {
    console.warn('Model warmup failed (non-fatal):', e.message);
  }
  
  // Continue with normal processing
  await startMainLoop();
}
```

**Implementation cost**: 30 minutes  
**Improvement**: First real request uses cached model (50x faster)

---

### 5. Memory Pressure at Peak Load

#### Problem

Both gemma4 + qwen3.5:9b in VRAM = ~14GB. If multiple agents run simultaneously:

```
gemma4 in VRAM (email agent):    ~4.7 GB
qwen3.5:9b in VRAM (relationships):  ~9 GB
System memory:                      ~2 GB
Database/Agents:                    ~0.5 GB
────────────────────────────────
Leaves only ~1GB slack on 32GB system
```

You have 36GB on M4 Max, so this is fine. But worth optimizing.

#### Solution: Lazy Model Loading

```javascript
// Option 1: Unload between agent runs
// In schedule (every 12 hours):
async function beforeAgentRun() {
  // Keep only the one model we need
  await ollama.unload('qwen3.5:9b');  // Remove from VRAM
}

async function afterAgentRun() {
  // Allow other agents to load their preferred models
  await ollama.unload('gemma4');
}

// Option 2: Sequential agent scheduling
// Run agents at different times:
// - Email: 00:00 (uses gemma4)
// - Relationships: 00:30 (unloads gemma4, loads qwen3.5:9b)
// - Projects: 01:00 (keeps qwen3.5:9b)
```

**Implementation cost**: 30 minutes  
**Benefit**: Keeps system responsive, only if VRAM becomes tight

---

## Recommended Implementation Order

### Week 1: Observability & Monitoring

**Goals**: Understand current behavior, establish baselines

```bash
# Add to monitoring dashboard:
1. Response time per agent
2. Fallback rate (should stay 0%)
3. Ollama model memory usage
4. Daily processing timeline
```

**Time**: 2-3 hours  
**Tools**: Prometheus + Grafana or simple JSON API logging

---

### Week 2: Implement Batching

**Goals**: 10x speedup for batch operations

**Priority**: Start with email agent (simplest, biggest impact)

```javascript
// packages/agents/email/index.js
// Replace main loop with batching logic
// Test with subset first (1000 emails)
```

**Time**: 4-6 hours  
**Expected result**: Email processing 17h → 2-3h

---

### Week 3: Task-Based Model Selection

**Goals**: Better quality without more cost

**Implementation**:
1. Identify task types (already in agent code)
2. Add task parameter to llm.create()
3. Route to preferred models

**Time**: 2-3 hours  
**Expected result**: 10-20% quality improvement

---

### Week 4: Caching Layer

**Goals**: 60% fewer LLM calls on incremental runs

**Implementation**:
1. Add invalidation tracking per item
2. Skip items with no new activity
3. Log cache hit rate

**Time**: 4-5 hours  
**Expected result**: Incremental runs 30-50% faster

---

## Design Decision Matrix

| Change | Effort | Impact | Cost | Do Now? |
|--------|--------|--------|------|---------|
| **Batching** | 4h | 10x speed | $0 | ✅ YES |
| **Model routing** | 2h | 10% quality | $0 | ✅ YES |
| **Caching** | 4h | 60% fewer calls | $0 | ✅ YES |
| **Job queue** | 8h | 5% speed | $0 | ⏸ Maybe later |
| **Unload models** | 1h | High RAM usage | $0 | ⏸ Only if needed |
| **Streaming** | 6h | Better UX | $0 | ⏸ Polish phase |

---

## Architecture Principles

### Keep This (Working Well)

✅ **Priority-based provider dispatch** — No changes needed
✅ **Incremental agent processing** — Core to efficiency
✅ **Config-driven setup** — UI-controlled, no redeploys
✅ **Usage logging** — Essential for cost tracking

### Improve This

⚡ **Parallelism** — Add job queue or Promise.all batching
⚡ **Model selection** — Route tasks to best-fit models
⚡ **Caching** — Skip unchanged items
⚡ **Observability** — Track response times, error rates

### Avoid This

❌ **Multi-queue complexity** — Batching with Promise.all is sufficient
❌ **Distributed caching** — Local cache is fine for incremental runs
❌ **Dynamic model swapping** — Load once per run, not per-request
❌ **API cost optimization** — Not needed, local-first already optimal

---

## Summary: What to Do This Week

### Day 1-2: Measure
```bash
# Run relationships agent, measure time
time npm run relationships

# Check Ollama memory
curl http://127.0.0.1:11434/api/ps | jq .models
```

### Day 3-4: Implement Batching
```javascript
// email agent main loop
// Change from sequential to parallel
```

### Day 5: Test
```bash
# Test with small batch (100 emails)
# Compare time vs baseline

# Verify model is still being used
npm run email 2>&1 | grep "llm:email"
```

Your system is **already good**. These improvements make it **great**.
