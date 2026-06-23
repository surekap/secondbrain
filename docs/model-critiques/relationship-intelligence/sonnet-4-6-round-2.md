# Sonnet 4.6 Round 2 Review

## Method

Read the full plan at workspace/secondbrain/docs/plans/2026-06-23-relationship-intelligence-first-work.md.
Verified claims against live code:
- packages/ui/app/page.jsx (dashboard field reads)
- packages/ui/server.js (PATCH allowlist, stats APIs)
- packages/agents/relationships/services/extractor.js (MY_WA_JID)
- packages/agents/relationships/services/insights.js (imports)
- packages/agents/relationships/services/opportunities.js (Math.min bug)
- packages/agents/research/index.js (provider gating)
- packages/agents/research/sql/schema.sql (duplicate DDL)
- packages/agents/relationships/sql/schema.sql (canonical column ownership)

All code claims verified against current file contents. No Round 1 items are repeated unless their incorporation is still materially incomplete.

---

## Remaining Good Suggestions

### R2-1 — Task 1 fix scope is incomplete: projStats.open_insights also reads a nonexistent field

**Recommendation:** Extend Task 1 to also fix line 286 of page.jsx.

**Evidence:** page.jsx line 282 reads `projStats.total` (plan addresses this → `projStats.total_projects`). page.jsx line 286 reads `projStats.open_insights`. The server's `projectsStats()` function (server.js lines 498-519) returns exactly: `total_projects`, `active_projects`, `stalled_projects`, `last_analysis_at`, `analysis_status`. There is no `open_insights` field. The fallback to `projInsights.length` means it never shows 0, so the bug is silent, but the field read is wrong and the fallback bypasses any server-side filtering the stat might eventually add.

**Why it matters:** Task 1 fixes the visible zero but leaves a structurally identical field-name mismatch one line below it. Future schema additions to projectsStats that include a filtered insight count will be invisible until someone notices the fallback is still in place. It also means the review assertion "Dashboard stats use canonical API fields" in the success criteria is false after Task 1 is applied.

**Exact plan/spec change:** In Task 1 implementation block, add:
```jsx
Number(projStats.open_insights || projInsights.length || 0)
```
→ replace with just:
```jsx
Number(projInsights.length || 0)
```
(projStats has no such field; until the server adds one, use the client-fetched list directly and don't shadow it with a nonexistent stat key). Also add `projStats.open_insights` to the grep verification command in Task 1.

**Priority:** Medium. Silent due to fallback, but leaves the success criterion technically false.

---

### R2-2 — Task 3 top-level throw breaks the entire relationships agent for environments without WhatsApp configured

**Recommendation:** Either document WHATSAPP_SELF_JID as a hard prerequisite before attempting Phase 0A, or soften the throw to a lazy guard inside the WA-specific functions.

**Evidence:** extractor.js currently exports a hardcoded JID as a module-level constant. The plan replaces it with:
```js
const MY_WA_JID = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID
if (!MY_WA_JID) {
  throw new Error('WHATSAPP_SELF_JID env var is required...')
}
```
This throw fires at `require()` time. extractor.js is imported by insights.js (line 4) and opportunities.js (line 17). Both are imported by the relationships index agent. If WHATSAPP_SELF_JID is not set, `npm run relationships` fails immediately at startup with an uncaught module-load error — not a graceful missing-config message, a hard crash before any agent logic runs. Currently the hardcoded JID at least keeps the agent running (with wrong WA filtering but correct non-WA paths).

The plan describes this as "fail loudly, not silently" which is correct intent — but it does not document that this is a hard startup dependency, meaning the subagent implementing this task may apply the change without first verifying WHATSAPP_SELF_JID is in the deployment's .env.local. If the env is not configured, Phase 0A leaves the relationships agent broken.

**Why it matters:** Undetected agent startup failure is a higher blast radius than a wrong hardcoded JID. The plan's verification steps (node -c syntax check only) will not catch this because `node -c` does not execute module-level code. The smoke gate in Task 8 ("WHATSAPP_SELF_JID missing fails loudly, not silently") is Phase 0B — after the code is already deployed.

**Exact plan/spec change:** Add a prerequisite step to Task 3 before implementation:
```
Pre-condition: Confirm WHATSAPP_SELF_JID (or MY_WA_JID) is already present in .env.local on
the deployment host. Run: grep -E 'WHATSAPP_SELF_JID|MY_WA_JID' /opt/data/workspace/secondbrain/.env.local
If absent, add it BEFORE applying the code change, not after. If absent and unresolvable, defer
Task 3 until the value is available.
```
Alternatively, change the throw to a lazy guard (only throw when a WA function is actually called with a null JID) to separate the availability check from agent startup.

**Priority:** High. Can silently brick the relationships agent in the subagent implementation flow.

---

### R2-3 — Task 4 DB config lookup is per-contact, not per-run, causing unnecessary DB churn

**Recommendation:** Move the active-provider resolution outside `researchContact()` into `runResearch()` so config is fetched once per agent run.

**Evidence:** The plan's implementation for Task 4 places the async `getConfig()` loop inside `researchContact()`:
```js
const activeProviders = []
for (const p of providers) {
  const key = await getConfig(`system.${keyMap[p.name]}`)
  if (key) activeProviders.push(p)
}
```
`researchContact()` is called in a `for...of` loop in `runResearch()` over up to 20 contacts (line 151 of research/index.js). With 4 providers and 20 contacts, this is 80 sequential `getConfig()` DB queries per run just to decide which providers are active — before a single API call. API key configuration does not change between contacts within a single run.

**Why it matters:** `getConfig()` is an async DB query (see packages/agents/shared/config.js). 80 unnecessary round-trips per run adds latency and puts pointless load on the Postgres connection. More importantly, doing it per-contact makes the log message "log active/skipped providers once per contact run or once per agent run" structurally impossible to implement cleanly: if you log per-agent-run, you need the result available before the contact loop.

**Exact plan/spec change:** Rewrite Task 4 implementation to resolve activeProviders once:
```js
// In runResearch(), before the contact loop:
const activeProviderNames = []
for (const [name, envKey] of Object.entries(keyMap)) {
  const key = await getConfig(`system.${envKey}`)
  if (key) activeProviderNames.push(name)
}
if (activeProviderNames.length === 0) {
  console.log('  No research providers configured — skipping run')
  return
}
console.log(`  Active providers: ${activeProviderNames.join(', ')}`)
// Then pass activeProviderNames into researchContact(), or filter providers array there
```
Update the plan's implementation block for Task 4 accordingly.

**Priority:** Medium. Correctness is unaffected; performance and log clarity are.

---

### R2-4 — Task 5 schema removal creates a startup ordering dependency that is not documented

**Recommendation:** Add an explicit ordering note stating that research agent must not run ensureSchema before relationships agent has run.

**Evidence:** research/sql/schema.sql (lines 2-3) currently runs `ALTER TABLE relationships.contacts ADD COLUMN IF NOT EXISTS my_role TEXT` and `research_summary TEXT`. The plan removes these lines, leaving column creation solely in relationships/sql/schema.sql. However, research/index.js line 137 executes `UPDATE relationships.contacts SET research_summary = $1` directly. If the research agent's `ensureSchema()` (which now only creates `contact_research` table) runs before relationships agent's `ensureSchema()` has created `research_summary`, the UPDATE at line 137 will throw `column "research_summary" does not exist`.

Agents run as independent processes. Their `ensureSchema()` calls are not coordinated. The server (`npm run ui`) also runs schemas at startup but it runs UI-layer schemas, not necessarily agent schemas. Nothing in the current codebase enforces that relationships ensureSchema completes before research agent starts.

**Why it matters:** After Task 5 is applied, the research agent's ability to write dossiers depends on another agent having previously run. In a fresh environment or after a DB reset, starting the research agent first silently fails for every contact (SQL error caught per-contact, no overall run failure). This regression is non-obvious.

**Exact plan/spec change:** Add to Task 5:
```
Ordering note: After removing ADD COLUMN from research schema, research agent depends on
relationships agent having run ensureSchema at least once to create research_summary and my_role.
In the server startup path (packages/ui/server.js), verify relationships schema runs before
research schema, or add a startup check in research/index.js ensureSchema() that verifies
the columns exist before proceeding:
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='relationships' AND table_name='contacts'
    AND column_name IN ('my_role','research_summary')
If either is missing, log a clear dependency error rather than allowing a silent write failure.
```

**Priority:** Medium. Fresh-env regression that is invisible during normal Phase 0A testing on an already-initialized DB.

---

## Convergence Assessment

The core plan is solid and Round 1 feedback was well-incorporated. The four issues above are all genuine and verifiable against live code — none are theoretical. Two are high/medium severity (R2-2 can break the agent; R2-4 creates a silent fresh-env regression). Two are medium (R2-1 leaves a success criterion technically false; R2-3 adds unnecessary DB churn).

None of these require redesigning any task. They are all bounded spec/precondition additions to existing tasks.

Recommendation: one more targeted revision to fold these four into the plan, then the plan is ready to implement. Another full critique loop is not justified — the issues are narrow and the fixes are obvious.
