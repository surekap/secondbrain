# Relationship Intelligence First-Work Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Start SecondBrain’s relationship-intelligence evolution with the highest-leverage, lowest-risk improvements: trust/quality papercuts, live-readiness instrumentation, and a concrete execution team for subsequent Opportunity Ledger work.

**Architecture:** Do not rebuild ingestion or create new user-facing agents. Preserve the local workstation trust boundary. First stabilize existing UI/API/agent behavior, then run a live data-quality audit, then introduce first-class opportunity infrastructure behind the current `relationships.insights` UI.

**Tech Stack:** Node.js npm workspaces, Next.js UI, Express API in `packages/ui/server.js`, PostgreSQL schemas under `packages/agents/*/sql`, existing Hermes subagent workflow.

**Models Used For Current Plan Revision:**
- Initial coordinator / plan author: `gpt-5.5` via `openai-codex` — frontier model.
- Independent critique: `claude-sonnet-4-6` via `anthropic` — frontier model.
- Revalidation: `gpt-5.5` via `openai-codex` — frontier model.

**Model Policy Going Forward:**
- Frontier: architecture, cross-cutting code review, database design, identity resolution, opportunity scoring, agent-control behavior, final synthesis.
- Second-tier: simple localized implementation — UI field-name fixes, PATCH allowlist additions, copy changes, simple config reads.
- Low-cost: high-volume triage/compaction only — log summarization, schema inventory, transcript/message clustering, duplicate pre-filtering. Promote condensed results to frontier analysis before decisions.
- If the runtime does not expose the exact child model, record it honestly as inherited/unknown rather than inventing a model name.

---

## Cross-Model Review Loop Log

### Round 1 — Sonnet critique

**Model:** `claude-sonnet-4-6` via `anthropic`  
**Artifact:** `.hermes/model-critiques/sonnet-4-6-round-1.md`

Key suggestions accepted:

1. Preserve `MY_WA_JID` export shape; do not accidentally pass a function into SQL.
2. Replace research provider env gating with async DB-config preflight, not blind provider execution.
3. Narrow Task 1: project-count bug is real; relationship insight count fallback made the original issue less severe.
4. Serialize Tasks 1 and 2 because of possible `server.js` overlap.
5. Add missed `Math.min` → `Math.max` cross-person scan incrementality bug.
6. Add stronger behavioral smoke gates; syntax checks are insufficient.
7. Simplify Run Analysis task to UI copy/status clarity; defer IPC trigger design.
8. Add duplicate research schema DDL cleanup.
9. Add dedupe redesign to Phase 1, not Phase 0A.

### Round 1 — GPT-5.5 revalidation

**Model:** `gpt-5.5` via `openai-codex`  
**Artifact:** `.hermes/model-critiques/gpt-5-5-validation-round-1.md`

GPT-5.5 accepted most Sonnet suggestions, with two refinements:

1. `system.WHATSAPP_SELF_JID` DB config is directionally right, but `getConfig()` is async while `extractor.js` currently exports synchronous constants. Phase 0A should preserve export shape and use env fail-fast; DB-config unification is a follow-up unless implementation cleanly adds startup-time async config initialization.
2. Current planning artifacts remain on PR #4. Actual code implementation should branch separately, e.g. `feature/phase-0a-papercuts`, after approval.

### Round 2 — Sonnet critique

**Model:** `claude-sonnet-4-6` via `anthropic`  
**Artifact:** `/opt/data/.hermes/model-critiques/sonnet-4-6-round-2.md`

Remaining good suggestions accepted:

1. Task 1 must also remove the nonexistent `projStats.open_insights` read; use `projInsights.length` directly unless/until the API exposes a canonical field.
2. Task 3 must check deployment `.env.local` for `WHATSAPP_SELF_JID`/`MY_WA_JID` before introducing module-load failure, and verification must execute the module, not only `node -c`.
3. Task 4 should resolve active research providers once per run, not once per contact.
4. Task 5 duplicate-DDL cleanup needs a fresh-environment ordering guard so research does not fail if relationships schema has not initialized.

### Round 2 — GPT-5.5 revalidation

**Model:** `gpt-5.5` via `openai-codex`  
**Artifact:** `.hermes/model-critiques/gpt-5-5-validation-round-2.md`

GPT-5.5 accepted all four Round 2 suggestions. After these bounded updates, the plan is considered converged; another full critique loop is not justified unless implementation changes introduce new facts.

---

## Executive Decision: What To Work On First

Work first on **Phase 0A — trust and operability papercuts**, not the Opportunity Ledger.

Why:

1. Low blast radius and high confidence.
2. Improves user trust before deeper architecture work.
3. Exposes whether current agent/UI flows are reliable enough for live audits.
4. Creates verification points before migrations.
5. Reduces current dashboard/insight noise.

Do **not** begin with `intelligence.opportunities`. That is strategically correct, but it depends on clearer current-state quality, evidence behavior, and reliable refresh/control flows.

---

## Proposed Subagent Team

### 1. Coordinator / Chief Architect

- **Model:** `gpt-5.5` / `openai-codex` frontier.
- **Owner:** Main Hermes coordinator.
- **Role:** Maintain roadmap, sequence tasks, arbitrate tradeoffs, verify outputs, update PR.
- **Do not delegate:** final product judgment, security/trust-boundary decisions, final PR summary.

### 2. Codebase Mapper

- **Model:** low-cost for first-pass inventory if configured; otherwise second-tier. Promote summary to frontier.
- **Role:** High-volume file/route/schema/config/log inventory.
- **Output:** compact evidence list with exact paths/line ranges.
- **Use for:** triage only, not final decisions.

### 3. Simple Implementation Engineer

- **Model:** second-tier coding model if configured; frontier fallback.
- **Role:** Localized code changes with narrow verification.
- **Tasks:** dashboard field reads, `my_role` edit support, UI copy, one-line `Math.max` bug, duplicate DDL cleanup.
- **Guardrail:** no broad refactors, no migrations unless explicitly assigned.

### 4. API / Agent-Control Engineer

- **Model:** frontier.
- **Role:** Only if/when designing a true on-demand analysis trigger. Not needed for Phase 0A UI copy.

### 5. Database / Intelligence Schema Architect

- **Model:** frontier.
- **Role:** Draft `intelligence` schema, migration plan, backfill strategy, evidence model, dedupe strategy.
- **Start only after:** Phase 0A and live audit plan are in place.

### 6. QA / Reviewer Pair

- **Spec Reviewer Model:** frontier.
- **Code Quality Reviewer Model:** frontier.
- **Role:** Two-stage review after each implementation task.

### 7. Compaction / Data Audit Worker

- **Model:** low-cost for bulk sampling/triage; frontier for final interpretation.
- **Role:** summarize sampled contacts/insights/messages from live DB once safe DB access is configured.
- **Guardrail:** redact secrets/PII unless the user explicitly asks otherwise.

---

## Branching Policy

This plan/spec lives on the current docs PR branch:

```text
docs/relationship-intelligence-strategy
```

Actual code implementation should start from a separate branch after plan approval:

```text
feature/phase-0a-papercuts
```

Do not mix substantial code changes into the docs-only strategy PR unless explicitly directed.

---

## Phase 0A — Trust / Operability Papercuts

### Task 0: Confirm branch, baseline state, and implementation branch

**Objective:** Ensure implementation starts cleanly and separately from the docs PR.

**Files:** none.

**Steps:**

1. Run:
   ```bash
   cd /opt/data/workspace/secondbrain
   git status -sb
   git branch --show-current
   git log -1 --oneline
   ```
2. Expected before implementation:
   - Current docs branch clean.
   - Create or switch to `feature/phase-0a-papercuts` for code.
3. If dirty, inspect and decide whether to commit, stash, or stop.

**Model:** coordinator frontier.

---

### Task 1: Fix Dashboard stats field reads — UI only

**Objective:** Make Dashboard stats use canonical API fields.

**Files:**
- Modify: `packages/ui/app/page.jsx`

**Problem:**

Dashboard currently reads stale field names:

```jsx
relStats.open_insights
projStats.total
```

API stats return:

```text
relationshipsStats(): pending_insights
projectsStats(): total_projects
```

**Nuance from review:**

- `projStats.total` is the real visible bug because it falls to `0`.
- `relStats.open_insights` falls back to `relInsights.length`, so it is less severe but should still be corrected.

**Implementation:**

Use canonical fields in the UI. Do not add server-side aliases in Phase 0A.

```jsx
Number(relStats.pending_insights || relInsights.length || 0)
Number(projStats.total_projects || 0)
Number(projInsights.length || 0) // project insight card; API has no projStats.open_insights field
```

Remove stale reads of both `projStats.total` and `projStats.open_insights`.

**Verification:**

```bash
grep -R "relStats.open_insights\|projStats.total\|projStats.open_insights" -n packages/ui/app || true
npm --workspace=packages/ui run lint || true
npm --workspace=packages/ui run build || true
```

If build/lint is blocked by missing deps/env, record exact output.

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/ui/app/page.jsx
git commit -m "fix: align dashboard stats field names"
```

---

### Task 2: Make `my_role` editable and sticky

**Objective:** Allow manual correction of relationship perspective.

**Files:**
- Modify: `packages/ui/server.js`
- Modify: `packages/ui/app/relationships/page.jsx`

**Problem:**

`my_role` exists, is displayed, and is respected in agent upserts, but is not exposed in contact edit UI/API allowlist.

**Implementation:**

1. Add `my_role` to the allowed PATCH fields in `packages/ui/server.js`.
2. Add edit state in `relationships/page.jsx`.
3. Populate the edit value in `openEditModal()`.
4. Include `my_role` in the PATCH updates payload.
5. Add a form input labelled “Your role relative to this contact”.
6. Do not add special `manual_overrides` code unless inspection proves necessary; existing PATCH logic already tracks changed fields into `manual_overrides`.

**Verification:**

```bash
grep -n "my_role" packages/ui/server.js packages/ui/app/relationships/page.jsx
npm --workspace=packages/ui run lint || true
npm --workspace=packages/ui run build || true
```

If DB/UI is available, PATCH a test contact and confirm `manual_overrides` includes `my_role`.

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/ui/server.js packages/ui/app/relationships/page.jsx
git commit -m "fix: allow manual editing of contact relationship role"
```

---

### Task 3: Replace hardcoded WhatsApp self JID without changing export shape

**Objective:** Remove hardcoded Prateek-specific WhatsApp JID without breaking current imports.

**Files:**
- Modify: `packages/agents/relationships/services/extractor.js`
- Do **not** modify `packages/agents/relationships/services/insights.js` unless you intentionally change its import/call shape.
- Modify: `.env.example`
- Optionally modify: `AGENTS.md` or repo docs.

**Current issue:**

```js
const MY_WA_JID = '919830049540@c.us'
```

`MY_WA_JID` is exported by `extractor.js` and imported by `insights.js`. Do not turn it into a function unless every call site is updated.

**Precondition before implementation:**

Confirm the deployment environment already has a self JID configured before introducing module-load failure:

```bash
grep -E '^(WHATSAPP_SELF_JID|MY_WA_JID)=' /opt/data/workspace/secondbrain/.env.local
```

If absent and the value cannot be supplied, defer Task 3. Do not land a change that bricks `npm run relationships` on startup.

**Phase 0A implementation:**

Preserve synchronous export shape:

```js
const MY_WA_JID = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID
if (!MY_WA_JID) {
  throw new Error('WHATSAPP_SELF_JID env var is required for WhatsApp relationship analysis')
}
```

Add to `.env.example`:

```bash
WHATSAPP_SELF_JID=your-number@c.us
```

**Follow-up design note:**

Eventually unify this with `system.config` / Agents UI (`system.WHATSAPP_SELF_JID`), but that requires a clean async initialization path because `getConfig()` is async and `extractor.js` currently exports a synchronous constant.

**Verification:**

```bash
grep -R "919830049540" -n packages/agents/relationships .env.example AGENTS.md || true
grep -R "MY_WA_JID" -n packages/agents/relationships
node -c packages/agents/relationships/services/extractor.js
node -c packages/agents/relationships/services/insights.js
WHATSAPP_SELF_JID=dummy@c.us node -e "const { MY_WA_JID } = require('./packages/agents/relationships/services/extractor'); if (typeof MY_WA_JID !== 'string') process.exit(1)"
```

Also verify that `insights.js` still passes a string, not a function, to SQL. `node -c` alone is insufficient because it does not execute module-load code.

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/agents/relationships/services/extractor.js .env.example AGENTS.md
git commit -m "fix: configure WhatsApp self JID for relationship analysis"
```

---

### Task 4: Honor DB-configured research providers

**Objective:** Fix the research provider gating bug without making unconfigured providers noisy.

**Files:**
- Modify: `packages/agents/research/index.js`

**Problem:**

Provider modules mostly read keys via async `getConfig('system.KEY')`, but `research/index.js` filters providers using `process.env` first:

```js
providers.filter(p => !!process.env[keyMap[p.name]])
```

Provider behavior differs:

- Tavily/OpenAI/SerpAPI throw if config is missing.
- PeopleDataLabs returns a `not_configured` object.

Therefore do **not** blindly call every provider.

**Implementation:**

1. Import `getConfig` in `research/index.js`.
2. Resolve active providers once per research run, before the contact loop in `runResearch()`, not inside `researchContact()`:
   ```js
   async function resolveActiveProviders() {
     const active = []
     for (const p of providers) {
       const key = await getConfig(`system.${keyMap[p.name]}`)
       if (key) active.push(p)
     }
     return active
   }
   ```
3. Pass `activeProviders` into `researchContact(contact, activeProviders)`.
4. Log active/skipped providers once per agent run. Avoid per-contact noisy error logs for unconfigured providers.
5. Preserve `Promise.allSettled()` handling for configured providers.

**Verification:**

```bash
node -c packages/agents/research/index.js
grep -R "activeProviders\|process.env.*API_KEY" -n packages/agents/research
```

If DB is available, run a single-contact dry run with only one provider configured and verify only that provider runs.

**Model:** second-tier implementation; frontier review.

**Commit:**

```bash
git add packages/agents/research/index.js
git commit -m "fix: honor database-configured research providers"
```

---

### Task 5: Remove duplicate research schema DDL

**Objective:** Clarify schema ownership and avoid drift.

**Files:**
- Modify: `packages/agents/research/sql/schema.sql`

**Problem:**

`research/sql/schema.sql` duplicates `relationships.contacts` column additions owned by `relationships/sql/schema.sql`.

**Implementation:**

Remove duplicate `ALTER TABLE relationships.contacts ADD COLUMN IF NOT EXISTS my_role...` and `research_summary...` from research schema. Add a short comment if useful:

```sql
-- relationships.contacts profile columns are owned by packages/agents/relationships/sql/schema.sql
```

Fresh-environment guard: after removing duplicate DDL, verify research startup cannot silently fail if relationships schema has not initialized. Either confirm `packages/ui/server.js` initializes relationships schema before research schema in the normal startup path, or add a startup check in `research/index.js`:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_schema='relationships'
  AND table_name='contacts'
  AND column_name IN ('my_role', 'research_summary')
```

If either column is missing, log a clear dependency error instead of allowing per-contact write failures.

**Verification:**

```bash
grep -n "my_role\|research_summary" packages/agents/research/sql/schema.sql packages/agents/relationships/sql/schema.sql
```

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/agents/research/sql/schema.sql
git commit -m "chore: remove duplicate research schema contact columns"
```

---

### Task 6: Clarify scheduled analysis controls

**Objective:** Avoid misleading UI labels that imply immediate analysis runs.

**Files:**
- Modify: `packages/ui/app/relationships/page.jsx`
- Modify: `packages/ui/app/projects/page.jsx`
- Usually no server change needed.

**Current behavior:**

Server already returns messages like:

```text
Analysis runs on the agent's schedule. Restart the agent to trigger immediately.
```

**Implementation:**

1. Change button label from `Run Analysis` to `Analysis Status` or `Check Analysis Status`.
2. Ensure UI surfaces the server response message in the toast.
3. Defer true on-demand IPC/queue trigger design.

**Verification:**

```bash
grep -R "Run Analysis\|Analysis Status\|Check Analysis Status" -n packages/ui/app/relationships packages/ui/app/projects
npm --workspace=packages/ui run build || true
```

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/ui/app/relationships/page.jsx packages/ui/app/projects/page.jsx
git commit -m "fix: clarify scheduled analysis controls"
```

---

### Task 7: Fix cross-person opportunity scan incrementality

**Objective:** Stop the cross-person opportunity detector from always re-scanning 30 days.

**Files:**
- Modify: `packages/agents/relationships/services/opportunities.js`

**Current bug:**

```js
Math.min(new Date(lastRunAt), Date.now() - 30 * 24 * 60 * 60 * 1000)
```

This chooses the older timestamp, so recent runs still scan from 30 days ago.

**Implementation:**

Use the more recent of `lastRunAt` and the 30-day floor:

```js
const since = lastRunAt
  ? new Date(Math.max(new Date(lastRunAt).getTime(), Date.now() - 30 * 24 * 60 * 60 * 1000))
  : null
const digest = await buildCrossSourceDigest(since)
```

**Verification:**

```bash
grep -n "Math.min\|Math.max\|buildCrossSourceDigest" packages/agents/relationships/services/opportunities.js
node -c packages/agents/relationships/services/opportunities.js
```

Add a small unit-style script if feasible to assert recent `lastRunAt` wins over the 30-day floor.

**Model:** second-tier coding model; frontier fallback.

**Commit:**

```bash
git add packages/agents/relationships/services/opportunities.js
git commit -m "fix: make cross-person opportunity scan incremental"
```

---

## Phase 0B — Live Data Quality Audit + Smoke Verification

### Task 8: Create read-only audit and smoke-test script skeleton

**Objective:** Prepare safe audit/smoke checks that can run when `DATABASE_URL` is configured.

**Files:**
- Create: `scripts/audit-secondbrain-quality.js` or `packages/tools/audit-secondbrain-quality.js` if tools package exists.
- Create: `docs/plans/secondbrain-live-audit-queries.md`

**Script should report:**

Source freshness:
- `email.emails` count + max date
- `public.messages` count + max `ts`
- `limitless.lifelogs` count + max `start_time`

Derived freshness:
- `relationships.contacts` count + max `last_interaction_at`
- open `relationships.insights`
- `projects.projects` count + max `last_activity_at`

Quality indicators:
- duplicate normalized names
- contacts with only phone-number names
- strong/moderate contacts missing company/job title
- open insights older than 30/60/90 days
- project communications with null `contact_id`

Smoke gates:
- `/api/relationships/stats` field names match UI reads.
- `/api/projects/stats` field names match UI reads.
- `my_role` PATCH persists and appears in `manual_overrides` when a safe test contact is available.
- `WHATSAPP_SELF_JID` missing fails loudly, not silently.
- Research provider preflight shows active/skipped providers without calling unconfigured APIs.

Schema drift check:
- Compare live DB columns for touched tables against checked-in schema expectations.
- Report drift, do not auto-migrate.

**Verification:**

Without DB:

```bash
node scripts/audit-secondbrain-quality.js
# expected: clear DATABASE_URL required message
```

With DB:

```bash
node scripts/audit-secondbrain-quality.js --redact
```

**Model:** second-tier implementation; low-cost for bulk report compaction; frontier interpretation.

---

## Phase 1 — Opportunity Ledger Design Spike

Do not implement until Phase 0A is complete and Phase 0B audit has at least one run.

### Task 9: Draft schema migration for first-class opportunities

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
- Redesign cross-person deduplication; do not rely on title truncation + contact IDs.
- Treat `relationships.communications` as existing evidence substrate before adding a separate `intelligence.evidence_items` table.

**Model:** frontier database architect.

---

## Execution Protocol

### Before implementation

1. Keep current docs PR branch clean.
2. Create `feature/phase-0a-papercuts` for code.
3. Dispatch subagents only when file overlap is low.
4. Do not let two implementers edit the same file concurrently.

### Per task

1. Implementer subagent executes one task.
2. Spec reviewer subagent checks the original task spec.
3. Code quality reviewer checks conventions, regressions, and security.
4. Coordinator runs verification commands.
5. Commit each completed task separately.

### Model routing

- **Frontier:** Task 0, final review, all spec/quality reviews, Phase 1 schema/dedupe design, any true agent-control trigger design.
- **Second-tier:** Tasks 1–7 implementation if configured.
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
node -c packages/agents/relationships/services/opportunities.js
node -c packages/agents/research/index.js
```

If dependencies/env block build, report exact blocker.

---

## Revised First Subagent Dispatch Batch

Do not dispatch implementation until Prateek approves this updated plan or explicitly asks to proceed.

Once approved:

1. **Task 1 implementer — Dashboard fields**  
   Model: second-tier coding model if configured; frontier fallback.  
   Scope: `packages/ui/app/page.jsx` only.

2. **Task 1 review pair**  
   Model: frontier.  
   Spec review, then code quality review.

3. **Task 2 implementer — `my_role` editing**  
   Model: second-tier coding model if configured; frontier fallback.  
   Scope: `server.js` + `relationships/page.jsx`.

4. **Config/research read-only mapper in parallel only after Task 1 commit**  
   Model: low-cost if configured for search/triage; frontier validation.  
   Scope: confirm exact changes for Tasks 3–4, no edits.

Then proceed serially through Tasks 3–7. Do not run two editing subagents against `server.js` or the same UI file concurrently.

---

## Success Criteria For First Work

- Dashboard stats use canonical API fields where they exist; project insight card uses `projInsights.length` directly because `projectsStats()` has no `open_insights` field yet.
- `my_role` can be manually edited and becomes sticky through existing `manual_overrides` behavior.
- Hardcoded WhatsApp self JID is removed without changing the `MY_WA_JID` export shape.
- Research provider gating honors DB-configured API keys and avoids calling unconfigured providers.
- Duplicate research-schema contact-column DDL is removed.
- Run-analysis UI no longer misleads the user.
- Cross-person opportunity scan is actually incremental.
- A read-only live audit/smoke script exists and fails safely without DB credentials.
- All implementation changes are separate commits on a code branch, not silently folded into the docs PR.
