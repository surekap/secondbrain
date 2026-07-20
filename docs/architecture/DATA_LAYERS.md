# Data layers and ownership

## Layer model

| Layer | Purpose | Examples today | Mutation rule |
|---|---|---|---|
| L0 Raw evidence | Faithful provider capture | `email.emails`, `public.messages`, `public.media_files`, `limitless.lifelogs`, `ai.*` | Append/idempotent upsert of provider state only; analysis never rewrites it |
| L1 Canonical entities | Stable people, identities, organizations, groups, projects | `relationships.contacts`, `relationships.contact_identities`, `intelligence.organizations`, `relationships.groups`, `projects.projects` | Correctable through explicit merge/split/redirect/conflict operations |
| L2 Canonical communications | One cross-channel event plus participants/content/link records | Transitional `relationships.communications`; source references in other tables | Idempotent on source/account/external ID; no per-entity copies |
| L3 Memory and guidance | Evidence-backed facts and user-authored interpretation overlays | `relationships.contact_facts`, `intelligence.guidance_facts`, `intelligence.clarification_questions`, `manual_overrides`, feedback/suppressions | Append, supersede, expire or retract; never mutate L0 |
| L4 Claims | Atomic semantic assertions extracted from evidence | `intelligence.claims`, `claim_evidence`, `item_claims`; transitional `intelligence.signals` input | Versioned extraction; reconcile polarity, time and state |
| L5 Intelligence items | Opportunities, issues, insights, actions, risks and decisions | `intelligence.opportunities` write-compatible table and `intelligence.items` view; two legacy insight tables remain | Stable fingerprint and lifecycle reconciliation |
| L6 Read models | Attention, relationship/project pages, search, reports | `intelligence.attention_queue`, search embeddings, API responses | Rebuildable projections only |

## L0: raw evidence

A source row stores the provider's identity, payload, occurrence time, account/client, retrieval metadata, and attachments. Connector fixes may re-fetch or append records. They must not normalize a person, resolve a project, or edit text to match a later conclusion.

`public.media_files.extracted_text` and `semantic_text` are derived content stored alongside media today. Treat them as replaceable content variants with analyzer/version metadata; the original file and WhatsApp message remain authoritative evidence.
`content_sha256` may reuse a completed derivation for a byte-identical attachment,
but each message retains its own source link and the hash is never person or
conversation identity evidence.

## L1: canonical entities

Canonical entities give changing source records stable internal IDs. Their fields fall into three categories:

- identity keys: deterministic normalized identifiers and source provenance;
- derived profile state: current summaries, relationship type, tier, project health;
- explicit overlays: user-confirmed values that constrain later derivation.

Do not mix these categories in a single untraceable JSON update. Identity corrections require conflicts and redirects. Derived profile state must be reproducible. Explicit overlays retain who/when/why.

WhatsApp privacy-preserving `@lid` values belong in the identity-key category,
but initially identify only a provider participant. Store an unseen LID on a
provider-scoped provisional profile and keep its display name as metadata. A
display-name match must never attach it to an existing person; independent
person-level evidence is required for a later audited merge.

## L2: canonical communications

The target event contract needs at least:

- stable event ID and unique `(source, account/client, external_id)`;
- conversation/thread/group ID, direction, occurred time, source pointer and content hash;
- typed participants with canonical entity ID, role and resolution confidence;
- typed content variants: original text, normalized text, OCR, PDF text/summary, audio transcript, image description;
- project, topic, group and attachment links;
- extraction/link status and retry metadata.

`relationships.communications` should evolve behind a compatibility view or be replaced using the migration protocol. `projects.project_communications` should eventually contain only project links or become a view. The current `intelligence.communication_events` name is reserved for mentioned calendar/meeting events and must not be confused with canonical communications.

## L3: memory and guidance

Evidence-backed facts state what communications support. User guidance states how the account owner wants ambiguous evidence interpreted or ranked. Both are overlays, but user guidance has precedence within its scope. See [GUIDANCE_AND_SELF_CORRECTION.md](GUIDANCE_AND_SELF_CORRECTION.md).

Manual profile fields may keep a current-value cache for UI speed. The authoritative user action must still be represented as durable, attributable guidance so it can be audited and superseded.

## L4: claims

A claim is an atomic, evidence-linked semantic statement. It is not a bag of keywords and not yet an attention item. Claim extraction can be rerun with a new model/version without altering its source. See [INTELLIGENCE_MODEL.md](INTELLIGENCE_MODEL.md).

## L5: intelligence items

Items reconcile one or more claims with user guidance and current entity/project context. The item ledger owns lifecycle, evidence, feedback and ranking features. Legacy relationship/project insight IDs may be maintained through mappings or views until clients migrate.

## L6: read models

Read models are disposable and rebuildable. They must expose:

- source evidence and why the item exists;
- canonical person/project links and confidence;
- freshness, state and last meaningful change;
- the specific next action or decision, if any;
- uncertainty and a clarification state when appropriate.

Search embeddings are an index, never a source of truth.

## Allowed dependency direction

```text
connectors -> L0
canonicalizers -> L0 + L1 + L2
extractors -> L0/L2 + L3 -> L4
reconcilers -> L1/L3/L4 -> L5
rankers/read models -> L1/L3/L5 -> L6
```

No lower layer depends on a higher-layer table to establish its own identity or truth.
