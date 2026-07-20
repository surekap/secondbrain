# SecondBrain Communication Intelligence Improvement Plan

**Date:** 2026-07-20
**Scope:** contact identity, cross-channel communication organization, relationship intelligence, projects, issues, insights, and opportunities

## Executive conclusion

The current quality problem is not primarily a model-selection problem. Two adapter regressions prevent stable identities and email communications from entering the relationship layer, while the newer intelligence pipeline is neither scheduled nor currently safe to run from a partially initialized database. Downstream models are therefore reasoning over fragmented, stale, and mostly unlinked evidence.

The correct order of work is:

1. Repair source-to-identity and source-to-communication ingestion.
2. Make identity resolution deterministic, conflict-aware, and actually executable from the UI.
3. Establish one canonical, idempotent communication/event layer across direct messages, groups, email, Limitless, and analyzed media.
4. Replace keyword “signals” with evidence-backed claims and a single intelligence-item lifecycle.
5. Add a precision-first evaluation and feedback loop before further prompt or model tuning.

Changing models again before steps 1–3 would mostly make a stronger model interpret the wrong inputs more confidently.

## Implementation status

This plan was implemented as the 2026-07-20 architecture-recovery release. The
baseline and root-cause counts below remain the pre-change audit record; they
must not be read as the current database state.

Delivered in this release:

- corrected Apple Contact value parsing and international identity
  normalization, removed name-only automatic matching, recorded conflicts, and
  made exact stable-identity merges transactional and redirect-backed;
- established an idempotent canonical communication recovery path for email,
  WhatsApp direct and group messages, Limitless, and media semantic text, with
  source-lineage quarantine instead of invented raw evidence;
- made WhatsApp history durable through database runs, fixed-window page
  checkpoints, per-chat/group watermarks, bounded reconnect overlap, and
  visible failure rather than truncated-success reporting;
- added durable guidance, clarification, claim, evidence, lifecycle, feedback,
  run, and health contracts without mutating raw source data;
- changed signal keywords into candidate generation only, with schema-bound
  semantic verification of actor, polarity, state, exact quote, and source
  evidence before promotion;
- made project discovery/classification evidence-based and convergent, including
  negative decisions and stable insight reconciliation;
- cut the dashboard and attention queue over to canonical evidence-gated items,
  with explicit lifecycle transitions and evidence-required reopening;
- made image/PDF analysis restart-safe, exhaustive for PDF pages/text chunks,
  reusable across byte-identical attachments, and visible to canonical
  communication recovery;
- added durable agent desired state, bounded restart backoff, loopback-only
  listeners, same-origin mutation protection, and private Tailscale Serve
  deployment guidance;
- removed the obsolete Limitless external-action engine, duplicated AI client,
  and broken root prototype scripts; added one root test command, strict quality
  audit, and private evaluation harness.

Legacy tables remain behind bounded compatibility write-through paths where
readers still require their IDs. They are not the dashboard source of truth,
and the invariants in `AGENTS.md` forbid adding a new writer or another ledger.
Their final physical removal follows the verified contraction protocol in
`docs/architecture/MIGRATIONS.md` rather than being combined with the live
data-repair transaction.

## What I inspected

I traced the relationship, intelligence, project, Apple Contacts, WhatsApp media, UI, schema, and model-routing code. I also ran the existing quality/smoke audits and read aggregate live-database state on 2026-07-20 IST. No source messages or personal content were copied into this report.

I also queried the existing Graphify index. It contains 123 nodes, zero edges, and does not contain the core relationship/intelligence/project paths, so it could not explain the product architecture reliably. That is itself an observability gap; the findings below are based on direct code and database inspection.

## Live baseline

| Area | Observed state | Why it matters |
|---|---:|---|
| Raw email | 46,196 messages; latest 2026-07-20 | Source is healthy. |
| Raw WhatsApp | 4,930 direct-chat rows and 85,423 group rows | Source is healthy and group data exists. |
| Raw Limitless | 1,209 lifelogs | Source exists. |
| Canonical relationship communications | 2,795 WhatsApp rows; **0 email, 0 group, 0 Limitless** | There is no real unified communication layer. |
| Contacts | 7,170 total; 7,155 non-noise | The contact population is dominated by low-information Apple rows. |
| Non-noise contacts with no email/phone/WhatsApp identity arrays | 6,948 | 97% cannot be safely joined across channels from the contact row. |
| Active contact identities | 7,393 rows | 7,077 are Apple IDs; there are 0 email identities. |
| Exact stable identifiers attached to multiple active contacts | 102 values / 204 memberships | Deterministic duplicates remain unresolved. |
| Confirmed duplicate members | 187 non-canonical members | 163 remain active; “confirmed” usually did not merge anything. |
| Ambiguous derived contact aliases | 2,049 aliases / 10,116 memberships; worst alias maps to 111 people | First/last-name aliases are unsafe for automatic entity resolution. |
| Relationship insights | 3,671 open; 2,217 older than 30 days | The legacy insight queue accumulates rather than converges. |
| Intelligence opportunities | 7,450 total; 5,017 open | 81.9% have neither a person nor project link. |
| Opportunity freshness | latest `last_seen_at` 2026-07-01 | Source ingestion is current, derived intelligence is not. |
| Weak signals | 21,090 | 99.7% are unlinked; latest update 2026-07-01. |
| Project communications | 3,243 | 100% have null `contact_id`. |
| Project insights | 180 open | All current rows are open; their evidence is not first-class. |
| WhatsApp media | 5,577 files | 2,569 analyzed and indexed, 3,004 pending; analyzed text does not feed intelligence extraction. |
| Explicit opportunity feedback events | 0 | The system has no data from which to learn personal relevance. |

The most important pattern is the freshness split: contacts, projects, email, and WhatsApp are current, while `intelligence.opportunities` and `intelligence.signals` stopped on July 1.

## Confirmed root causes

### 1. Apple Contacts silently drops stable identities

`node-mac-contacts` returns `phoneNumbers` and `emailAddresses` as arrays of strings. `packages/agents/apple-contacts/services/nativeReader.js` reads `p.value` and `e.value`, which turns those strings into empty values.

Consequences:

- More than 7,000 Apple contact rows were imported, but none has an email and only 120 non-noise Apple rows have a phone inherited from another source.
- Apple-to-WhatsApp linking falls through to exact normalized-name matching.
- Names become the de facto identity key, creating both duplicates and false merges.
- Apple IDs make the identity-coverage number look healthy even though they do not connect communication channels.

This is the single largest contact-deduplication regression.

### 2. Every email sender is skipped by the relationship agent

`getEmailContacts()` returns `{ name, email }`. The caller in `packages/agents/relationships/index.js` checks `sender.parsed_email`, a property that does not exist, before processing the sender.

The live database has 4,345 distinct raw senders but zero `relationships.email_senders`, zero contact email arrays, zero email contact identities, and zero email rows in `relationships.communications`.

This breaks:

- email-to-person identity resolution;
- cross-channel recency and relationship strength;
- email reply-gap detection that joins through `relationships.email_senders`;
- person/project opportunity linking;
- a meaningful view of a relationship across channels.

The extractor also swallows its email query errors, which made this failure appear as “no email contacts” rather than a failed invariant.

### 3. Duplicate confirmation is not a merge operation

The dashboard’s “Confirm duplicate” button calls `/api/intelligence/duplicates/decide`. The server comment accurately says this endpoint “never auto-merges”; it only writes `intelligence.duplicate_decisions`.

A separate exact-identity merge API exists, but it is not exposed in the normal UI workflow and is not scheduled. As a result, confirmed duplicate records remain active, keep separate communication histories, and continue appearing in ordinary contact reads.

The current canonical-ID helper partially masks this in some intelligence code, but most relationship/project/UI queries still read the duplicate rows directly. A decision ledger is not a substitute for canonical data.

### 4. Identity conflicts are reassigned, not resolved

`upsertContactIdentity()` uses `ON CONFLICT ... DO UPDATE SET contact_id = EXCLUDED.contact_id`. When an identity already belongs to another person, its ownership can silently move to the most recent writer rather than:

- merging two proven duplicates;
- preserving the existing owner;
- recording a conflict for review.

The live data has 102 identity memberships where the unique identity row points at one contact while another active contact still carries the same identifier in its arrays. This makes the index internally consistent while the product remains inconsistent.

### 5. Exact-name fallback is overused as identity evidence

WhatsApp, email, Apple Contacts, opportunity contact lookup, and other paths use exact normalized names as a fallback and frequently `LIMIT 1`. Exact spelling is not exact identity. Common names, spouses, assistants, shared addresses, and contact-book annotations make this unsafe.

Phone normalization is also inconsistent:

- Apple truncates to the last 10 digits.
- WhatsApp generally has a country-code number.
- the identity service strips punctuation but does not resolve a country or produce E.164.

### 6. There is no canonical multi-channel communication store

`relationships.communications` is meant to organize communication around people, but it currently contains only WhatsApp direct-message copies. Group messages remain in `public.messages`, email remains in `email.emails`, Limitless remains in `limitless.lifelogs`, project communications are copied separately, and media-derived text only enters semantic search.

The uniqueness key `(source, source_id, contact_id)` permits the same source event to be duplicated once per duplicate contact. There are 703 WhatsApp source messages attached to multiple contacts in this table.

Group participation is especially lossy: a group is summarized from the newest 50 messages, but its messages and participants are not represented as durable communication evidence linked to people, topics, projects, or claims.

### 7. The intelligence pipeline is effectively an on-demand library

`runIntelligenceServices()` is called only by `POST /api/intelligence/refresh`. It has no independent agent executable or schedule. The Intelligence page’s visible “Refresh” button only reloads GET endpoints; it does not POST to run the pipeline.

The current UI process reports no refresh history, and derived intelligence has not advanced since July 1.

There is an additional deployment hazard: `runIntelligenceServices()` does not call `ensureSchema()`. The live database is missing `intelligence.communication_events`, but the pipeline now writes to that table before signal extraction. Invoking the current pipeline can therefore do partial work and then fail.

Pipeline schema readiness, execution checkpoints, and status are held in process memory rather than a durable run ledger.

### 8. Signal extraction is keyword matching, not semantic communication understanding

`signal-extractor.js` classifies text if it contains broad regexes such as `need`, `will`, `issue`, `event`, or a city name. Confidence is a fixed formula based mostly on source and type.

It does not represent:

- who has the need, offer, concern, or intent;
- who is expected to act;
- negation (“we do not need this”);
- quoted or forwarded speech;
- whether a statement is historical, hypothetical, current, or resolved;
- the object of the claim;
- a supporting text span and counter-evidence.

This explains why 21,033 of 21,090 signals are unlinked and why the system produces volume without useful synthesis.

### 9. Signal clustering contains two structural contradictions

For a linked signal, the cluster key is only `signal_type + contact` or `signal_type + project`. Unrelated risks or intents for the same person/project are combined regardless of topic.

For an unlinked signal, the source table is part of the cluster key, but promotion requires at least two source tables. An unlinked cluster therefore cannot satisfy its own cross-source promotion rule.

This should be replaced rather than tuned with more stopwords.

### 10. Three competing intelligence ledgers drift independently

The system currently has:

- `relationships.insights`;
- `projects.project_insights`;
- `intelligence.opportunities`.

Only selected legacy insight types are copied into the opportunity ledger. Status, dismissal, resolution, evidence, and deduplication have different rules in each store. The attention queue only reads opportunities even though the dashboard separately combines relationship and project insights.

Examples of lifecycle problems:

- 3,671 relationship insights are open, including 1,888 older than 60 days.
- only 4 opportunities have ever been marked actioned;
- there are no explicit feedback events or active suppressions;
- project analysis deletes and recreates unresolved insights when it has replacements, changing IDs and evidence links;
- if a project analysis returns no insights, old unresolved insights are not cleared;
- one meeting can produce several action items, but all use the same `lifelog:<id>` source ref, so they collapse into one legacy insight.

### 11. Project classification cannot converge reliably

Project discovery uses high-volume email subjects, recent lifelog titles, and high-volume WhatsApp chats rather than evidence-rich communication windows. The WhatsApp discovery comment says “last 90 days,” but the query has no time filter.

Classification problems include:

- WhatsApp is classified by whole chat, not message/thread/topic episode.
- A chat uses one source ID forever; changed classifications accumulate under different project IDs because old links are not retired.
- 12 WhatsApp chat records are currently assigned to multiple projects, with one assigned to four.
- Email and Limitless null classifications are not persisted, so the same newest non-matching batches can be retried forever and starve older rows.
- Every project communication has null `contact_id`.
- Analysis sees only 30 recent, 400-character snippets and no canonical participants or full evidence.
- The prompt requires 3–5 insights, encouraging output even when evidence is weak.

### 12. Quality controls are reactive and case-specific

The code contains expanding hard-coded word lists and named false-positive exceptions. These patches can suppress known incidents, but they do not generalize and are difficult to evaluate. The attention view has become a long SQL scoring expression with textual penalties, while the underlying opportunity rows remain stale and mostly unlinked.

The Graphify output has zero edges and misses the core product paths, so architecture changes are also hard to inspect mechanically.

## Recommended target architecture

The target should keep Postgres and the existing source tables, but establish a clean sequence of canonical layers:

```text
Raw source records
    -> canonical communication event + participants + semantic content
    -> canonical people/organizations/projects through identity resolution
    -> evidence-backed claims (need, offer, commitment, risk, decision, status)
    -> time-bounded claim clusters with closure/counter-evidence
    -> intelligence items (opportunity, issue, insight, action)
    -> personalized ranking and feedback
```

### Canonical identity

Keep `relationships.contacts` as the canonical person row for now; a new top-level `people` table is unnecessary until the current contract is stable.

Add or enforce:

- `contact_identities` as the only matching authority, with normalized and raw values plus source provenance;
- `identity_conflicts` for an identity claimed by two active contacts;
- `contact_merge_redirects(from_contact_id, to_contact_id, reason, merged_at)` so every read can canonicalize old IDs;
- source-specific person candidates, or sufficient provenance on identities, so an imported source record is not mistaken for a canonical person;
- E.164 normalization with an explicit default region and preserved raw number;
- merge transactions that update every current foreign key and leave an auditable redirect.

Matching policy:

| Evidence | Default action |
|---|---|
| Same WhatsApp JID, normalized email, or full E.164 phone | Auto-merge if there is no contradictory person-level stable identity. |
| Apple contact IDs | Treat as source-card provenance. Multiple distinct Apple cards may map to one canonical person and are not counter-evidence to an exact person-level match. |
| Same phone suffix plus corroborating name/company | Review queue. |
| Same full name plus another independent signal | Review queue. |
| Name only, first name, last name, or broad alias | Never auto-merge. Use only for search suggestions. |
| Stable identity already owned by another active contact | Record conflict; never silently reassign. |

### Canonical communication event

Evolve `relationships.communications` or replace it behind a compatibility view with:

- one event per `(source, account, external_id)`;
- direction, conversation/thread ID, occurred time, raw-source reference, and content hash;
- `communication_participants(event_id, contact_id, role, confidence)` for sender, recipient, mentioned person, and group participant;
- `communication_projects` and `communication_topics` link tables rather than duplicated message copies;
- original text, normalized text, attachment text, and media semantic description as separate content variants;
- an explicit unresolved-participant state rather than a null silently treated as success.

Group messages must retain group context and the sending participant. Media descriptions and PDF summaries should become another content variant on the original WhatsApp event, not merely a separate search document.

### Evidence-backed claims

Replace keyword signals with structured claims:

```json
{
  "claim_type": "need|offer|commitment|risk|decision|status|event",
  "subject_entity_id": "person/project/org",
  "predicate": "needs an ERP implementation partner",
  "object_entity_id": null,
  "polarity": "positive|negative|uncertain",
  "state": "proposed|active|fulfilled|resolved|cancelled|unknown",
  "valid_from": "timestamp",
  "valid_until": null,
  "confidence": 0.91,
  "evidence_event_id": 123,
  "evidence_quote": "short exact span"
}
```

The extractor should be schema-constrained and entity-aware. Deterministic code should handle source IDs, participants, dates, obvious reply closure, and deduplication; a fast structured model should extract claims; a stronger model should verify only ambiguous or high-value candidates.

### One intelligence-item ledger

Generalize `intelligence.opportunities` into a canonical item ledger, either by adding `item_type` or creating `intelligence.items` with compatibility views.

Suggested types:

- `opportunity`: actionable upside;
- `issue`: an active problem requiring attention;
- `insight`: useful synthesis with no immediate action;
- `action`: a commitment or reply owed;
- `risk`: a possible future downside;
- `decision`: a choice awaiting resolution.

Every item should have:

- stable semantic fingerprint;
- canonical people/projects/organizations;
- at least one raw communication evidence row;
- `why_now`, next action, owner, due/expiry time where applicable;
- lifecycle state and closure evidence;
- detector/extractor/model/prompt version;
- first seen, last corroborated, last contradicted, and last presented timestamps.

Legacy relationship and project insight endpoints can be compatibility views during migration.

## Implementation plan

### P0 — Restore truth and freshness (1–3 days)

1. Fix Apple string extraction and add fixture tests using the actual `node-mac-contacts` shape.
2. Change `sender.parsed_email` to the parsed property contract, log extractor errors, and test a real sender through contact, identity, sender registry, and communication creation.
3. Call every agent’s `ensureSchema()` before work; add a migration/startup check for `communication_events`.
4. Give intelligence a durable scheduled runner and run it after successful relationship/project ingestion using a database advisory lock.
5. Change the Intelligence “Refresh” button to POST the pipeline and show durable run status, not process-memory history.
6. Make “Confirm duplicate” invoke the transactional merge for contacts; keep organization decisions separate until organization merging exists.
7. Stop all name-only automatic merges. Route them to review.
8. Fix telemetry completion in relationships so successful runs do not remain visually “running.”
9. Add freshness alarms: raw-source latest time versus canonical-event latest time versus intelligence latest time.

Do not mass-merge by normalized name during recovery.

### P1 — Repair identities and canonical communications (week 1)

1. Re-read Apple Contacts after the adapter fix and populate emails/phones without creating new rows for already-known Apple IDs.
2. Normalize all channel identities consistently; backfill them in source/time batches rather than an ID-limited one-shot scan.
3. Produce an exact-identity conflict report, then auto-merge only uncontested stable-identity groups.
4. Rebuild confirmed duplicate decisions: physically merge valid contact groups, undo/flag contradictory groups, and create redirects.
5. Backfill email senders and email communications idempotently.
6. Backfill WhatsApp direct and group events using the real WhatsApp message ID, not chat plus timestamp.
7. Attach analyzed media text/PDF summaries to their source events.
8. Backfill Limitless and project links through link tables rather than copied communication rows.

Run this in shadow/audit mode first and record before/after counts.

### P2 — Replace signals with claims (weeks 2–3)

1. Introduce claim and claim-evidence tables with versioned extraction.
2. Extract participants/entities before detecting an opportunity.
3. Add polarity, temporality, ownership, and closure/counter-evidence.
4. Cluster on `(claim type, subject, normalized predicate/object, time window)`, never merely on person or source.
5. Require cross-source corroboration only after source-independent clustering.
6. Migrate current detectors one at a time behind feature flags; compare old and new results without showing new candidates immediately.
7. Remove hard-coded person-specific exceptions after equivalent feedback/suppression records exist.

### P3 — Unify issues, insights, actions, and opportunities (weeks 3–4)

1. Add the canonical item ledger and compatibility views.
2. Migrate relationship and project insight state without changing user-visible IDs until redirects exist.
3. Give items stable fingerprints based on canonical entities, claim, context, and time—not generated title text.
4. Reconcile new evidence into an existing item: corroborate, contradict, resolve, reopen, or expire.
5. Require evidence and a reason for promotion to the daily attention queue.
6. Separate high-recall “review candidates” from the precision-first daily queue.

### P4 — Rebuild project intelligence (weeks 4–5)

1. Define projects as outcome-bearing matters with owner, status, lifecycle, and aliases; keep general themes as topics.
2. Persist positive and negative classification decisions with model/version so batches converge.
3. Classify message/thread episodes, not an entire WhatsApp chat forever.
4. Support justified multi-project links and retire stale links when evidence changes.
5. Populate project communication participants from canonical contact links.
6. Analyze retrieved evidence by project/time/topic and include resolved/contradictory evidence.
7. Upsert stable project insights rather than delete/recreate; clear stale open insights even when the new result is empty.
8. Do not require a fixed number of insights.

### P5 — Personal relevance and continuous evaluation (ongoing)

1. Present low-friction feedback choices: useful, wrong person, wrong project, already closed, not an opportunity, too low-value, and duplicate.
2. Save feedback against detector, evidence, entities, and fingerprint—not just generated text.
3. Use feedback first as deterministic constraints and evaluation labels; consider learned ranking only after enough examples exist.
4. Keep two model tiers:
   - fast structured extraction/classification for high-volume communication;
   - stronger reasoning/verification for cross-channel synthesis and high-value ambiguous items.
5. Compare model or prompt changes on a fixed evaluation set before deployment.

The current `bulk_structured` and `reasoning_synthesis` routing split is conceptually sound. Inputs, schemas, lifecycle, and evaluation need repair before model routing is revisited.

## File-level change map

| File/service | Recommended change |
|---|---|
| `packages/agents/apple-contacts/services/nativeReader.js` | Accept string values from the installed library; preserve E.164/raw values; add real-shape tests. |
| `packages/agents/apple-contacts/services/syncer.js` | Match through identity service; remove name-only auto-match; record identities and conflicts. |
| `packages/agents/relationships/services/extractor.js` | Return one documented sender contract; stop swallowing query errors. |
| `packages/agents/relationships/index.js` | Fix email property mismatch; use canonical event IDs; remove name-only merge; include all channels via canonical events. |
| `packages/agents/relationships/services/identity.js` | Replace identity reassignment with conflict/merge behavior; write redirects; canonicalize all downstream references. |
| `packages/agents/relationships/services/exact-identity-backfill.js` | Make resumable and source-watermarked; separate audit, conflict, and safe-merge counts. |
| `packages/ui/server.js` and dashboard duplicate controls | Make contact confirmation an actual merge with preview/rollback metadata. |
| `packages/agents/intelligence/index.js` | Ensure schema, add durable runs/checkpoints, schedule execution, and stop partial pipeline commits. |
| `packages/agents/intelligence/services/signal-extractor.js` | Replace regex records with versioned structured claim extraction. |
| `packages/agents/intelligence/services/signal-clusterer.js` | Cluster by semantic claim independent of source; preserve topic separation for linked entities. |
| `packages/agents/projects/services/discoverer.js` | Use recent evidence-rich episodes and persist project aliases/merge decisions. |
| `packages/agents/projects/services/classifier.js` | Persist negative classifications; classify episodes; link contacts; reconcile stale links. |
| `packages/agents/projects/services/analyzer.js` | Stable insight upsert, explicit evidence, zero-insight reconciliation, no forced item count. |
| `packages/ui/app/intelligence/page.jsx` | POST real refresh; expose freshness, evidence, and specific feedback actions. |
| Graphify generation/config | Rebuild the graph over all workspace packages; fail CI if core paths are absent or the graph has zero edges. |

## Evaluation and acceptance gates

Create a private, de-identified gold set sampled from actual usage:

- 150 identity pairs covering exact matches, same-name different people, spouses, assistants, shared phones, and annotated contact names;
- 250 communication episodes across email, WhatsApp direct, WhatsApp groups, Limitless, PDFs, and images;
- 150 project-link decisions including deliberate null matches and justified multi-project matches;
- 150 claims/items labeled for actor, object, time, polarity, state, type, relevance, and closure.

Initial release gates:

| Metric | Gate |
|---|---:|
| Uncontested exact-identity auto-merge precision | 100% on gold set |
| Contacts with a usable stable identity among communication participants | >95% |
| Canonical event duplicate rate | <0.1% |
| Intelligence items with raw evidence | 100% |
| Intelligence items linked to a person, project, or organization | >90% |
| Top-10 daily attention precision (“worth reviewing now”) | >80% |
| Wrong-person/wrong-project rate in surfaced items | <2% |
| Closed item resurfacing without new contradictory evidence | <1% |
| Raw-source to canonical-event freshness | <10 minutes |
| Canonical-event to intelligence freshness | <30 minutes |

Track precision by detector and channel. A single aggregate “opportunities generated” count rewards noise and should not be a success metric.

## Recovery sequence for the current database

1. Take a database snapshot.
2. Deploy adapter and schema-readiness fixes with all intelligence writes disabled except shadow tables.
3. Re-sync Apple stable identities into existing Apple-ID rows.
4. Backfill email sender identities and canonical events.
5. Generate an identity conflict report.
6. Merge only uncontested exact-identity groups; verify foreign-key counts and redirects after every batch.
7. Rebuild canonical communication participants and project links.
8. Re-extract claims from a recent window, compare with the gold set, then expand the backfill.
9. Reconcile or expire stale relationship/project/opportunity rows rather than blindly recreating them.
10. Enable the new precision queue and keep the old views read-only during a validation period.

## Product decisions I need from you

These do not block P0/P1, but they should be answered before the canonical item ledger is finalized.

1. **What counts as an opportunity?** My recommendation: reserve “opportunity” for specific actionable upside; show relationship maintenance, replies owed, issues, and risks as separate item types.
2. **What counts as a project?** My recommendation: a project has an intended outcome, owner/stakeholders, and lifecycle. Ongoing interests and broad areas should be topics, not projects.
3. **Precision or recall?** My recommendation: precision-first for the daily queue, with a separate high-recall candidate-review page.
4. **How aggressive may auto-merge be?** My recommendation: auto-merge only uncontested stable identifiers; require review for every name/fuzzy match.
5. **Should personal/family and business intelligence share one ranking?** My recommendation: share the communication and identity substrate, but keep separate relevance policies and surfaces.
6. **How should groups be treated?** My recommendation: a group is context, not a person; identify message authors individually and attach claims to the actual author when possible.
7. **Should resolved history remain searchable?** My recommendation: yes, as archived evidence; never keep it in the active queue without later contradictory evidence.
8. **What is the daily attention budget?** My recommendation: design for 5–10 high-confidence items per day, not thousands of open candidates.

## What not to do

- Do not run a name-based mass merge.
- Do not solve the stale-intelligence problem by merely running the current pipeline more often; schema readiness and clustering must be fixed first.
- Do not add more keyword exclusions to the attention SQL as the primary quality strategy.
- Do not treat a newer or larger model as a substitute for canonical identities, complete evidence, and lifecycle state.
- Do not delete historical source evidence while reconciling derived rows.

## Recommended first implementation slice

The highest-leverage, lowest-risk slice is a small recovery release containing:

1. Apple Contacts string-shape fix and tests.
2. Email sender property fix and end-to-end test.
3. Intelligence schema readiness plus a real scheduled/POST-triggered refresh.
4. Contact duplicate confirmation wired to transactional merge with exact preview.
5. Freshness and identity-conflict health checks on the dashboard.

That release should materially improve deduplication and restore current intelligence before the larger claim/item redesign begins.

## Implementation and recovery result — 2026-07-20

The architecture above has now been implemented as a recovery release rather
than left as a proposal. Before live correction, the database was exported to
`/private/tmp/secondbrain-pre-improvement-20260720.dump` and the archive was
validated with `pg_restore --list`.

### Data recovery completed

- A resumable 365-day WhatsApp history pass inspected all 1,407 chats. It
  saved 90 messages, recognized 62,170 existing messages, and reported zero
  failed chats. Direct and group messages use the same durable ingestion path.
- Canonical recovery run 12 processed 46,216 email records, 103,586 WhatsApp
  records, and 1,209 Limitless records. Participant validation covered 114,022
  linked events with zero identity mismatches.
- Provider-scoped LID correction is now a versioned, idempotent service. It
  created/reconciled 5,715 provider profiles and reassigned 17,820 communication
  links without modifying raw WhatsApp rows. A second run made zero changes.
- Exact-identity reconciliation found no remaining uncontested duplicate groups
  or identity collisions. Names are no longer accepted as merge authority.
- The canonical active set contains 152,759 events: 46,216 email, 103,242
  WhatsApp, and 1,209 Limitless events. It has zero duplicate canonical keys and
  zero active events whose raw evidence is missing. Historical rows lacking
  source lineage are explicitly quarantined and excluded from intelligence.
- All 2,821 open legacy relationship insights were deterministically reconciled:
  25 were promoted through the canonical evidence contract and 2,796 were
  retired. Active intelligence has no evidence-free, dangling-evidence, or
  unlinked-entity items.

### Runtime and architecture completed

- `system.schema_migrations` now provides an ordered, checksummed, locked,
  retryable migration ledger. Required schema and migrations fail closed before
  the server listens.
- Canonical communications, evidence-bound claims/items, clarification overlays,
  feedback, lifecycle reconciliation, durable pipeline runs, restart/backoff,
  media extraction, and health/quality audits have one documented owner each.
- Obsolete one-shot backfills, duplicate AI clients, external-action Limitless
  tools, and root prototype tests were removed after replacement-path checks.
- Graphify now indexes 3,267 nodes, 4,462 edges, and 217 communities, replacing
  the historical zero-edge graph noted in the baseline analysis.

### Model routing and current operational limit

Bulk classification and media semantics are pinned to OpenAI
`gpt-5.6-luna`; project/relationship synthesis and signal verification are
pinned to OpenAI `gpt-5.6-terra`. These automated profiles fail closed and do
not fall through to Ollama or a different hosted model. Both Ollama providers
are disabled in the live registry, and the loaded 11 GB local model runner has
been stopped.

The OpenAI account currently returns a quota error for both profiles. Therefore
the final semantic regeneration is intentionally paused—not silently completed
with a different model. Media remains durably queued without being claimed or
consuming retries. After API credit is added and the credit flags are reset,
the remaining media, relationship, project, and intelligence checkpoints can
resume on the declared models.

### Remaining acceptance work

The deterministic integrity gates pass, but semantic release quality cannot be
claimed without the private, de-identified gold set described above. The next
measured cycle must replay that set after OpenAI credit is restored and record
per-channel identity, project, claim, closure, daily-queue precision, latency,
and cost. This is an evaluation requirement, not a reason to weaken the runtime
or substitute a different model.
