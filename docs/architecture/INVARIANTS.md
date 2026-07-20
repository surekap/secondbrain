# Architecture invariants

These are behavioral contracts. A schema or class rename does not change them.

## Evidence and provenance

1. Raw source records are immutable evidence. A correction may append a newer source record, canonical mapping, interpretation, tombstone, or supersession; it must not edit history into agreement.
2. Every derived fact, claim, link, and intelligence item records the evidence IDs, producer/version, timestamps, and confidence that produced it.
3. A high-confidence item without inspectable source evidence is invalid and must not enter the attention queue.
4. Media analysis is a content variant attached to its source message. Extracted PDF text, summaries, OCR, transcripts, and image descriptions do not replace the original file or provider payload.

## Identity

1. `relationships.contacts` is the canonical person/profile record until an explicit migration replaces it.
2. Matching authority resides in normalized stable identities, not names or generated summaries.
3. Name-only, first-name, last-name, and broadly derived alias matches never auto-merge people.
4. An uncontested person-level provider ID, normalized email, full normalized WhatsApp JID, or E.164 phone may auto-merge only when no contradictory person-level stable identity exists.
5. An Apple contact ID identifies an imported address-book card, not a person. Distinct Apple card IDs neither prove nor contradict person identity; multiple cards may map to one canonical contact and must remain as source-provenance identities.
6. Conflicts are recorded; identity ownership is never silently moved between active people.
7. A merge is transactional, canonicalizes every foreign reference, writes a permanent redirect, and remains auditable. Old IDs resolve forever.
8. Group identities, shared addresses, assistants, couples, and organizations are not assumed to be people.
9. A WhatsApp `@lid` is a stable provider-scoped participant identity, but it is not a phone number and does not by itself prove which address-book person owns it. An unseen LID may create a provisional profile; display names are presentation metadata only. Merge that profile only after independent person-level corroboration.

## Communications

1. One source/account/external ID maps to one canonical communication event.
2. Participants, projects, groups, topics, attachments, media semantics, and claims link to that event through typed links.
3. A communication is not copied once per contact or project.
4. An unresolved participant is explicit state with retry metadata, not a silent success or a forced name match.
5. Backfills and live ingestion use the same idempotent write contract.

## Guidance and correction

1. User facts, clarifications, preferences, suppressions, and manual overrides are interpretation overlays. They never rewrite source evidence.
2. Guidance is scoped, append-only, attributable, time-aware, and supersedable. A current read may collapse its history, but the history remains.
3. Low-level inaccuracies—normalization, duplicate rows, participant links, stale classifications, claim polarity, closure, and source lag—are the system's responsibility to detect and repair.
4. The system asks only about a persistent, high-impact decision ambiguity after available evidence and successive communications fail to resolve it.
5. Once answered, a clarification is stored once as durable guidance and used by extraction, reconciliation, and ranking. Do not repeatedly ask the same question.

## Intelligence

1. A claim describes what evidence says. An intelligence item describes why the account owner may need to know or act.
2. Claims preserve actor, predicate/object, polarity, time, state, confidence, and exact evidence.
3. Items use one canonical lifecycle. Relationship and project views may project that ledger but must not create independent truth.
4. Stable fingerprints use canonical entities, normalized meaning, context, and time window—not generated title text alone.
5. New evidence reconciles an item by corroborating, contradicting, resolving, reopening, expiring, or superseding it. It does not blindly insert a duplicate.
6. An empty model result is valid. Prompts must never demand a fixed number of insights.
7. The daily attention queue is precision-first and bounded. Candidate recall belongs in a separate review surface.
8. Dismissal is not automatically a global rule. Only explicit, appropriately scoped guidance creates durable suppression.
9. Personal/family and business intelligence share canonical evidence, identities, claims, and items, but use distinct ranking policies and attention surfaces.
10. A group is communication context, not the author of a claim. Attribute claims to the actual message author when resolvable; otherwise preserve an explicit unresolved author.
11. Resolved history remains searchable and available as evidence, but stays out of active attention unless meaningful new evidence reopens it.

## Projects and relationships

1. A project is an outcome-bearing matter with lifecycle, owner/stakeholders, and supporting evidence. Themes and interests are topics.
2. Project classification persists positive and negative decisions so processing converges.
3. Communication-to-project links are evidence links, can be revisited, and may be multiple only with explicit confidence/reason.
4. Relationship nature, strength, tier, and advice are time-varying derived state. User-confirmed fields override analysis without erasing the evidence that disagrees.

## Operations

1. Every pipeline is restartable, idempotent, checkpointed, and protected from overlapping runs.
2. Schema readiness precedes writes. A pipeline cannot partially succeed because a later table is missing.
3. Raw freshness, canonical freshness, extraction freshness, and attention freshness are observed separately.
4. Data correction and destructive contraction require a snapshot, dry run, count reconciliation, rollback plan, and quality gates.
5. Models and prompts are versioned. A model change cannot bypass the same evaluation suite.
6. Long-running workers have exactly one leased supervisor, remain attached to it, and are drained on shutdown. A replacement supervisor reaps exact-match orphans; it never adopts processes whose pipes and exit events it does not own.

## Never acceptable

- Mass-merging by normalized name.
- Deleting raw evidence to remove a false positive.
- Adding another insight/opportunity table instead of extending or projecting the canonical item ledger.
- Hiding missing identities, evidence, or links behind fallback text.
- Person-specific keyword exceptions as the primary quality strategy.
- Treating output volume, token use, or model confidence as proof of quality.
