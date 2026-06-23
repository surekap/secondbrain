# Relationship Intelligence First-Work Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Start SecondBrain’s relationship-intelligence evolution with the highest-leverage, lowest-risk improvements: trust/quality papercuts, live-readiness instrumentation, and a concrete execution team for subsequent Opportunity Ledger work.

**Architecture:** Do not rebuild ingestion or create new user-facing agents. Preserve the local workstation trust boundary. First stabilize the existing UI/API/agent behavior, then run a live data-quality audit, then introduce first-class opportunity infrastructure behind the current `relationships.insights` UI.

**Tech Stack:** Node.js npm workspaces, Next.js UI, Express API in `packages/ui/server.js`, PostgreSQL schemas under `packages/agents/*/sql`, existing Hermes subagent workflow.

**Models Used For This Planning Pass:**
- Coordinator / final plan author: `gpt-5.5` via `openai-codex` — frontier model, appropriate for architecture and prioritization.
- Parallel repository inspection subagents: Hermes `delegate_task` children spawned from the same `gpt-5.5` / `openai-codex` session; child tool output did not expose a model name, so record as inherited/frontier.

**Model Policy Going Forward:**
- Frontier model: `gpt-5.5` / `openai-codex` for architecture, cross-cutting code review, database design, identity resolution, opportunity scoring, and final merge-readiness review.
- Second-tier coding model: use the configured second-tier coding model once available for simple localized implementation tasks: UI field-name fixes, PATCH allowlist additions, small API aliases, simple config reads. If no second-tier model is configured in Hermes profiles, use frontier rather than silently downgrading.
- Low-cost model: use a configured low-cost model only for high-volume triage/compaction: log summarization, schema inventory, long transcript/message clustering, duplicate candidate pre-filtering. Promote condensed results to frontier analysis before decisions.

---

## Executive Decision: What To Work On First

Work first on **Phase 0A — trust and operability papercuts**, not the Opportunity Ledger.

Rationale:

1. These are small changes with high confidence and low blast radius.
2. They improve user trust before deeper architecture work.
3. They expose whether current agent/UI flows are reliable enough for live data audits.
4. They create concrete verification points before database migrations.
5. They reduce false negatives in the current dashboard and relationship screens.

Do **not** begin first with `intelligence.opportunities`. That is strategically right, but it depends on clearer current-state quality, evidence behavior, and reliable “run analysis / refresh” controls.

---

## Proposed Subagent Team

### 1. Coordinator / Chief Architect

- **Model:** `gpt-5.5` / `openai-codex` frontier.
- **Owner:** Main Hermes coordinator.
- **Role:** Maintain roadmap, sequence tasks, arbitrate tradeoffs, verify outputs, update PR.
- **Tools:** full repo/file/terminal/git/GitHub.
- **Do not delegate:** final product judgment, final PR summary, security/trust-boundary decisions.

### 2. Codebase Mapper

- **Model:** low-cost model for first-pass inventory if configured; otherwise second-tier. Promote summary to frontier review.
- **Role:** High-volume search/read of files, routes, schemas, config usage, long logs.
- **Output:** compact evidence list with exact paths/line ranges.
- **Use for:** triage only, not final decisions.

### 3. Simple Implementation Engineer

- **Model:** second-tier coding model if configured; frontier fallback.
- **Role:** Localized code changes with narrow tests.
- **Tasks:** dashboard stat aliases, `my_role` edit support, config-backed self WhatsApp JID, small API response improvements.
- **Guardrail:** no broad refactors, no schema migrations unless explicitly assigned.

### 4. API / Agent-Control Engineer

- **Model:** frontier model.
- **Role:** Run-analysis endpoint design, process manager behavior, safe refresh/restart/trigger semantics.
- **Reason for frontier:** agent control is cross-cutting and can create operational surprises.

### 5. Database / Intelligence Schema Architect

- **Model:** frontier model.
- **Role:** Draft `intelligence` schema, migration plan, compatibility strategy, backfill strategy, evidence model.
- **Start only after:** Phase 0A and live audit plan are in place.

### 6. QA / Reviewer Pair

- **Spec Reviewer Model:** frontier for spec compliance.
- **Code Quality Reviewer Model:** frontier for security, regressions, and architecture fit.
- **Role:** Two-stage review after each implementation task.

### 7. Compaction / Data Audit Worker

- **Model:** low-cost model for bulk sampling/triage; frontier for final interpretation.
- **Role:** summarize sampled contacts/insights/messages from live DB once safe DB access is configured.
- **Guardrail:** never expose secrets; redact PII in reports unless user explicitly asks otherwise.

---

## Phase 0A — Trust / Operability Papercuts

### Task 0: Confirm branch and baseline state

**Objective:** Ensure implementation starts from the existing PR branch and not from dirty `main`.

**Files:** none.

**Steps:**

1. Run:
   ```bash
   cd /opt/data/workspace/secondbrain
   git status -sb
   git branch --show-current
   git log -1 --oneline
   ```
2. Expected:
   - Branch: `docs/relationship-intelligence-strategy`
   - Working tree clean before new edits.
3. If dirty, inspect and decide whether to commit, stash, or stop.

**Model:** coordinator frontier.

---

### Task 1: Fix Dashboard stats field mismatch

**Objective:** Make Dashboard stats display correctly without relying on fallback lengths.

**Files:**
- Modify: `packages/ui/app/page.jsx`
- Optionally modify: `packages/ui/server.js`

**Problem:**

Dashboard currently reads:

```jsx
relStats.open_insights
projStats.total
```

but API stats use:

```text
relationshipsStats(): pending_insights
projectsStats(): total_projects
```

**Preferred implementation:**

Fix the UI to consume canonical server fields:

```jsx
Number(relStats.pending_insights || relInsights.length || 0)
Number(projStats.total_projects || 0)
```

Optionally add server-side aliases only if broader UI compatibility needs them:

```js
open_insights: pending_insights
 total: total_projects
```

**Verification:**

1. Search to confirm no stale Dashboard field usage:
   ```bash
   grep -R "relStats.open_insights\|projStats.total" -n packages/ui/app
   ```
2. Run lint/test command if available:
   ```bash
   npm --workspace=packages/ui run lint || true
   npm --workspace=packages/ui test || true
   ```
3. If no lint/test exists, run syntax-level check:
   ```bash
   npm --workspace=packages/ui run build
   ```
   only if dependencies and environment are available; otherwise document blocker.

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/ui/app/page.jsx packages/ui/server.js
git commit -m "fix: align dashboard stats fields"
```

---

### Task 2: Make `my_role` editable and sticky

**Objective:** Allow manual correction of relationship perspective, because `my_role` is high-trust relationship intelligence.

**Files:**
- Modify: `packages/ui/server.js`
- Modify: `packages/ui/app/relationships/page.jsx`

**Problem:**

`my_role` exists, is displayed, and is respected in agent upserts, but is not included in contact edit UI/API allowlist.

**Implementation:**

1. Add `my_role` to the allowed PATCH fields in `packages/ui/server.js`:
   ```js
   const allowed = ['display_name','company','job_title','my_role','relationship_type', ...]
   ```

2. Add edit state in `relationships/page.jsx`:
   ```js
   const [editMyRole, setEditMyRole] = useState('')
   ```

3. Populate it in `openEditModal()`:
   ```js
   setEditMyRole(c.my_role || '')
   ```

4. Include it in `updates` in `saveContact()`:
   ```js
   my_role: editMyRole.trim() || null,
   ```

5. Add a form input labelled “Your role relative to this contact”.

**Verification:**

1. Static check:
   ```bash
   grep -n "my_role" packages/ui/server.js packages/ui/app/relationships/page.jsx
   ```
2. Confirm `my_role` is in allowlist and updates payload.
3. Run UI lint/build if feasible.

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/ui/server.js packages/ui/app/relationships/page.jsx
git commit -m "fix: allow manual editing of contact relationship role"
```

---

### Task 3: Replace hardcoded WhatsApp self JID with config-backed value

**Objective:** Remove hardcoded Prateek-specific WhatsApp JID from relationship extraction logic.

**Files:**
- Modify: `packages/agents/relationships/services/extractor.js`
- Modify: `packages/agents/relationships/services/insights.js` only if import behavior changes.
- Possibly modify: `.env.example`
- Possibly modify docs/manual if appropriate.

**Current issue:**

```js
const MY_WA_JID = '919830049540@c.us'
```

**Implementation direction:**

Use environment variable first, default only as explicit fallback if necessary:

```js
const MY_WA_JID = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID || null
```

Then guard queries that require it. Better:

```js
function getMyWaJid() {
  const jid = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID
  if (!jid) throw new Error('WHATSAPP_SELF_JID is required for WhatsApp relationship analysis')
  return jid
}
```

Prefer failing clearly over silently including self-chat data.

**Verification:**

1. Search:
   ```bash
   grep -R "919830049540\|MY_WA_JID" -n packages/agents/relationships
   ```
2. Ensure no literal phone JID remains.
3. Run relationship-agent syntax check:
   ```bash
   node -c packages/agents/relationships/services/extractor.js
   node -c packages/agents/relationships/services/insights.js
   ```

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/agents/relationships/services/extractor.js packages/agents/relationships/services/insights.js .env.example
git commit -m "fix: configure WhatsApp self JID for relationship analysis"
```

---

### Task 4: Audit env-vs-DB config mismatch and fix research provider gating first

**Objective:** Fix the clearest config bug: research providers read DB config, but `research/index.js` filters providers by `process.env` first.

**Files:**
- Modify: `packages/agents/research/index.js`
- Possibly modify: `packages/agents/shared/config.js`

**Problem:**

Provider modules call:

```js
getConfig('system.TAVILY_API_KEY')
getConfig('system.OPENAI_API_KEY')
getConfig('system.PEOPLEDATALABS_API_KEY')
getConfig('system.SERPAPI_API_KEY')
```

but `research/index.js` filters active providers with:

```js
providers.filter(p => !!process.env[keyMap[p.name]])
```

This can make UI-configured keys appear ignored.

**Implementation direction:**

Do not pre-filter by `process.env`. Either:

1. Run all providers and let each provider return/throw `not configured`, then summarize results; or
2. Check `getConfig(...)` in `research/index.js` before filtering.

Preferred minimal fix:

```js
const activeProviders = providers
```

Then treat not-configured provider failures as non-fatal. This aligns with provider-level config behavior.

**Verification:**

1. Run syntax:
   ```bash
   node -c packages/agents/research/index.js
   ```
2. Search:
   ```bash
   grep -R "activeProviders\|process.env.*API_KEY" -n packages/agents/research
   ```

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/agents/research/index.js
git commit -m "fix: honor database-configured research providers"
```

---

### Task 5: Decide safe semantics for Run Analysis endpoints

**Objective:** Avoid misleading buttons that claim to trigger analysis but only report schedule/restart behavior.

**Files:**
- Inspect: `packages/ui/server.js`
- Modify: `packages/ui/server.js`
- Modify: `packages/ui/app/relationships/page.jsx`
- Modify: `packages/ui/app/projects/page.jsx`
- Optional: agent entrypoints if adding IPC/queue trigger.

**Current issue:**

Routes:

```text
GET /api/relationships/run
GET /api/projects/run
```

appear to not actually trigger immediate analysis when agents are already running.

**Decision needed before implementation:**

Choose one:

#### Option A — Rename to status-only / restart guidance

Lowest risk. Change button text from `Run Analysis` to `Analysis Status`, and route response copy to be explicit.

#### Option B — Add restart-and-run behavior

If agent is running, stop and restart it to trigger immediate startup analysis. Medium risk because restart can interrupt current work.

#### Option C — Add explicit trigger mechanism

Best architecture. Add an API-triggered queue/IPC file/signal that the long-running agent watches and runs analysis without restart. More work.

**Recommendation:**

For first work, implement **Option A** unless Prateek explicitly wants active triggering now. Do not add brittle process restarts as a shortcut.

**Model:** frontier model for design decision; second-tier only if implementing Option A copy changes.

**Commit for Option A:**

```bash
git add packages/ui/server.js packages/ui/app/relationships/page.jsx packages/ui/app/projects/page.jsx
git commit -m "fix: clarify scheduled analysis controls"
```

---

## Phase 0B — Live Data Quality Audit Preparation

### Task 6: Create read-only audit script skeleton

**Objective:** Prepare a safe audit script that can run when `DATABASE_URL` is configured, without requiring Gmail/WhatsApp/Limitless credentials.

**Files:**
- Create: `scripts/audit-secondbrain-quality.js` or `packages/tools/audit-secondbrain-quality.js` if tools package exists.
- Create: `docs/plans/secondbrain-live-audit-queries.md`

**Script should report:**

- Source freshness:
  - `email.emails` count + max date
  - `public.messages` count + max `ts`
  - `limitless.lifelogs` count + max `start_time`
- Derived freshness:
  - `relationships.contacts` count + max `last_interaction_at`
  - open `relationships.insights`
  - `projects.projects` count + max `last_activity_at`
- Quality indicators:
  - duplicate normalized names
  - contacts with only phone-number names
  - contacts missing company/job where relationship strength is strong/moderate
  - open insights older than 30/60/90 days
  - project communications with null `contact_id`

**Verification:**

Run without DB and confirm it fails cleanly:

```bash
node scripts/audit-secondbrain-quality.js
# expected: clear message: DATABASE_URL is required
```

If DB is configured, run and save redacted report.

**Model:** second-tier for implementation; frontier for interpreting results.

---

## Phase 1 — Opportunity Ledger Design Spike

Do not implement until Phase 0A is complete and Phase 0B audit has at least one run.

### Task 7: Draft schema migration for first-class opportunities

**Objective:** Create migration SQL proposal only, not applied automatically.

**Files:**
- Create: `docs/plans/2026-06-23-opportunity-ledger-schema.md`
- Later create: `packages/agents/intelligence/sql/schema.sql` or equivalent.

**Design constraints:**

- Preserve `relationships.insights` UI behavior.
- Add opportunity records behind it.
- Use link tables rather than arrays.
- Include evidence references.
- Include scoring and lifecycle fields.
- Avoid graph DB.

**Model:** frontier database architect.

---

## Execution Protocol

### Before implementation

1. Main coordinator updates PR branch.
2. Dispatch subagents in groups only when file overlap is low.
3. Do not let two implementers edit the same file concurrently.

### Per task

1. Implementer subagent executes one task.
2. Spec reviewer subagent checks the original task spec.
3. Code quality reviewer subagent checks conventions, regressions, and security.
4. Coordinator runs verification commands.
5. Commit each completed task separately.

### Model routing

- **Frontier:** tasks 0, 5 decision, 7, all spec/quality reviews, final integration review.
- **Second-tier:** tasks 1, 2, 3, 4, 6 implementation if second-tier configured.
- **Low-cost:** file inventories, long output summarization, DB sample compaction only.

### Final verification before PR update

Run as much as environment allows:

```bash
cd /opt/data/workspace/secondbrain
git status -sb
npm --workspace=packages/ui run lint || true
npm --workspace=packages/ui run build || true
node -c packages/agents/relationships/services/extractor.js
node -c packages/agents/relationships/services/insights.js
node -c packages/agents/research/index.js
```

If dependencies/env block build, report exact blocker instead of inventing success.

---

## Recommended First Subagent Dispatch Batch

Do not dispatch implementation until Prateek approves this plan or explicitly asks to proceed. Once approved, dispatch:

1. **Stats/UI implementer** — Task 1 only.  
   Model: second-tier coding model if configured; frontier fallback.

2. **Relationship-role implementer** — Task 2 only.  
   Model: second-tier coding model if configured; frontier fallback.

3. **Config audit worker** — read-only audit of Tasks 3 and 4 exact code changes needed.  
   Model: low-cost if configured for search/triage; frontier for final change design.

Then review/commit before moving to Task 3/4 implementation.

---

## Success Criteria For First Work

- Dashboard stats are accurate.
- `my_role` can be manually edited and becomes sticky through `manual_overrides`.
- Hardcoded WhatsApp self JID is removed or made config-backed.
- Research provider gating no longer ignores DB-configured API keys.
- Run-analysis UI no longer misleads the user.
- A read-only live audit script exists and fails safely without DB credentials.
- All changes are separate commits on the existing PR branch.

