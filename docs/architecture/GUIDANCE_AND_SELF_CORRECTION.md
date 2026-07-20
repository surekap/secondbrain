# User guidance and self-correction

## Principle

The user should not have to curate routine data. SecondBrain must resolve stable identities, repair links, notice contradictions, close stale items, and re-run failed extraction on its own. User attention is reserved for consequential ambiguity, not database hygiene.

User input never changes what the source said. It changes the interpretation overlay used by later analysis.

## Guidance kinds

| Kind | Example | Effect |
|---|---|---|
| Fact clarification | “Alex is the founder of Acme, not an employee.” | Constrains entity/relationship claims in scope |
| Identity decision | “These two records are the same person.” | Authorizes a canonical merge after contradiction checks |
| Preference/policy | “Family reminders should not enter the business queue.” | Changes ranking/surface policy, not evidence |
| Item resolution | “This issue was closed last week.” | Closes the item with user provenance; later contradictory evidence may reopen it |
| Relevance feedback | “Wrong project” or “too low value” | Labels the item/detector and may create an explicit scoped constraint |
| Suppression | “Never show automated reservation emails.” | Blocks a narrowly defined, explicit pattern or source class |

A dismiss click is not automatically durable policy. Ask for or expose an explicit suppression action when the user intends a rule.

## Durable guidance contract

The physical implementation may use a general guidance table or typed tables, but every durable entry must support:

- `guidance_kind`;
- scope type and canonical scope ID;
- structured subject/predicate/value or policy payload;
- provenance (`user`, import, migration) and optional source item/question;
- confidence/authority;
- `valid_from` and optional `valid_until`;
- active, retracted, or superseded state;
- `supersedes_id`/`retracted_by_id`;
- created/updated timestamps and actor;
- optional rationale.

`intelligence.guidance_facts` and `intelligence.clarification_questions` now implement the core durable contract and question lifecycle. Current `manual_overrides`, duplicate decisions, feedback events, suppressions, and contact facts still cover adjacent pieces; adapt them behind the shared guidance reader rather than letting every detector interpret them independently.

## Precedence

When producing current state:

1. Preserve the raw evidence unchanged.
2. Canonicalize stable source identity and event structure.
3. Reconcile active user guidance in the narrowest matching scope.
4. Evaluate current and contradictory evidence after the guidance's validity time.
5. Produce a derived claim/item with both evidence and applied-guidance references.

User guidance is authoritative about user intent and explicit real-world facts, but it is not eternally unquestionable. If strong later evidence conflicts, preserve both and either mark uncertainty or ask one high-level clarification. Never silently overwrite the earlier answer.

## Self-correction loop

```text
new/reprocessed evidence
  -> validate source and canonical links
  -> compare with active facts, claims, guidance and item state
  -> auto-correct low-level errors
  -> reconcile claims/items and confidence
  -> ask only if a persistent high-impact ambiguity remains
  -> persist answer as guidance
  -> rerun affected reconciliation and ranking
```

Low-level automatic repairs include:

- re-normalizing email, phone or provider IDs;
- merging uncontested exact-identity duplicates and writing redirects;
- splitting/flagging an identity conflict rather than moving ownership silently;
- attaching a participant or project once corroborating evidence arrives;
- replacing a failed/obsolete extraction with a versioned derivation;
- correcting polarity, time, actor, or closure from later evidence;
- expiring or closing an item whose condition no longer holds;
- retrying lagging source/event/media/claim stages from durable checkpoints.

## Clarification gate

All of these must be true before asking the user:

1. The ambiguity affects a high-level decision, strategic relationship, material project, or repeated ranking policy.
2. It has survived at least two relevant communications or reconciliation passes, unless delay would create material risk.
3. Available source, identity, project, prior-guidance, and counter-evidence searches did not resolve it.
4. The plausible answers lead to meaningfully different system behavior.
5. The question can be stated concisely with evidence and a recommended interpretation.

Do not ask the user to fix spelling, choose between exact stable duplicates without contradiction, label every communication, confirm obvious closures, or compensate for a failed connector.

## Question lifecycle

A clarification request needs a semantic fingerprint, scope, evidence, first/last observed time, attempts, impact, status, and answer. Deduplicate and throttle by fingerprint. States should include `candidate`, `waiting_for_evidence`, `asked`, `answered`, `resolved_without_user`, `expired`, and `superseded`.

When answered:

1. append the durable guidance;
2. link it to the question and evidence;
3. mark the question answered;
4. invalidate only affected derived records;
5. rerun reconciliation for the affected entities/items;
6. record what changed;
7. suppress equivalent future questions until new contradictory evidence warrants one.

The user's answer should improve the intelligence layer, not merely disappear into chat history or one generated summary.
