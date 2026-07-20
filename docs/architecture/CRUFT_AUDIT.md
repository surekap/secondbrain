# Cruft and consolidation audit

Date: 2026-07-20

This is an evidence-backed deletion queue, not authorization to delete data or active code blindly. Apply the protocol in [MIGRATIONS.md](MIGRATIONS.md). Line counts are approximate as of the audit date.

## Completed high-confidence removals

### Root `tests/*.js` prototype suite — completed

Removed files: `tests/comprehensive-test.js`, `tests/debug-wine-test.js`, `tests/final-test.js`, `tests/test-agent.js`, `tests/test-improved-agent.js`, `tests/test-real-lifelogs.js`, `tests/test-stock-saving.js`, and `tests/check-created-data.js`.

Evidence:

- Seven scripts import `../agent`, but no root `agent.js` exists.
- They are not invoked by root package scripts.
- They are manual prototypes with live side effects, including Notion/Todoist/database writes and hard-coded historical object IDs.
- Assertions are console statements, not isolated repeatable tests.

Action: completed in the 2026-07-20 cleanup together with the obsolete Limitless action engine. No external Notion or Todoist records were modified.

Verification: repository reference search, configured npm workspace tests/UI build, and the Limitless ingestion-boundary test. Confidence: high.

## High-confidence removal candidates

### Generated/local artifacts

Candidates: `.DS_Store`, `.agent-logs/`, `.agent-pids/`, `.wwebjs_cache/`, `.wwebjs_auth/`, and `node_modules/`.

Evidence: these are OS metadata, runtime state, browser/session caches or dependency caches, not source. Current tracked status shows the inspected `.DS_Store` files are not tracked.

Action: ensure all are ignored; never delete active WhatsApp authentication/session state during ordinary cleanup. Confidence: high for Git exclusion, conditional for filesystem deletion.

## Consolidation before deletion

### Three intelligence ledgers

Files/tables:

- `packages/agents/relationships/services/opportunities.js` (~718 lines) and `relationships.insights`;
- `packages/agents/projects/services/analyzer.js` and `projects.project_insights`;
- `packages/agents/intelligence/index.js`, the generalized `intelligence.opportunities` write table, and its `intelligence.items` read view.

Evidence: relationship/project services insert their own insights; intelligence backfills both into opportunities; each has different dedupe and lifecycle rules. `relationships/index.js` still runs the seven-part legacy opportunity swarm.

Action: finish making the generalized intelligence item ledger the sole write model, migrate legacy reads through views/mappings, then retire `relationships/services/opportunities.js`, the write portions of `relationships/services/insights.js`, project-insight recreation, and legacy backfill bridges. Keep focused query/read services if still required.

Verification: old/new ID mappings, endpoint compatibility, lifecycle/evidence reconciliation, zero legacy writers, quality gates. Confidence: high on consolidation, medium on exact deletion boundary.

### Keyword signals and overlapping detectors

Files: `intelligence/services/signal-extractor.js`, `signal-clusterer.js`, `stale-email-thread-detector.js`, `relationship-open-loop-detector.js`, `cross-channel-project-detector.js`, `home-improvement-detector.js`, `dormancy-monitor.js`, and overlapping logic in `relationships/services/opportunities.js`/`insights.js`.

Evidence:

- `signal-extractor.js` classifies broad regex matches such as “need,” “issue,” and “will.”
- Reply/open-loop/dormancy concepts are independently implemented in several paths.
- `home-improvement-detector.js` encodes one domain-specific scenario and named wording in a core service.
- Paths promote into different ledgers and maintain different stale/closure rules.

Action: replace with shared communication-episode extraction, structured claims, and generic reconcilers for commitments, open loops, risks, closure and domain policy. Express truly personal policy as guidance/configuration, not hard-coded detector code. Delete old detectors only after shadow parity and precision gates.

Verification: per-detector gold-set comparison, no loss of evidence/closure, queue precision, no old writers. Confidence: high on overlap, medium on migration order.

### Duplicated communication stores and ambiguous event naming

Files/tables: `relationships.communications`, `projects.project_communications`, `intelligence.communication_events`, `intelligence/services/communication-event-extractor.js`.

Evidence:

- Relationship and project tables copy source snippets under different uniqueness keys.
- The intelligence “communication events” service actually extracts mentioned conferences, calls, meetings and webinars rather than representing all communications.
- Project communications can point at the same source through multiple project rows.

Action: create/evolve one canonical communication store with participant/project/content link tables. Rename the mentioned-event concept (for example `mentioned_events`/`scheduled-event-extractor`) to remove the collision. Convert project/relationship stores to links or compatibility views.

Verification: source-to-event count reconciliation, participant/project links, endpoint compatibility, media/search coverage. Confidence: high.

### Schema DDL embedded in runtime services

Files: `relationships/services/identity.js`, `limitless/cron/archiveLimitlessData.js`, plus their package schema files.

Evidence: runtime JavaScript contains `CREATE TABLE`/`ALTER TABLE` definitions also represented in SQL schema ownership. This permits fresh-install and upgrade definitions to drift.

Action: move ordered DDL to one migration owner; runtime calls the migrator and fails clearly before work if schema is unavailable. Confidence: high.

### Monolithic orchestration/API modules

Files: `packages/ui/server.js` (~3,378 lines), `packages/agents/intelligence/index.js` (~1,359), `packages/agents/relationships/index.js` (~906).

Evidence: `server.js` mixes schema startup, environment migration, process management, dozens of API domains, SQL, feedback policy and deploy control. Intelligence and relationship entrypoints mix orchestration, persistence and domain rules.

Action: extract cohesive route/application services and repositories without adding a framework. Keep composition and scheduling in entrypoints. Prefer pure domain functions and narrow ports; delete moved code in the same change.

Verification: route contract tests, package unit/integration tests, startup/signal handling and live smoke. Confidence: high on split, low on any wholesale rewrite.

### Limitless external-action tool modules — completed

Removed files: `limitless/tools/todoist-mcp.js`, `notion-mcp.js`, `stock-mcp.js`, their dynamic host `limitless/agent.js`, and unused `agents/shared/ai-client.js`.

Evidence: these large mutable external-action tools were adjacent to communication ingestion but were not part of SecondBrain's core communication-intelligence goal. The current cleanup removes the files, switches Limitless to ingestion-only processing, removes tool-only package dependencies, and adds an ingestion-boundary regression test. Legacy root prototype tests still center on the removed actions and are covered separately above.

Action: completed in the 2026-07-20 cleanup. Do not reintroduce mutable external actions into the ingestion agent. If a future product decision restores them, isolate them behind an explicit action boundary and authorization. No external Notion/Todoist data was deleted.

Verification: run the new Limitless ingestion-boundary test and the full suite before commit. Confidence: high.

### Dependency ownership and package-manager discipline

Candidates: direct `@anthropic-ai/sdk` declarations in packages that only call shared LLM code and dependencies left behind by removed functionality.

Evidence: the repository currently uses npm workspaces and has one authoritative committed `package-lock.json`. Relationships/projects import `../shared/llm` rather than the SDK directly, while shared LLM code relies on dependencies owned by consuming workspaces because `packages/agents/shared` is not its own workspace package.

Action: keep npm workspaces and `package-lock.json` until an explicit, separately reviewed package-manager migration. Give shared model infrastructure explicit dependency ownership (or move it into a real shared package), and run a dependency-usage audit after each feature removal.

Verification: clean `npm ci`, lockfile-only CI, all tests/build/startup, and connector smoke. Confidence: high on package-manager discipline, medium on further dependency removals.

### One-time backfill scripts — completed

Files: `scripts/backfill-intelligence-opportunities.js`, `backfill-intelligence-next-actions.js`, `backfill-communication-events.js` and corresponding backfill service code.

Evidence: these bridge transitional ledgers and historical schemas. They are useful during migration but become misleading permanent entrypoints after cutover.

Action: completed. The three one-shot CLI wrappers were removed after the
canonical recovery cutover; reusable idempotent domain primitives remain owned
by the durable pipeline. The historical plan is explicitly marked
non-operational.

Verification: migration ledger, no documented/runtime invocation, data counts and rebuild path. Confidence: medium.

### Historical planning/model-critique documents

Candidates: superseded sections of `docs/strategic-direction-relationship-intelligence-system.md`, `docs/plans/*`, and `docs/model-critiques/*`.

Evidence: current strategic direction has accumulated multiple implementation-status addenda and references legacy paths as current. Future agents can mistake history for normative architecture.

Action: mark historical documents non-normative or archive them under `docs/history/`; link only this architecture set from `AGENTS.md`. Preserve useful decision history rather than deleting it blindly. Confidence: medium.

## Do not delete as “duplicates”

- Raw provider tables or media files: they are evidence.
- `packages/agents/ai/services/*` merely because `shared/llm.js` exists: the former import conversation exports; the latter routes model inference.
- Contact merge redirects, identity conflicts, guidance history, evidence links, feedback or lifecycle transitions: these are audit history.
- Compatibility views before all readers, source references and IDs have migrated.

## Suggested order

1. Remove/convert broken root prototype tests and ignore local artifacts.
2. Centralize schema ownership and package-manager/dependency ownership.
3. Introduce canonical communications and disambiguate mentioned events.
4. Introduce guidance reader, claims and one item ledger in shadow mode.
5. Cut over legacy ledgers/detectors and archive completed backfills.
6. Split monoliths along the now-stable domain boundaries.
7. Evaluate historical docs; keep the completed external-action removal from regressing.

Deleting old paths before the replacement proves data and quality parity would simplify the repository while making the product worse. Consolidate first, then contract decisively.
