# Claims and intelligence-item semantics

## Relationship understanding

The relationship layer answers: who is this entity to the account owner, through which channels and contexts, how has the relationship changed, and what responsibilities or sensitivities exist? It is computed from canonical communications, durable facts, guidance and time—not from contact-book labels alone.

Relationship state must keep evidence and temporal bounds for nature, role, strength, tier, cadence, topics, unresolved commitments and advice. A current profile summary is a read model, not durable evidence.

## Claim contract

A claim is the smallest useful semantic assertion extracted from evidence. Required concepts:

```json
{
  "claim_type": "need|offer|commitment|risk|decision|status|event|preference|relationship",
  "subject": { "type": "contact|organization|project|group", "id": "canonical-id" },
  "predicate": "send the revised contract",
  "object": null,
  "polarity": "positive|negative|uncertain",
  "state": "proposed|active|fulfilled|resolved|cancelled|unknown",
  "valid_from": "timestamp",
  "valid_until": null,
  "confidence": 0.91,
  "evidence_event_id": "canonical-event-id",
  "evidence_span": "short supporting span",
  "extractor_version": "name/version"
}
```

Claims also need a stable semantic fingerprint, first/last seen, contradiction/supersession links, and any applied-guidance IDs. They must distinguish the speaker from the subject, quoted/forwarded speech, negation, hypothesis, history, and current intent.

Do not promote a keyword hit directly to the attention queue.

## Intelligence item types

| Type | Meaning | Example |
|---|---|---|
| Opportunity | Specific, actionable upside | A contact needs a capability another trusted contact can provide |
| Issue | Active problem requiring ownership or resolution | A delivery dependency is blocked and no owner has closed it |
| Insight | Useful synthesis without immediate required action | A relationship has shifted from vendor to strategic partner |
| Action | A concrete commitment or reply owed | Send the revised proposal promised in a meeting |
| Risk | Plausible future downside requiring monitoring/mitigation | Repeated delivery slippage threatens a renewal |
| Decision | A consequential choice awaiting resolution | Choose whether to enter a market after conflicting evidence |

Project status, relationship state, facts, topics, and mentioned events are not automatically intelligence items. Promote them only when they meet a relevance and action/decision threshold.

These are the default product semantics unless superseded by explicit, scoped user guidance:

- “opportunity” is reserved for specific actionable upside;
- a “project” is an outcome-bearing matter, while ongoing themes/interests are topics;
- the daily queue is precision-first and targets 5–10 items;
- personal/family and business domains share the substrate but have distinct ranking surfaces;
- a group supplies context while the actual message author owns a claim;
- resolved history remains searchable but is not active without meaningful reopening evidence.

New project admission requires a concrete completion test plus a verbatim,
canonical evidence excerpt containing an outcome marker. Catalog audits archive
responsibilities, topics, and portfolios with `archived_at`, `archive_reason`,
and `archive_version`; they preserve historical links rather than deleting or
silently recasting them as projects.
Novel candidates remain staged until they recur across at least two discovery
runs with two distinct canonical evidence references.

## Canonical item contract

The current implementation writes the generalized fields on `intelligence.opportunities` and exposes `intelligence.items` as its read-compatible view. Each item needs:

- item type, title, concise synthesis and `why_now`;
- stable semantic fingerprint;
- canonical people, organizations, projects and groups with typed roles/confidence;
- one or more raw/canonical evidence links and supporting spans;
- supporting, contradictory and closure claims;
- recommended action, owner and due/expiry time when applicable;
- confidence and decomposed impact, urgency, relationship/strategic value and effort;
- lifecycle state and transition history;
- producer/detector/model/prompt versions;
- first seen, last corroborated, last contradicted, last presented and updated times;
- applied-guidance, feedback and suppression references.

## Lifecycle

Use explicit transitions rather than boolean combinations:

```text
candidate -> open -> snoozed -> open
candidate/open -> resolved | dismissed | expired | superseded
resolved/expired -> reopened (only with meaningful new evidence)
open -> actioned -> resolved (when outcome evidence arrives)
```

Store every transition with actor, reason and evidence. Model inference may mark `inferred_resolved` at a calibrated threshold; user confirmation is distinct. New corroboration updates an existing item. Counter-evidence lowers confidence or resolves it. Materially different subject/predicate/context creates a new item.

## Extraction and verification

Use a staged pipeline:

1. Deterministically gather a complete communication episode, participants, time and prior state.
2. A schema-constrained model extracts zero or more claims and evidence spans.
3. Deterministic validation rejects missing evidence, invalid entities, duplicate fingerprints and impossible times.
4. A stronger verifier handles only high-value or ambiguous claims/items and can return no item.
5. Reconciliation applies guidance, contradiction, closure, expiry and prior lifecycle.
6. Ranking selects a small attention set.

No prompt should require a nonzero or fixed output count. Persist null/negative classifications with version and watermark so batches converge.

## Ranking

Ranking is downstream of truth. A candidate may be true yet not worth attention.

Score independently and explain:

- expected impact/upside or downside;
- urgency and time decay;
- strategic/project/relationship relevance;
- actionability and named owner;
- evidence quality, diversity and freshness;
- calibrated confidence;
- expected effort and interruption cost;
- prior feedback and active user policy;
- novelty versus an existing item.

Hard gates precede scoring: valid evidence, canonical linkage or explicit unresolved state, no applicable suppression, active lifecycle, and acceptable quality flags. The daily queue aims for 5–10 high-confidence items; lower-confidence candidates belong in review/search.

## Transitional compatibility

- Stop adding new semantics directly to `relationships.insights` or `projects.project_insights`.
- During migration, project and relationship endpoints should read compatibility views or mapped canonical items.
- Preserve old IDs through mappings/redirects until all clients and evidence references are migrated.
- Retire keyword `intelligence.signals` only after claim coverage and quality pass the gates in [QUALITY_GATES.md](QUALITY_GATES.md).
