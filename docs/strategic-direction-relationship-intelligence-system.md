# SecondBrain Strategic Direction — Relationship Intelligence System

## Executive Summary

SecondBrain should not pivot into another meeting-notes or summary product. The codebase already contains the right raw ingredients: local ingestion, a unified Postgres store, relationship profiles, project tracking, group intelligence, research enrichment, semantic search, insights, and an existing cross-source opportunity swarm.

The right strategic direction is to turn these pieces into an **attention allocation system**:

```text
raw communications → entities → relationships/interactions → signals → opportunity candidates → ranked actions
```

The main architectural recommendation is **not** to rebuild, not to create many new user-facing agents, and not to move secrets to Hermes. Keep SecondBrain as the local trusted ingestion and processing system. Let Hermes inspect/modify code and reason over the local Postgres output through Tailscale, but keep credentials and source ingestion on the workstation.

The highest-leverage next step is to strengthen the existing relationship/opportunity layer into an explicit, auditable **Opportunity Ledger** and **Attention Queue**, backed by evidence, deduplication, scoring, feedback, and lifecycle state.

---

## 1. Current Architecture Assessment

### 1.1 Repository and runtime shape

Source inspected at:

```text
/opt/data/workspace/secondbrain
```

Key files:

- `README.md`
- `package.json`
- `AGENTS.md`
- `packages/ui/server.js`
- `packages/agents/relationships/*`
- `packages/agents/projects/*`
- `packages/agents/email/*`
- `packages/agents/limitless/*`
- `packages/agents/whatsapp/*`
- `packages/agents/research/*`
- `packages/ui/services/indexer.js`

The repo is an npm workspace monorepo:

```text
packages/
├── db
├── agents/
│   ├── email
│   ├── limitless
│   ├── whatsapp
│   ├── relationships
│   ├── projects
│   ├── research
│   ├── apple-contacts
│   └── ai
├── ui
├── telemetry
├── collector
├── sampler
└── observe
```

Root scripts already expose the intended operating model:

- `npm run ui` — Next.js UI + Express API / agent-control server.
- `npm run email` — Gmail ingestion.
- `npm run limitless` — Limitless ingestion/processing.
- `npm run whatsapp` — WhatsApp connector.
- `npm run relationships` — relationship profiling + insights.
- `npm run projects` — project discovery/tracking.
- `npm run research` — external contact enrichment.
- `npm run observe` — observability dashboard.

### 1.2 Trust boundary

The current design matches the desired security model:

- Workstation holds privileged integration access.
- Ingestion happens locally.
- Postgres is the shared processed-data layer.
- Hermes can inspect/modify code and query Postgres over Tailscale when credentials are configured.
- Hermes does not need Gmail/WhatsApp/Limitless credentials.

No strategic change recommended here. Preserve this boundary.

### 1.3 Current data orientation

SecondBrain is already partly person-centric, not purely document-centric.

Existing source schemas:

- `email.emails` — message-level Gmail store.
- `public.messages` — WhatsApp event/message store.
- `limitless.lifelogs` — transcript/lifelog store.
- `relationships.contacts` — person/contact profile layer.
- `relationships.communications` — per-contact normalized interaction timeline.
- `relationships.groups` — WhatsApp group intelligence.
- `relationships.insights` — relationship/opportunity/action insight store.
- `relationships.contact_topics` — per-contact topics.
- `relationships.contact_research` — enriched external profile data.
- `projects.projects` — discovered initiatives.
- `projects.project_communications` — comms linked to projects.
- `projects.project_insights` — risks/actions/opportunities for projects.
- `search.embeddings` — semantic index across emails, WhatsApp, lifelogs, contacts, insights, projects, and project insights.

This means the system is not starting from scratch. It already contains the first version of the relationship/opportunity architecture.

---

## 2. Existing Strengths

### 2.1 Local-first ingestion is correct

The system already ingests high-sensitivity sources locally:

- Gmail via `packages/agents/email`.
- WhatsApp via `packages/agents/whatsapp`.
- Limitless via `packages/agents/limitless`.
- Apple Contacts via `packages/agents/apple-contacts`.
- AI exports via `packages/agents/ai`.

This is strategically better than making Hermes a credentialed integration layer.

### 2.2 Relationship profile layer exists

`relationships.contacts` already stores:

- name
- emails
- phone numbers
- WhatsApp IDs
- company
- job title
- summary
- relationship type
- relationship strength
- tags
- first/last interaction
- `my_role`
- `research_summary`
- sticky `manual_overrides`

This is a strong foundation for person-centric intelligence.

### 2.3 Normalized interaction timeline exists

`relationships.communications` links source records to contacts across:

- email
- WhatsApp
- Limitless

This already moves the product beyond “documents” into “person interaction history.”

### 2.4 Relationship analysis has perspective anchoring

`packages/agents/relationships/services/analyzer.js` explicitly prompts from the account owner’s perspective:

> Describe who THIS CONTACT IS to the account owner — their role, not the reverse.

It also captures `my_role`, which is important for avoiding relationship inversion.

### 2.5 Group intelligence exists

`relationships.groups` stores:

- group type
- my role
- summary
- key topics
- communication advice
- notable contacts
- opportunities

This is directly relevant to social-capital allocation: where to participate, where to stay silent, where value can be created.

### 2.6 Opportunity detection already exists

`packages/agents/relationships/services/opportunities.js` contains a seven-part opportunity swarm:

1. Meeting action extraction from Limitless.
2. Urgent WhatsApp message detection.
3. Relationship health / cold relationship detection.
4. Email response gap detection.
5. Cross-person intelligence.
6. Project-to-contact matching.
7. Research-driven opportunities.

This is important: the desired future is already partially implemented. The issue is not absence; it is maturity, scoring, evidence, lifecycle, and prioritization.

### 2.7 Research enrichment exists

`packages/agents/research` enriches strong/moderate contacts using providers such as:

- Tavily
- OpenAI
- PeopleDataLabs
- SerpAPI

It writes to `relationships.contact_research` and updates `relationships.contacts.research_summary`.

### 2.8 Manual overrides are sticky

Both relationship and project records support `manual_overrides`. Agents are written to respect user-confirmed fields.

This is essential for trust. Keep it.

### 2.9 Search/semantic substrate exists

`packages/ui/services/indexer.js` indexes:

- emails
- WhatsApp messages
- lifelogs
- contacts
- relationship insights
- projects
- project insights

This can become the retrieval substrate for higher-quality opportunity detection.

---

## 3. Existing Weaknesses

### 3.1 Opportunity model is too thin

Today, opportunities are mostly rows in `relationships.insights` with:

- title
- description
- priority
- contact_id / contact_ids
- source_refs
- source_ref
- actioned/dismissed flags

That is not enough for a true relationship intelligence system.

Missing concepts:

- opportunity type taxonomy
- confidence
- impact
- urgency
- evidence links
- source diversity
- expiry/staleness
- business domain
- recommended next action
- owner / delegation target
- lifecycle state beyond actioned/dismissed
- feedback on whether the insight was useful

### 3.2 Weak signal detection is digest-based, not memory-based

`buildCrossSourceDigest()` builds a 30-day digest and asks an LLM to spot opportunities. This is simple and useful, but it has limits:

- Recent-only window can miss slow-building patterns.
- Evidence is compressed into snippets.
- It does not maintain durable signal objects.
- It does not accumulate “African distribution” + “Kenya distributor” + “East Africa inquiry” as separate weak signals that can later compound.
- Deduping via title/contact hash is brittle.

### 3.3 Insights are not ranked by expected value

The UI has an Eisenhower-style matrix, but scoring is still mostly `priority = high|medium|low` and type heuristics.

For Prateek’s use case, the key question is not “is this high priority?” It is:

```text
What is the expected value of paying attention to this now?
```

That requires scoring across:

- strategic relevance
- financial/reputational upside
- relationship importance
- timeliness
- actionability
- confidence
- cost of action
- risk of being wrong
- silence preference

### 3.4 No explicit opportunity lifecycle

Current actions are mostly:

- mark insight actioned
- dismiss insight
- resolve project insight

A serious opportunity pipeline needs states like:

```text
candidate → validated → accepted → delegated/scheduled → acted → outcome_recorded → archived
```

Without lifecycle, the system cannot learn which signals were actually valuable.

### 3.5 Evidence is not first-class enough

`source_refs` and `source_ref` exist, but the product should make evidence central:

- why this surfaced
- which communications support it
- which people/entities are involved
- what changed since last time
- what action is recommended
- why now

For trust, every high-value alert must be auditable.

### 3.6 Contact identity resolution is still fragile

There is contact merging by WhatsApp JID, email, and normalized name, but no explicit identity-confidence model.

Risks:

- two people with same/similar names merge incorrectly
- one person across phone/email/company remains split
- group participants are not always resolved into contacts
- organizations and aliases are under-modeled

### 3.7 Organization/topic layer is underdeveloped

The current person and project layers are stronger than the organization/topic layers.

But opportunity detection often depends on:

- companies
- funds
- industries
- geographies
- event names
- domains like Hartex, YPO, investing, suppliers, distribution, acquisition targets

These should become explicit entities, not just tags in summaries.

### 3.8 User attention preferences are not encoded deeply enough

The system does not yet appear to have a durable policy layer for Prateek’s current priorities, strategic interests, ignore rules, relationship tiers, and decision thresholds.

Without this, the system risks surfacing “interesting” instead of “worth attention.”

---

## 4. Missing Capabilities

### 4.1 Opportunity Ledger

Create a durable table for opportunity candidates, separate from generic insights.

Purpose: track the life of a possible opportunity from first weak signal through action/outcome.

Recommended schema direction:

```sql
intelligence.opportunities
- id
- opportunity_type
- title
- thesis
- recommended_action
- status
- priority_score
- confidence_score
- impact_score
- urgency_score
- actionability_score
- silence_score
- domain
- expires_at
- created_at
- updated_at
- decided_at
- outcome
- feedback_rating
```

Supporting links:

```sql
intelligence.opportunity_people
intelligence.opportunity_organizations
intelligence.opportunity_topics
intelligence.opportunity_evidence
intelligence.opportunity_projects
```

Do not replace `relationships.insights` immediately. Instead, let `relationships.insights` remain the UI-facing alert layer while the Opportunity Ledger becomes the structured backend.

### 4.2 Interaction / Evidence table

The system currently has source-specific records plus `relationships.communications`. That may be sufficient for per-contact timelines, but opportunity intelligence benefits from source-agnostic evidence records.

Recommended direction:

```sql
intelligence.evidence_items
- id
- source
- source_id
- occurred_at
- actor_contact_id
- counterparty_contact_ids
- organization_ids
- topic_ids
- text_excerpt
- embedding_source_id
- metadata
```

This can be built from existing source tables without moving secrets.

### 4.3 Entity extraction layer

Add or formalize extraction for:

- people
- organizations
- locations
- events
- products
- industries
- explicit needs
- offers/capabilities
- risks
- dates/deadlines
- relationship intent

This should not be a new user-facing agent. It can be an internal workflow that writes structured candidates.

### 4.4 Weak-signal accumulator

A weak signal should be stored even when it is not yet worth alerting.

Example signal object:

```text
type: distribution_need
entity: African / Kenya / East Africa distribution
source: email / group / meeting
strength: weak
confidence: medium
first_seen: date
last_seen: date
support_count: 3
```

Then opportunity detection becomes pattern matching over accumulated signals, not just one LLM pass over recent snippets.

### 4.5 Attention Queue

Create one daily/weekly ranked action surface:

```text
Today’s highest-leverage actions
1. Make intro: X ↔ Y — why now, evidence, suggested opener
2. Reconnect with A — dormant but strategically important
3. Attend / skip event B — expected value and rationale
4. Stay silent in group C — low leverage / reputational risk
```

This should consolidate across relationships, projects, groups, events, and opportunities.

### 4.6 Feedback loop

Every surfaced opportunity should support feedback:

- useful / not useful
- acted / deferred / delegated / dismissed
- why dismissed
- outcome if acted

This feedback should tune scoring and suppress repeated low-value patterns.

---

## 5. Data Model Recommendations

### 5.1 Do not start with a graph database

A graph database is not required now.

Postgres can support the needed relationship graph with:

- normalized entity tables
- link tables
- JSONB for source metadata
- pgvector for semantic retrieval
- materialized views for ranking

Move to a graph DB only if Postgres query complexity or graph traversal performance becomes the bottleneck. It is not the bottleneck yet.

### 5.2 Add an `intelligence` schema

Keep existing schemas intact:

- `email`
- `limitless`
- `public`
- `relationships`
- `projects`
- `search`

Add a higher-order schema:

```text
intelligence.*
```

Its job is not ingestion. Its job is synthesis.

Recommended first tables:

```text
intelligence.entities
intelligence.entity_aliases
intelligence.evidence_items
intelligence.signals
intelligence.opportunities
intelligence.opportunity_links
intelligence.attention_items
intelligence.feedback
```

### 5.3 Keep `relationships.contacts` as the canonical person profile

Do not replace it.

Enhance around it:

- identity confidence
- aliases
- merge/split audit log
- relationship tier / strategic importance
- preferred cadence
- dormant threshold by tier
- intro preferences
- “do not contact unless…” flags

### 5.4 Add organizations as first-class entities

Many valuable opportunities are not person-only. Add:

```text
intelligence.organizations
- name
- aliases
- domain
- sector
- geography
- relationship_to_prateek
- key_contact_ids
- tags
```

This matters for suppliers, customers, funds, portfolio companies, Hartex, YPO, distribution networks, and acquisition/investment opportunities.

### 5.5 Add topic ontology gradually

Start pragmatic. Do not overbuild.

Seed topics from existing tags and recurring project/contact terms:

- investment
- supplier
- distribution
- Africa / Kenya / East Africa
- YPO
- Hartex
- customer lead
- acquisition
- event
- travel
- family office

Let topic normalization improve over time.

---

## 6. Opportunity Detection Architecture

### 6.1 Current state

Current opportunity detection already includes:

- `relationships.insights` as output.
- 7-agent opportunity swarm in `opportunities.js`.
- Cross-source digest over WhatsApp DMs, WhatsApp groups, email, and Limitless.
- Project-contact matching.
- Research-driven opportunity generation.
- Basic deduplication using `source_ref`.

This should be treated as v0, not discarded.

### 6.2 Recommended target pipeline

```text
1. Ingestion remains local
   Gmail / WhatsApp / Limitless / contacts / AI exports

2. Normalize interactions
   Source records → relationships.communications / evidence_items

3. Extract entities and signals
   people, orgs, topics, needs, offers, risks, events, locations, deadlines

4. Accumulate weak signals
   Store low-confidence observations without notifying

5. Generate opportunity candidates
   Pattern rules + semantic retrieval + LLM synthesis

6. Score and rank
   expected attention value = impact × confidence × urgency × relationship leverage × actionability - noise/risk cost

7. Surface only top actions
   Attention Queue, relationship/project/group pages

8. Capture feedback
   acted, dismissed, delegated, useful, outcome

9. Learn thresholds
   Tune what gets surfaced
```

### 6.3 Opportunity types

Recommended taxonomy:

```text
relationship_reconnect
relationship_nurture
introduction
business_development
supplier_or_vendor
distribution
investment
acquisition
strategic_partnership
event_or_travel
social_capital_participation
risk_or_reputation
project_acceleration
expertise_match
```

### 6.4 Scoring model

Do not start with complicated ML. Start with explicit scoring fields.

```text
priority_score = weighted sum of:
- impact_score: 1-5
- urgency_score: 1-5
- confidence_score: 1-5
- relationship_leverage_score: 1-5
- strategic_fit_score: 1-5
- actionability_score: 1-5
- effort_cost_score: 1-5, negative
- downside_or_silence_score: 1-5, negative
```

High-value output should explain the score in plain English.

### 6.5 Evidence requirements

For any high-priority opportunity, require:

- at least one evidence item
- source and date
- involved people/entities
- recommended action
- why now
- confidence caveat

For cross-source opportunities, require at least two independent evidence items unless urgency is obvious.

---

## 7. Relationship Intelligence Architecture

### 7.1 Person-centric graph

The relationship graph should revolve around:

```text
Person
  ↔ Organization
  ↔ Project
  ↔ Topic
  ↔ Event
  ↔ Opportunity
  ↔ Interaction
```

This does not require Neo4j. It requires disciplined tables and link records.

### 7.2 Relationship tiering

Add a more operational tier beyond `relationship_strength`.

Example:

```text
Tier 1 — high strategic/personal importance
Tier 2 — useful active relationship
Tier 3 — weak/long-tail relationship
Noise — ignore
```

Then dormant thresholds become tier-specific:

- Tier 1: 21-45 days
- Tier 2: 60-120 days
- Tier 3: only if opportunity-linked

### 7.3 Interaction cadence

Track cadence by person:

```text
preferred_cadence_days
last_meaningful_interaction_at
next_suggested_touch_at
relationship_health
```

This is more useful than generic “no interaction in 21 days.”

### 7.4 Relationship maps for introductions

Add capability/need fields:

```text
person_capabilities
person_needs
person_interests
intro_sensitivity
```

Then introductions become structured matching, not only LLM intuition.

### 7.5 Group participation intelligence

Current group analysis is promising. Extend it toward attention allocation:

For each group, estimate:

- expected value of participation
- best role: leader / participant / occasional expert / observer / silent
- current hot topics
- unanswered questions where Prateek has edge
- reputational risks of speaking
- “do not engage” signals

Output should be selective. Most groups should produce no alert.

---

## 8. Prioritized Roadmap

### Phase 0 — Ground truth and baseline audit

Goal: understand live quality before changing architecture.

Tasks:

1. Connect to the live Postgres instance from the Hermes VPS using a configured read-only or scoped credential.
2. Measure counts and freshness for source and derived tables.
3. Sample 50 contacts and classify quality issues:
   - wrong identity
   - weak summary
   - bad relationship type
   - missing company/title
   - duplicate contact
   - stale profile
4. Sample 50 insights/opportunities and classify:
   - useful
   - obvious
   - false positive
   - stale
   - missing evidence
   - too low value
5. Produce a baseline quality report.

Why first: without measuring current signal quality, architecture changes will be guesswork.

### Phase 1 — Make opportunities first-class

Goal: separate durable opportunity tracking from generic insights.

Implement:

1. `intelligence` schema.
2. `intelligence.opportunities`.
3. `intelligence.opportunity_evidence`.
4. Backfill: map existing `relationships.insights` opportunity types into opportunity records.
5. UI/API bridge: continue showing top opportunities as relationship insights.

Do not remove current insights.

### Phase 2 — Evidence and scoring

Goal: make every alert auditable and ranked.

Implement:

1. Evidence links from opportunity to source records.
2. Explicit scoring fields.
3. Score explanation text.
4. Expiry/staleness date.
5. “Why surfaced now?” field.
6. Feedback fields.

This is likely the biggest immediate leverage upgrade.

### Phase 3 — Weak signal accumulator

Goal: detect patterns before they become obvious.

Implement:

1. `intelligence.signals` table.
2. Signal extractors for needs/offers/events/risks/locations.
3. Cross-signal matching jobs.
4. Source-diversity scoring.
5. Only alert when threshold crossed.

Example target output:

> Three independent signals mention East Africa distribution in the last 45 days. Possible distribution opportunity involving X, Y, Z. Suggested next action: ask A whether Kenya distribution is still open.

### Phase 4 — Attention Queue

Goal: one daily surface for highest-value actions.

Implement:

1. `intelligence.attention_items` or materialized view.
2. Merge relationship insights, project insights, opportunity records, group participation prompts, events, and risks.
3. Rank by expected attention value.
4. UI: one concise daily/weekly view.
5. Hermes-friendly query endpoint for “what should Prateek pay attention to today?”

### Phase 5 — Relationship graph refinement

Goal: improve entity quality and introduction matching.

Implement:

1. Explicit organization table.
2. Contact aliases and identity confidence.
3. Merge/split workflow.
4. Capabilities/needs/interests extraction.
5. Intro matching with intro-sensitivity guardrails.

### Phase 6 — High-level intelligence functions

Goal: simple user interface, not dozens of agents.

Keep user-facing functions small:

```text
Executive Assistant
Relationship Intelligence
Opportunity Intelligence
Investment Intelligence
Hartex Operations Intelligence
```

Internally these can orchestrate workflows, but the user should not manage a swarm.

---

## 9. What Not To Do

Do not:

- rebuild SecondBrain from scratch
- move Gmail/WhatsApp/Limitless credentials into Hermes
- create dozens of user-facing agents
- add a graph database prematurely
- optimize for more summaries
- flood the dashboard with notifications
- treat every weak signal as an alert
- trust LLM-generated opportunities without evidence links

---

## 10. Immediate Next Steps

Recommended next deliverable before code implementation:

1. Run a live Postgres audit with a read-only credential.
2. Produce a table-by-table quality/freshness report.
3. Sample current opportunity outputs and score them manually.
4. Draft the `intelligence` schema migration.
5. Draft a minimal Attention Queue API/UI spec.

If implementing immediately, start with the least disruptive change:

```text
Add intelligence.opportunities + opportunity_evidence,
then adapt the existing opportunities.js swarm to write structured opportunity records
while preserving current relationships.insights behavior.
```

This uses the existing system rather than replacing it.

---

## Bottom Line

SecondBrain is already closer to the desired system than the framing suggests. The architecture has ingestion, contacts, projects, group intelligence, research enrichment, semantic indexing, and an initial opportunity swarm.

The strategic gap is not more capture. It is **judgment infrastructure**:

- structured opportunity memory
- evidence-backed weak-signal accumulation
- expected-value ranking
- feedback loops
- a simple attention queue

The north star should be:

```text
Surface the few actions, introductions, risks, events, and opportunities
that most improve Prateek’s decisions this week.
```

---

## 11. Additional Code-Inspection Findings From Parallel Review

Parallel inspection of the UI/API, schema, and ingestion agents added several concrete implementation findings. These do not change the strategic direction; they sharpen the roadmap.

### 11.1 UI/API gaps that directly affect attention allocation

Evidence:

- `packages/ui/app/page.jsx`
- `packages/ui/app/relationships/page.jsx`
- `packages/ui/app/projects/page.jsx`
- `packages/ui/server.js`

Findings:

1. **Dashboard priority matrix is heuristic.**  
   It maps `priority` + `insight_type` into an Eisenhower-style matrix. This is useful visually, but it is not yet a real expected-value attention model.

2. **Dashboard stat field mismatch likely exists.**  
   The dashboard expects fields such as `relStats.open_insights` and `projStats.total`, while API stats appear to return `pending_insights` and `total_projects`. This can make stats blank or underreported.

3. **Run Analysis buttons are weak.**  
   `GET /api/relationships/run` and `GET /api/projects/run` appear not to trigger immediate analysis when the agent is running; they mostly report schedule/restart behavior. For an attention system, on-demand refresh should be real and observable.

4. **`my_role` is displayed but not editable.**  
   The relationships agent respects `my_role`, and the UI displays it, but the contact PATCH allowlist does not expose it for manual correction. This is a trust/quality gap because relationship perspective errors are high-impact.

5. **Project stakeholder intelligence is under-surfaced.**  
   `projects.projects.key_contact_ids` exists but is not clearly enriched or exposed in the UI. For opportunity detection, projects need named stakeholders, sponsors, blockers, and helpers.

### 11.2 Data-model gaps identified by schema review

Evidence:

- `packages/agents/relationships/sql/schema.sql`
- `packages/agents/projects/sql/schema.sql`
- `packages/agents/email/sql/schema.sql`
- `packages/agents/limitless/sql/schema.sql`
- `packages/agents/whatsapp/src/db/schema.sql`
- `packages/ui/sql/search_schema.sql`

Findings:

1. **Opportunities are fragmented.**  
   Opportunity-like data currently exists in at least three places:
   - `relationships.insights`
   - `projects.project_insights`
   - `relationships.groups.opportunities JSONB`

   This reinforces the recommendation for a first-class opportunity ledger.

2. **Array foreign keys should become link tables.**  
   Current arrays such as `relationships.insights.contact_ids` and `projects.projects.key_contact_ids` are convenient, but weak for integrity, querying, scoring, and evidence graphs.

3. **Topics are siloed.**  
   `relationships.contact_topics`, `relationships.groups.key_topics`, and topic-like insight rows exist, but there is no global topic/entity layer across contacts, projects, messages, and opportunities.

4. **Summaries are overwritten fields.**  
   Contact, group, and project summaries are not versioned with model, prompt version, evidence refs, and generated timestamp. For high-stakes intelligence, summary provenance matters.

5. **Limitless and WhatsApp DDL use risky search-path patterns.**  
   Some schema files use `ALTER ROLE postgres SET search_path ...` and unqualified table names. Prefer fully qualified schema names to avoid operational surprises.

### 11.3 Agent/data-flow gaps

Evidence:

- `packages/agents/email/*`
- `packages/agents/whatsapp/*`
- `packages/agents/limitless/*`
- `packages/agents/relationships/*`
- `packages/agents/projects/*`
- `packages/agents/research/*`
- `packages/ui/services/indexer.js`

Findings:

1. **Identity resolution is the biggest foundational weakness.**  
   Contacts are currently linked through WhatsApp JIDs, emails, normalized names, and Apple Contacts data, but there is no explicit identity-confidence/merge/split model.

2. **Email reply detection is likely incomplete.**  
   If sent mail is not robustly ingested, “read but not replied” insights are necessarily heuristic.

3. **Limitless and AI conversations are under-integrated into durable relationship timelines.**  
   They feed some opportunity/project logic, but people mentioned in transcripts or AI conversations are not consistently promoted into contact timelines/evidence.

4. **Config is inconsistent.**  
   Some agents still rely on `process.env` while the UI seeds/manages config in DB. This can make UI-configured keys look present but ignored by certain agents.

5. **Hardcoded WhatsApp self-JID exists.**  
   `MY_WA_JID` is hardcoded in `relationships/services/extractor.js`. This should be config-backed.

6. **Search exists but is not yet the core reasoning substrate.**  
   `search.embeddings` indexes raw and derived objects, but opportunity detection still mostly uses recent snippets/digests rather than semantic retrieval over long memory.

### 11.4 Roadmap refinements from inspection

Update the immediate roadmap as follows:

#### Phase 0A — Fix trust/quality papercuts

Before building the larger `intelligence` schema, fix small issues that improve operator trust:

- Align dashboard stat field names.
- Make Run Analysis actually enqueue/trigger a run or clearly label it as “status only.”
- Add `my_role` to contact edit allowlist/UI.
- Surface project `key_contact_ids` or replace with a stakeholder link table.
- Move hardcoded WhatsApp self-JID into config.
- Audit env-vs-DB config usage for email, Limitless, research, and embeddings.

#### Phase 0B — Live data quality audit

After the papercuts, run a live Postgres audit:

- contact duplicates and merge candidates
- stale summaries
- incorrect relationship types/strengths
- current open opportunity precision
- project/contact linkage coverage
- source freshness by table

#### Phase 1 — First-class Opportunity Ledger

Proceed with the prior recommendation:

- `intelligence.opportunities`
- `intelligence.opportunity_evidence`
- participant/link tables
- lifecycle/status fields
- score fields and explanation
- bridge from existing `relationships.insights`

#### Phase 2 — Weak-signal + semantic retrieval upgrade

Do not rely only on a 30-day digest. Add durable signal extraction and retrieve older semantically relevant evidence from `search.embeddings` when scoring opportunities.

---

## 12. Updated Bottom Line

The parallel inspection reinforces the original conclusion:

SecondBrain already has the primitives for relationship intelligence. The next step is not another agent or another dashboard; it is making the existing intelligence **more trustworthy, structured, ranked, and evidence-backed**.

The highest-leverage sequencing is:

```text
quality papercuts → live data audit → opportunity ledger → evidence/scoring → weak-signal memory → attention queue
```
