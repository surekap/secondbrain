# Relationship Intelligence Status + Next Plan — 2026-06-24

> Historical document. It is not an operational runbook. The one-shot
> `backfill-intelligence-*` and `backfill-communication-events` commands below
> were retired by the 2026-07-20 canonical recovery. Use the durable recovery
> and intelligence runners documented in `docs/architecture/README.md`.

> **For Hermes:** Use `software-delivery-workflow` for implementation and verification. Use `subagent-driven-development` only after the server/API is reachable and the next slice is selected.

**Goal:** Record what has actually shipped, what is verified from code, what is blocked in live runtime, and the next implementation sequence for SecondBrain’s relationship-intelligence / attention-allocation system.

**Architecture:** Keep the local workstation as the trusted ingestion/runtime boundary. Treat `intelligence.opportunities` + `intelligence.attention_queue` as the first-class action ledger, but keep evidence dates, quality flags, and smoke/audit checks visible so the dashboard does not imply false freshness or false confidence.

**Tech Stack:** Node.js npm workspaces, Next.js UI on `4000`, Express API on `4001`, PostgreSQL, `packages/agents/intelligence/sql/schema.sql`, `packages/ui/server.js`, `packages/ui/app/page.jsx`.

---

## 1. Current repo state verified from Hermes

Checked on: `2026-06-24T05:58:35Z` to `2026-06-24T06:00Z`.

```text
repo: /opt/data/workspace/secondbrain
branch after pull: main
HEAD: acb73f1 fix: map signal opportunities to research_opportunity enum value
origin/main: acb73f1
working tree: clean after pull before this docs update
```

Merged PRs now included in `main`:

| PR | Status | Purpose |
|---:|---|---|
| #10/#11 | merged | Observe/API integration + agent recovery work |
| #12 | merged | Observe health + attention quality metadata |
| #13 | merged | Stale telemetry cleanup endpoint/action |
| #14 | merged | Opportunity next-action derivation/backfill |
| #15 | merged | Intelligence entity graph schema/API foundation |
| #16 | merged | Group opportunities into opportunity ledger |
| #17 | merged | Holistic intelligence smoke script |
| #18 | merged | Dampen thin group opportunities in attention ranking |
| #19 | merged | Source/evidence dates in attention queue |

Important code markers present on `main`:

```text
packages/agents/intelligence/sql/schema.sql
  source_first_seen_at / source_last_seen_at
  group_single_evidence / unlinked_group_opportunity

packages/ui/server.js
  source date aggregation from opportunity_evidence.occurred_at
  group opportunity quality penalties

packages/ui/app/page.jsx
  dashboard label uses `source ...` / `source updated ...`
```

---

## 2. Local code verification from Hermes

These checks passed after `git pull --ff-only`:

```bash
node --check packages/ui/server.js
node --check packages/agents/intelligence/index.js
npm run build --workspace=packages/ui
node --test packages/agents/intelligence/__tests__/*.test.js
```

Notes:

- Root `package.json` does **not** define `npm test`; `npm test -- ...` fails with `Missing script: "test"`.
- For the current intelligence tests, use Node’s built-in runner directly:

```bash
node --test packages/agents/intelligence/__tests__/*.test.js
```

---

## 3. Live server status from Hermes

Hermes attempted to connect to the declared runtime host:

```text
host: 100.105.11.84 / ps-macbook-pro.tail95d995.ts.net
expected UI:  http://100.105.11.84:4000
expected API: http://100.105.11.84:4001
```

Observed from Hermes:

| Endpoint / Port | Result |
|---|---|
| `100.105.11.84:3000` | connection refused |
| `100.105.11.84:4000` | connection refused |
| `100.105.11.84:4001` | connection refused |
| `100.105.11.84:4002` | connection refused |
| `100.105.11.84:4003` | connection refused |
| `100.105.11.84:8000` | connection refused |
| `100.105.11.84:8080` | connection refused |
| Browser `http://100.105.11.84:4000` | `ERR_CONNECTION_REFUSED` |

Conclusion: from Hermes, the SecondBrain server is currently **not reachable**. This is not an application-level 500 or schema error; it is a TCP connection refusal. Possible causes:

1. `npm run ui` is not actually running on the workstation.
2. It is running bound only to a different interface/port.
3. The workstation/Tailscale path is reachable for DNS but not accepting TCP on those ports.
4. A local firewall or process supervisor killed/restarted the services after the pull.

Do **not** claim live deployment is healthy until `/api/observe/health`, `/api/intelligence/attention`, and browser hydration are checked again from Hermes.

---

## 4. What is working vs not working

### Working in code

- Opportunity ledger schema exists.
- Evidence tables exist in schema.
- Attention queue view exists.
- Next-action derivation exists.
- Group opportunities are bridged into the ledger.
- Thin group opportunities are penalized/flagged.
- Source/evidence dates are exposed and used in dashboard labels.
- Holistic smoke script exists.
- On-demand refresh endpoint exists in latest main: `POST /api/intelligence/refresh`.
- Intelligence services now include signal extraction, backfill, dormancy monitoring, and organization extraction.

### Not verified live right now

- UI port `4000` availability.
- API port `4001` availability.
- `/api/intelligence/refresh` runtime behavior.
- Whether live DB schema has been initialized to latest `schema.sql`.
- Whether existing evidence rows have `occurred_at` populated after PR #19.
- Whether dashboard now shows `source 3mo ago` for old WhatsApp/email-derived opportunities.
- Whether the graph tables have meaningful rows after org/topic extraction.

### Known live-data issue likely still pending

After PR #19 is deployed, old evidence rows need the opportunity backfill rerun so conflict upserts can fill `opportunity_evidence.occurred_at`:

```bash
node scripts/backfill-intelligence-opportunities.js --write --limit=5000
```

Then rerun:

```bash
node scripts/backfill-intelligence-next-actions.js --write --limit=5000
node scripts/holistic-intelligence-smoke.js --require-db
```

---

## 5. Immediate operator runbook

Run on the workstation/runtime host:

```bash
cd /opt/data/workspace/secondbrain
git checkout main
git pull --ff-only
npm run build --workspace=packages/ui
npm run ui
```

In a second terminal on the workstation:

```bash
curl -sS http://localhost:4001/api/observe/health | jq '.sampler_status, .sampler_age_seconds'
curl -sS 'http://localhost:4001/api/intelligence/attention?limit=5' | jq '.[0] | {id,title,source_first_seen_at,source_last_seen_at,first_seen_at,last_seen_at,quality_flags,recommended_next_action}'
curl -sS http://localhost:4001/api/intelligence/graph/summary | jq .
```

If local checks pass but Hermes still sees connection refused, test binding/firewall:

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:4001 -sTCP:LISTEN
curl -sS http://100.105.11.84:4001/api/observe/health | jq .
```

Expected binding for UI/API should include `0.0.0.0` or the Tailscale interface, not only `127.0.0.1`.

---

## 6. Next implementation plan

### Task A — Re-establish live runtime verification

**Objective:** Restore a reachable UI/API and prove the deployed code is current.

**Files:** none unless startup scripts are wrong.

**Verification:**

```bash
curl -sS http://100.105.11.84:4001/api/observe/health
curl -sS 'http://100.105.11.84:4001/api/intelligence/attention?limit=5'
```

Hermes browser verification:

- Navigate to `http://100.105.11.84:4000`.
- Confirm dashboard hydrates.
- Confirm browser resource timings include `/api/intelligence/attention?limit=5` with status `200`.
- Confirm console has `0` JS errors.

**Exit criteria:** UI and API reachable from Hermes.

---

### Task B — Populate source dates on existing evidence

**Objective:** Fix old opportunities showing as newly seen due to ledger ingest time.

**Commands on runtime host:**

```bash
node scripts/backfill-intelligence-opportunities.js --write --limit=5000
node scripts/backfill-intelligence-next-actions.js --write --limit=5000
node scripts/holistic-intelligence-smoke.js --require-db
```

**Verification:**

```bash
curl -sS 'http://localhost:4001/api/intelligence/attention?limit=10' \
  | jq '.[] | {id,title,source_first_seen_at,source_last_seen_at,first_seen_at,last_seen_at,quality_flags}'
```

**Exit criteria:** old WhatsApp/email/group items show communication/source ages, not backfill ages.

---

### Task C — Run latest intelligence refresh once manually

**Objective:** Exercise `POST /api/intelligence/refresh` against the live DB.

**Command:**

```bash
curl -sS -X POST http://localhost:4001/api/intelligence/refresh | jq .
```

**Expected:** JSON response with service results for signal extraction, backfill, dormancy, and organization extraction. If it fails, capture exact error; do not paper over it.

**Exit criteria:** Refresh either succeeds or produces a concrete fixable error.

---

### Task D — Audit graph/entity population quality

**Objective:** Decide whether org/topic extraction is useful enough to show in product or should remain backend-only.

**Implementation update:** `runIntelligenceServices()` now actively extracts organizations/topics from contacts, groups, and opportunities and writes `intelligence.organizations`, `intelligence.contact_organizations`, `intelligence.topics`, and `intelligence.object_topics`. It no longer logs “Organization extraction skipped”.

**Commands:**

```bash
curl -sS -X POST http://localhost:4001/api/intelligence/refresh | jq .
curl -sS http://localhost:4001/api/intelligence/graph/summary | jq .
curl -sS 'http://localhost:4001/api/intelligence/organizations?limit=20' | jq '.[] | {id,name,organization_type,strategic_importance_score,contact_count}'
curl -sS 'http://localhost:4001/api/intelligence/topics?limit=20' | jq '.[] | {id,name,topic_type,strategic_weight,link_count}'
```

**Exit criteria:** Graph counts should become nonzero after refresh. If they stay zero, inspect DB input quality (`relationships.contacts.company`, contact email domains, `relationships.groups`, and opportunity titles/descriptions) before exposing graph UI.

---

### Task F — Weak-signal extraction v1.5

**Objective:** Move from email-only/regex toy extraction toward a durable, source-aware signal memory.

**Implemented:**

- Extracts signals from recent `email.emails`, `public.messages`, `limitless.lifelogs`, `relationships.groups`, and `intelligence.opportunities`.
- Upserts into `intelligence.signals` by `(source_table, source_id, signal_type)`.
- Stores `occurred_at`, `confidence`, `strength`, `source_ref`, `contact_id` where resolvable, `project_id`, and metadata.
- Stops creating opportunity rows directly from every email signal; weak signals now accumulate separately until promotion logic is worth adding.

**Remaining:** semantic retrieval and cross-signal threshold promotion are still future work.

---

### Task G — Scoring v1.5

**Objective:** Reduce priority-only scoring.

**Implemented:** `upsertOpportunity()` now computes `expected_value_score` from impact, urgency, relationship leverage, actionability, confidence, and evidence/group penalties. The attention queue still applies final display penalties for weak evidence, missing next action, stale items, and group spam.

**Remaining:** strategic-fit, effort-cost, silence-risk, and feedback-learned penalties are not yet first-class fields.

---

### Task E — Add a durable runtime smoke command

**Objective:** Make the common live verification one command so future restarts don’t rely on memory.

**Proposed file:** `scripts/secondbrain-live-smoke.js`

**Checks:**

- ports/API routes reachable
- observe sampler freshness
- attention items include evidence count + source date fields
- missing next actions count
- graph summary non-error
- optional browser hydration checklist documented if not automatable

**Exit criteria:** One command reports `ok: true/false` with specific failing gates.

---

## 7. Decision points before expanding product surface

Do not add more UI surface until these are true:

1. Hermes can reach the live server reliably.
2. Source dates are correct in attention cards.
3. `missing_next_action` is near zero after backfill.
4. Thin group opportunities no longer crowd the top five unless genuinely high-value.
5. Graph/entity extraction produces nonzero, plausible org/topic records.
6. At least one manual `POST /api/intelligence/refresh` has succeeded or produced a root-caused failure.

If these are not true, the next work is operational quality, not new features.
