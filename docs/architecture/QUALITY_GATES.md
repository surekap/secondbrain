# Quality and evaluation gates

Quality is measured against actual decisions and evidence, not the number of records generated.

## Evaluation set

Maintain a private, de-identified, versioned gold set sampled across real usage:

- at least 150 identity pairs, including same-name people, couples, assistants, shared identifiers, annotation-heavy names and real duplicates;
- at least 250 communication episodes across email, WhatsApp direct/group, Limitless, PDFs, images and audio;
- at least 150 project links, including deliberate null and justified multi-project cases;
- at least 150 claims/items labeled for actor, object, time, polarity, state, type, relevance, evidence and closure;
- persistent clarification cases and cases the system must resolve without asking.

Keep train/tuning examples separate from the release evaluation set. Never place raw private content in the repository.

## Release gates

| Metric | Initial gate |
|---|---:|
| Uncontested exact-identity auto-merge precision | 100% |
| Communication participants with a usable stable identity | >95% |
| Canonical communication duplicate rate | <0.1% |
| Surfaced items with inspectable raw evidence | 100% |
| Surfaced items linked to a person, project, organization or explicit unresolved entity | >90% |
| Wrong-person or wrong-project rate | <2% |
| Top-10 daily attention precision (“worth reviewing now”) | >80% |
| Closed item resurfacing without meaningful new evidence | <1% |
| Avoidable low-level clarification-question rate | <2% of repaired cases |
| Duplicate clarification questions | <1% |
| Raw-to-canonical freshness | <10 minutes in normal operation |
| Canonical-to-intelligence freshness | <30 minutes in normal operation |

Track these by channel, detector/extractor version, entity link state, and item type. Aggregate scores can hide a broken connector.

## Required automated checks

Every affected change must include proportionate tests for:

- idempotent ingestion and backfill;
- source immutability;
- stable identity normalization, conflict and redirect behavior;
- canonical-event uniqueness and participant resolution;
- guidance scoping, precedence, expiry and supersession;
- claim schema, negation, quoted speech, time, actor and evidence spans;
- item fingerprinting, lifecycle, contradiction, closure and reopening;
- null/no-insight output;
- compatibility reads during migration;
- checkpoint/resume and overlap prevention;
- API evidence/provenance visibility.

Use fixtures shaped like the real provider libraries, not idealized mocks. This repository currently uses npm workspaces and the committed `package-lock.json`; run its npm lint/test commands and the relevant workspace-level suites. Database-changing tests should use an isolated schema or transaction and must not touch live evidence.

## Shadow and canary process

For extractor, model, prompt or ranking changes:

1. version the producer;
2. replay the gold set;
3. run against a recent window in shadow tables or shadow mode;
4. compare precision, recall, link coverage, closure and queue changes;
5. inspect a stratified sample of gains and regressions;
6. canary a bounded slice;
7. promote only after gates pass;
8. retain rollback to the prior version and derived records.

Do not replace a model solely because a benchmark score or vendor ranking improved. Evaluate the exact SecondBrain task and data contract.

## Runtime health

Monitor separate watermarks and failure counts for:

- connector/source capture;
- media acquisition and semantic analysis;
- canonical communication creation;
- participant/entity/project resolution;
- claim extraction;
- item reconciliation;
- attention/read-model refresh.

Alert on lag between adjacent stages, not only whether a process is alive. Store durable run/checkpoint status; process memory and log text are not sufficient.

## Stop-ship conditions

- Any raw evidence mutation by an analysis migration.
- Any name-only automatic person merge.
- Any surfaced item without evidence.
- A schema migration that cannot resume or reconcile counts.
- A model/prompt change with no version or gold-set comparison.
- Partial pipeline success reported as healthy.
- A new parallel truth ledger without an approved migration plan.
