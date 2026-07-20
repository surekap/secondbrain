# SecondBrain agent contract

SecondBrain turns private communications into evidence-backed relationship and decision intelligence. Optimize for correct, current, useful signals—not row counts or impressive prose.

Read these before changing the product:

- [Architecture map](docs/architecture/README.md)
- [Non-negotiable invariants](docs/architecture/INVARIANTS.md)
- [Data layers and ownership](docs/architecture/DATA_LAYERS.md)
- [User guidance and self-correction](docs/architecture/GUIDANCE_AND_SELF_CORRECTION.md)
- [Claims and intelligence-item semantics](docs/architecture/INTELLIGENCE_MODEL.md)
- [Quality and evaluation gates](docs/architecture/QUALITY_GATES.md)
- [Model routing and budget](docs/architecture/MODEL_ROUTING.md)
- [Private intelligence evaluation contract](docs/architecture/evaluation.md)
- [Safe migrations and backfills](docs/architecture/MIGRATIONS.md)
- [Agent process supervision](docs/architecture/PROCESS_SUPERVISION.md)
- [Cruft and consolidation audit](docs/architecture/CRUFT_AUDIT.md)

## Non-negotiable rules

- Never rewrite or delete raw source evidence to correct an interpretation. Corrections belong in canonical or derived layers with provenance.
- User facts and clarifications are overlays. Preserve their history, scope, validity, supersession, and source.
- Resolve low-level errors automatically and idempotently. Ask the user only about persistent, high-impact ambiguity that evidence cannot settle; persist the answer as durable guidance.
- Never auto-merge people by name or a weak alias. Auto-merge only uncontested stable identities with no contradictory evidence, and leave a redirect/audit trail.
- A canonical communication has one source/account/external identity. People, projects, topics, media text, and claims link to it; they do not create copies of it.
- Every surfaced item must link to evidence, canonical entities, extraction/version metadata, and a lifecycle state. Reconcile existing items instead of generating parallel ledgers.
- Compatibility tables/views are migration aids, not permission to add another source of truth.
- Prefer deterministic normalization, linking, lifecycle, and deduplication. Use models for semantic extraction and synthesis behind schemas and evaluation gates.
- Keep modules single-purpose, dependencies directed down the data pipeline, and changes minimal. Delete replaced paths only after usage, data, and rollback checks.
- Use the existing npm workspaces and committed `package-lock.json`. Do not introduce pnpm or another lockfile without an explicit repository migration. Add no dependency unless the existing platform cannot do the job. Run relevant lint, unit, integration, migration, and quality tests after changes.
- Managed agents are attached children of exactly one leased API supervisor. Never detach, unref, or adopt stale workers; follow the shutdown and orphan-reaping contract.

If a proposed change violates an invariant, redesign it or update the architecture decision explicitly with migration and evaluation evidence. Do not silently weaken the contract.
