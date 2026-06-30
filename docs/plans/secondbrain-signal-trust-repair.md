# SecondBrain Signal Trust Repair Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stop SecondBrain from surfacing wrong people/projects as high-value opportunities by turning suppression, recency, and closure into a trust layer instead of a pile of heuristics.

**Architecture:**
Build a small trust layer that sits in front of every promotion path into `intelligence.opportunities`. The trust layer evaluates durable suppressions, canonical recency, closure state, and role class before any detector can write an item. Then expose provenance directly in the attention payload so every surfaced item can be audited against the exact evidence and linkage state that created it.

**Tech Stack:**
Node.js, Postgres, existing intelligence agents under `packages/agents/intelligence`, Express API in `packages/ui/server.js`, UI QA in `packages/ui/qa.spec.js`.

---

## Context: What is broken

The live dashboard is mixing unrelated entities and stale activity. The failure modes are:
- false joins across contacts, projects, and generic group threads
- stale recency signals overriding recent WhatsApp/email evidence
- no durable suppression layer for user-corrected false positives
- open items that should have been closed as resolved support/admin tasks
- UI showing confidence without showing provenance

### Ground-truth examples to protect

Treat these as regression cases, not suggestions:
- Gaurav Atha is a forum buddy from The Final Frontier, not a Hartex/Rubix partner.
- Jxtapose renovation belongs to Nandita and is about PMC quote comparison/rework/final selection.
- Vikas Khemani should be a periodic check-in only.
- Mom should not be linked to investment opportunities/strategy.
- Arun Sureka is the father; the payment issue was support/IT, not a business opportunity.
- Rewant Kumar is the Axis Bank RM; FD already completed.
- Sureka Capital IC date is finalized for 7 July.
- House manager is an employee; no forced relationship item.
- Raja Roy is a Zerodha service provider; money returned 1–2 months ago.
- Anupam Thadeja was met recently in Singapore and messaged again recently; do not mark dormant.

---

## Task 1: Add suppression as a first-class evaluator

**Objective:** Make suppression a real trust gate, not a post-hoc table lookup.

**Files:**
- Modify: `packages/agents/intelligence/sql/schema.sql`
- Add: `packages/agents/intelligence/services/suppression-matcher.js`
- Modify: `packages/agents/intelligence/index.js`
- Modify: `packages/ui/server.js`
- Extend tests: `packages/agents/intelligence/__tests__/feedback-constraint.test.js`
- Extend tests: `packages/agents/intelligence/__tests__/canonical-write-paths.test.js`

**Step 1: Define the suppression schema precisely**
Add a dedicated suppression table with fields like:
- `scope_type` — `contact`, `project`, `opportunity`, `source_ref`, `pattern`
- `scope_id` — canonical id or foreign-key-style identifier
- `match_type` — `exact`, `normalized_title_hash`, `source_ref`, `pattern`
- `match_value` — normalized lookup value
- `detector` — which detector or promotion path was suppressed
- `source_system` — email, whatsapp, signals, projects, relationships, manual
- `reason_code` — `wrong_person`, `wrong_project`, `already_closed`, `not_useful`, `suppress_pattern`
- `note`
- `created_by`
- `expires_at`
- `active`
- `metadata`

Prefer exact source refs, canonical contact/project ids, and normalized title hashes. Pattern suppression should be opt-in, not the default.

**Step 2: Add `suppression-matcher.js`**
Create a small service that takes a candidate opportunity and returns whether it should be blocked, plus the matched suppression record and reason.

Minimum match order:
1. exact `source_ref`
2. canonical `contact_id` / `project_id`
3. exact `normalized_title_hash`
4. opt-in pattern suppression

**Step 3: Call the matcher before every promotion path**
Invoke the suppression matcher before each detector writes to `upsertOpportunity`.
Also add a final guard inside `upsertOpportunity`, because there are multiple write paths in `index.js`.

**Step 4: Separate feedback from durable suppression**
Update the UI/API feedback flow so explicit actions are distinct:
- `wrong_person`
- `wrong_project`
- `already_closed`
- `not_useful`
- `suppress_pattern`

Not every dismiss should become a durable negative. Only explicit suppress actions should create durable suppression records.

**Step 5: Add regression tests**
Extend the existing tests to cover:
- a suppressed `source_ref` is not re-promoted
- a suppressed contact/project does not reappear as a strategic opportunity
- negative feedback can create a durable suppression record only when the action is explicit
- a real strategic item still survives suppression gating

**Verification:**
- The matcher blocks known bad items before promotion.
- `upsertOpportunity` cannot reinsert a suppressed item through a side path.
- At least one real strategic opportunity still survives the trust gate.

---

## Task 2: Fix canonical recency and closure flow

**Objective:** Stop stale `last_interaction_at` values from beating newer WhatsApp/email/communications evidence, and distinguish closure from false positive.

**Files:**
- Modify: `packages/agents/intelligence/services/contact-tierer.js`
- Modify: `packages/agents/intelligence/services/dormancy-monitor.js`
- Modify: `packages/agents/intelligence/index.js`
- Extend tests: `packages/agents/intelligence/__tests__/relationship-recency-source.test.js`
- Extend tests: `packages/agents/intelligence/__tests__/dormancy-monitor.test.js`

**Step 1: Make recency canonical**
`tierContacts()` already computes an effective last interaction timestamp from communications, touches, WhatsApp, and duplicate decisions. Make that value the canonical recency source.

Do one of these, explicitly:
- pass `effective_last_interaction_at` into dormancy checks, or
- persist a derived `effective_last_interaction_at` / canonical touch row and read that everywhere.

Do not let `checkDormancy()` recompute from stale raw contact rows.

**Step 2: Fix dormancy at the boundary**
Update `checkDormancy()` so it consumes canonical recency, not a plain contact row that may be stale.
This is the bug that can preserve Anupam-style dormancy mistakes even after tiering logic is correct.

**Step 3: Treat resolved states as closure**
When the evidence says any of the following, mark the item as closure, not false positive:
- completed FD
- money returned
- finalized IC date
- resolved support issue
- periodic check-in only

Use `actioned` / `expired` / closed-with-reason semantics instead of defaulting to `false_positive`.

**Step 4: Add closure reason codes**
Create a small set of closure states such as:
- `resolved_support`
- `completed_finance_action`
- `finalized_date`
- `periodic_check_in_only`
- `returned_funds`

These are useful for learning and for suppressing re-surfacing without pretending the original signal was nonsense.

**Verification:**
- Dormancy uses the same recency truth as tiering.
- Anupam does not show as stale if newer WhatsApp evidence exists.
- Rewant/Raja/Arun-style completed items are closed, not just dismissed.

---

## Task 3: Move closure/admin logic out of SQL scoring

**Objective:** Stop growing more text heuristics inside the attention view.

**Files:**
- Modify: `packages/agents/intelligence/sql/schema.sql`
- Add: `packages/agents/intelligence/services/attention-classifier.js`
- Modify: `packages/agents/intelligence/index.js`
- Extend tests: `packages/agents/intelligence/__tests__/attention-scoring.test.js`

**Step 1: Introduce classifier outputs**
Create a small helper that emits:
- `resolution_state` — open, closed, expired, suppressed
- `role_class` — strategic, operational, vendor, employee, family, service_provider, relationship_manager, household_staff
- `quality_flags` — concise derived flags for the view

**Step 2: Make SQL consume classifier outputs**
Keep SQL scoring focused on ranking, but let it consume the classifier fields instead of expanding phrase-by-phrase checks.
This keeps the scoring view from becoming a giant rule graveyard.

**Step 3: Preserve existing useful penalties**
Keep the current penalties that are working, but move brittle closure/admin detection into the helper.
The SQL layer should not keep accreting special cases for every new false positive.

**Verification:**
- The attention view uses classifier outputs instead of raw phrase growth for closure/admin cases.
- Existing good penalties stay in place.
- The view stays simpler after the change, not more complicated.

---

## Task 4: Tighten detector join rules and role suppression

**Objective:** Reduce false joins caused by broad project matching and over-aggressive entity merging.

**Files:**
- Modify: `packages/agents/intelligence/services/cross-channel-project-detector.js`
- Modify: `packages/agents/intelligence/services/home-improvement-detector.js`
- Modify: `packages/agents/intelligence/services/relationship-open-loop-detector.js`
- Modify: `packages/agents/intelligence/services/contact-tierer.js`
- Extend tests: `packages/agents/intelligence/__tests__/cross-channel-project-detector.test.js`
- Extend tests: `packages/agents/intelligence/__tests__/home-improvement-detector.test.js`
- Extend tests: `packages/agents/intelligence/__tests__/relationship-open-loop-detector.test.js`

**Step 1: Require stronger evidence for cross-channel projects**
Only promote a project opportunity when there is:
- a named owner or direct participant
- a concrete pending decision or blocked next step
- non-generic topic evidence
- enough corroboration across sources

**Step 2: Suppress low-trust roles by default**
Explicitly suppress or down-rank contacts whose role is:
- `employee`
- `service_provider`
- `vendor`
- `relationship_manager`
- `household_staff`

Do this unless there is direct evidence of strategic importance.

**Step 3: Split project vs admin signals**
If the item is really support/admin work, do not let it become a strategic project opportunity.
That is exactly how Arun/Rewant/Raja-style items drift into the wrong lane.

**Step 4: Make home-improvement detection owner-aware**
Home renovation items should attach to the correct owner and active decision, not just a project label.

**Verification:**
- Gaurav Atha / Hartex-Rubix no longer promotes as a false join.
- Jxtapose resolves to the right owner and active decision.
- Relationship open-loop detection does not surface already-closed or low-value admin interactions.

---

## Task 5: Add provenance-first output to the attention payload and UI

**Objective:** Make every surfaced card explainable and auditable.

**Files:**
- Modify: `packages/ui/server.js`
- Modify: dashboard components under `packages/ui/app/**`
- Extend: `packages/ui/qa.spec.js`

**Step 1: Add provenance fields to `/api/intelligence/attention`**
Return these directly in the attention payload:
- `provenance_summary`
- `top_evidence`
- `source_refs`
- `linkage_state`
- `resolution_state`
- `role_class`

Keep the existing drilldown/evidence route for full detail, but the top-level payload should already explain itself.

**Step 2: Show unresolved linkage state**
If an item has no valid entity link, the UI should show that clearly instead of implying certainty.

**Step 3: Add explicit user actions**
Add UI/API actions for:
- wrong person
- wrong project
- already closed
- not useful
- suppress this pattern

These actions should feed the suppression/closure layer, not just mutate a status field.

**Step 4: Smoke-test the UI**
Add or update a QA spec so that:
- provenance text is visible
- null/wrong links do not appear clickable
- dismissing an item creates the correct durable action or closure path

**Verification:**
- The dashboard shows why each item surfaced.
- The user can tell strategic opportunities from stale admin/support items.
- Dead links and wrong entity cards stop pretending to be authoritative.

---

## Task 6: Backfill active suppressions and closures

**Objective:** Clean up already-open bad cards after the new trust layer exists.

**Files:**
- Modify: `packages/agents/intelligence/index.js`
- Optional: `packages/ui/server.js`
- Optional: add a small backfill script under `packages/agents/intelligence/scripts/` if that fits the repo better

**Step 1: Add a one-time reconciliation pass**
After creating suppressions, run a one-time backfill that scans open opportunities and applies:
- dismissal for suppressed false positives
- closure for already-resolved admin/support items
- retention for real strategic items

**Step 2: Make the backfill explicit and reversible**
The backfill should be deterministic and logged, so you can see exactly what it changed.

**Step 3: Leave real opportunities open**
Do not sweep everything closed. The backfill is a cleanup pass, not a blanket reset.

**Verification:**
- Existing bad cards no longer linger after deploy.
- Real strategic items remain visible.
- Backfill logs show which cards were suppressed vs closed.

---

## Implementation order

1. **Task 5 first** — add failing regression fixtures, including one positive-survival strategic item.
2. **Task 1** — suppression as a first-class evaluator.
3. **Task 2** — canonical recency and closure flow.
4. **Task 3** — move brittle closure/admin logic out of SQL scoring.
5. **Task 4** — tighten detectors and role suppression.
6. **Task 6** — backfill already-open bad cards.

---

## Done means

- The known false positives do not reappear after a fresh intelligence run.
- Suppression is durable, explicit, and scoped.
- Dormancy uses canonical recency, not stale contact rows.
- Already-resolved items become closure, not just false positives.
- Every surfaced item can show why it exists.
- At least one real strategic item still survives the new trust gate.
- The dashboard stops pretending weak signals are strategic truth.
