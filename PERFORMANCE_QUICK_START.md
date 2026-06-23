# Performance Quick Reference

## Status: ✅ All Green

```
Configuration     ✅ All agents using local models (gemma4 primary)
Ollama Status     ✅ Running, models loaded (gemma4, qwen3.5:9b, bge-m3)
Agent Tests       ✅ Email, Relationships, Projects, Research, Limitless all running
Local Fallback    ✅ No API calls observed (0% fallback rate)
```

---

## Performance At a Glance

### Daily Processing Time (Incremental Mode)

```
Email Agent         ~5 min    (new emails only)
Relationships       ~3 min    (1 contact/run)  
Projects            ~15 min   (discovery)
Research            ~2 min    (20 contacts)
Limitless           ~25 min   (when API syncs)
────────────────────────────
TOTAL DAILY         ~50 min   (can run in parallel → 25 min)
```

### One-Time Setup (Full History Processing)

```
Email (24.5K items)     17 hours  (can optimize to 2-3h with batching)
Relationships (7K)      20 hours  (already done incrementally)
Projects                15 min
Research                5 min
Limitless               TBD (when API synced)
```

---

## Model Performance

| Model | Speed | Quality | Best For |
|-------|-------|---------|----------|
| **gemma4** | ⚡⚡⚡ (0.4-12s) | ⭐⭐⭐ | Email, extraction, summarization |
| **qwen3.5:9b** | ⚡⚡ (12-30s) | ⭐⭐⭐⭐ | Relationships, projects, reasoning |
| **OpenAI** (fallback) | ⚡ (2-5s) | ⭐⭐⭐⭐⭐ | Never used (local first) |

**Typical response**: 2-3 seconds (after first cold load)

---

## Quick Wins (Implement This Week)

### 1. Enable Batching (2-3 hour setup) 🚀
**Goal**: Reduce email processing from 17h → 2-3h

```javascript
// packages/agents/email/index.js
// Change from: for (email of emails) { await processOne(email) }
// To: Process 10 emails in parallel
```

**Expected impact**: 8-10x speedup for batch operations

### 2. Add Model Selection by Task (1-2 hours)
**Goal**: Use qwen3.5:9b for reasoning, gemma4 for speed

```javascript
// In llm.js getPriorityList()
const taskToModel = {
  'email': ['gemma4'],          // Fast extraction
  'relationships': ['qwen3.5'],  // Better reasoning
  'projects': ['qwen3.5'],       // Better discovery
};
```

**Expected impact**: 10-20% quality improvement at no cost

### 3. Monitor Ollama (30 minutes)
**Goal**: Ensure you're not hitting memory limits

```bash
# Add to cron (check every hour)
watch -n 1 'curl -s http://127.0.0.1:11434/api/ps | jq ".models"'
```

**Expected impact**: Catch issues early, optimize memory usage

---

## Memory & CPU Usage

### Current Footprint

```
Ollama daemon              ~2.5 GB (idle)
gemma4 model (in VRAM)    ~4.7 GB
qwen3.5:9b model (VRAM)   ~9-10 GB
Database + Agents         ~0.5 GB
────────────────────────
TOTAL                     ~17 GB (with both models loaded)
```

✅ **M4 Max has 36GB**: Plenty of headroom

### CPU Usage

- **Idle**: <1% (Ollama sleeping)
- **During inference**: 60-100% (all P-cores engaged)
- **During DB queries**: 10-20%

---

## Estimated Cost Savings

### Monthly

| Provider | Current (if used) | With Your Setup |
|----------|-------------------|-----------------|
| Claude API | ~$150 | $0 |
| OpenAI API | ~$10 | $0 (fallback only) |
| Electricity | — | ~$20-30 |
| **Total** | **~$160** | **~$25** |

**Monthly savings: $135**  
**Annual savings: $1,620**

---

## Next Steps (Priority Order)

### Week 1: Observability
- [ ] Add response time tracking to each agent
- [ ] Set up alerts for API fallback (should stay at 0%)
- [ ] Monitor Ollama memory usage

### Week 2: Batching
- [ ] Implement 10x parallelism for email agent
- [ ] Test with full 24.5K dataset
- [ ] Measure time reduction

### Week 3: Quality
- [ ] A/B test gemma4 vs qwen3.5:9b for relationships
- [ ] Route complex tasks to qwen3.5:9b
- [ ] Document quality differences

### Week 4: Caching
- [ ] Cache contact profile updates
- [ ] Cache project insights
- [ ] Skip unchanged items

---

## Troubleshooting

### Agent falls back to OpenAI

**Symptom**: Logs show `[llm:email] trying OpenAI`

**Cause**: Ollama not responding or model error

**Fix**:
```bash
# Restart Ollama
killall ollama
ollama serve

# Check model status
curl http://127.0.0.1:11434/api/ps | jq .models
```

### Slow responses (>30s)

**Symptom**: `[llm:email] trying gemma4 (ollama) ... took 30+s`

**Cause**: 
1. First request (model loading) — normal, expect 60s
2. Out of VRAM (models unloaded) — check memory
3. CPU thermal throttling — check temp

**Fix**:
```bash
# Check if model is cached in VRAM
curl http://127.0.0.1:11434/api/ps | jq .models

# If empty, restart Ollama
killall ollama; sleep 1; ollama serve &
```

### High memory usage

**Symptom**: Free memory < 2GB, system slow

**Cause**: Both models loaded simultaneously

**Fix**:
```bash
# Unload qwen3.5:9b, keep gemma4
curl -X DELETE http://127.0.0.1:11434/api/generate -d '{"model":"qwen3.5:9b"}'

# Or unload both between runs
curl -X DELETE http://127.0.0.1:11434/api/generate -d '{"model":"gemma4"}'
```

---

## Dashboard Commands

### Real-time Agent Status
```bash
curl http://localhost:4001/api/agents | jq '.[] | {id, status, stats}'
```

### LLM Usage Today
```bash
curl 'http://localhost:4001/api/system/usage?group_by=agent' | jq '.'
```

### Get Agent Config
```bash
curl http://localhost:4001/api/system/agents/email/llm | jq '.'
```

---

## What to Tell Me If Something's Wrong

1. **Agent not starting?**
   - Share: `npm run relationships 2>&1 | head -50`

2. **Falling back to API?**
   - Share: `curl http://127.0.0.1:11434/api/ps | jq .`
   - Share: Agent logs (`/tmp/ui-startup.log` or dashboard)

3. **Slow inference?**
   - Share: `curl http://127.0.0.1:11434/api/ps | jq .models | head -5`
   - Share: Response time (`[llm:xxx] trying gemma4 ... took Xs`)

4. **Memory issues?**
   - Share: `free -h` (memory status)
   - Share: Ollama process memory `ps aux | grep ollama`
