# Safe migrations, backfills and deletion

## Ownership

Each schema object has one DDL owner under the owning package's SQL/migrations directory. Runtime services call a schema migrator; they must not embed duplicate `CREATE TABLE` definitions. Bootstrap schema files may represent a fresh install, but ordered migrations are authoritative for upgrades.

Name migrations with an ordered timestamp/version and purpose. Record applied migrations durably. Schema creation must complete before a pipeline starts writes.

The shared runner in `packages/agents/shared/migrations.js` is the upgrade
authority. It discovers ordered SQL under
`packages/agents/shared/sql/migrations/`, serializes execution with a Postgres
advisory lock, and records version, checksum, attempts, completion, and errors
in `system.schema_migrations`. A completed migration whose SQL checksum later
changes is a startup error: add a new migration instead of editing history.

The first ledger entry, `202607200001_ordered_migration_baseline`, records the
cutover from ad-hoc schema startup. Package bootstrap schemas remain useful for
new databases, but production startup must finish the ordered ledger before it
opens listeners or launches pipelines.

## Expand, backfill, validate, cut over, contract

1. **Snapshot:** take a recoverable database snapshot and record baseline counts, constraints, watermarks and quality metrics.
2. **Expand:** add new nullable/additive structures and compatibility readers. Do not change old readers yet.
3. **Dual read/shadow write:** produce new derived data without making it user-visible. Avoid dual-writing raw sources.
4. **Backfill:** process deterministic source/time ranges through the same idempotent domain write contract as live ingestion.
5. **Validate:** reconcile counts, orphan links, duplicate keys, redirects, evidence coverage, checksums/watermarks and [quality gates](QUALITY_GATES.md).
6. **Cut over:** switch one reader/writer boundary at a time behind a reversible flag or view.
7. **Observe:** run through at least one normal schedule/backfill cycle and compare old/new outputs.
8. **Contract:** stop legacy writes, archive/export if needed, remove code and only then drop obsolete derived structures.

Never use a destructive reset or delete/recreate operation as a migration shortcut.

## Backfill requirements

Every backfill must provide:

- dry-run default and explicit write mode;
- bounded source/time batches, deterministic order and durable watermark;
- advisory lock or equivalent overlap protection;
- idempotent unique key and upsert/reconciliation behavior;
- before/after/scanned/skipped/conflict/error counts;
- retry of failed records without replaying successful work;
- producer/schema version metadata;
- graceful interruption and resume;
- verification query or report;
- rollback or derived-data rebuild strategy.

An ID-limited one-shot query is not a complete backfill. Persist negative/null classifications so the newest unclassified rows cannot starve older data.

## Identity migration

For each candidate group:

1. normalize stable identities while preserving raw value and source;
2. detect contradictory stable identities and shared-identity cases;
3. write conflicts for review rather than reassign ownership;
4. select a canonical contact deterministically;
5. update every foreign/link reference in one transaction;
6. write `from_contact_id -> to_contact_id` redirect and merge audit;
7. verify no duplicate event/link rows were introduced;
8. keep old IDs resolvable.

Never mass-merge by display or normalized name.

## Communication migration

Canonical keys must include source and account/client as well as external ID. Backfill source rows to one event, then participants, content variants, project/topic/group links and extraction state. Verify that the count of source records in scope equals canonical events plus explicitly quarantined failures—not participant or project link counts.

Media analysis attaches to its event after the base event exists. A failed analyzer never blocks preservation of the source communication.

## Claim/item migration

Keep legacy insights readable while claims and canonical items are produced in shadow mode. Build explicit old-ID mappings. Reconcile duplicates by semantic fingerprint and evidence, preserving lifecycle and user feedback. Do not copy dismissed/resolved state without its reason and provenance.

After cutover, compatibility views project canonical items into legacy response shapes. Stop legacy writes before removing their producers.

## Correcting existing data

Correct derived data by appending conflicts, redirects, superseding claims, lifecycle transitions or reprocessing markers. Keep an audit of the producer/version and reason. Raw source repair is limited to faithful re-fetch or append of provider records; analysis must not rewrite their content.

## Removing cruft

Before deleting a file, route, table, script or dependency:

1. prove no production/runtime/import/test/documentation owner still requires it;
2. identify replacement and migration state;
3. stop writers and observe;
4. preserve needed history or compatibility;
5. remove references, tests and dependencies together;
6. run lint, tests, build, smoke and quality audit;
7. update [CRUFT_AUDIT.md](CRUFT_AUDIT.md) with the result.

Deleted code is recovered from Git; deleted production data requires a verified snapshot. Treat those risks differently.
