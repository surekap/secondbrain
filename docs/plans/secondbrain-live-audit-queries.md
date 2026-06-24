# SecondBrain live audit / smoke checks

This plan documents the read-only live audit checks in `scripts/audit-secondbrain-quality.js` and the small set of optional manual smoke checks that require an API server or an explicit mutation flag.

## Runbook

Current operational status/next plan lives here:

```text
docs/plans/2026-06-24-relationship-intelligence-status-and-next-plan.md
```

Use this audit file for query/check definitions. Use the status plan for the live sequence after PRs #10–#19.

```bash
node scripts/audit-secondbrain-quality.js
```

Requirements:

- `DATABASE_URL` must be configured in the environment or repo-root `.env.local`.
- Without `DATABASE_URL`, the script exits non-zero with a clear `DATABASE_URL is required` message.
- Default mode is read-only: only `SELECT`, information-schema inspection, static file checks, and optional HTTP `GET` calls are used.
- Secrets are never printed. Provider/key checks report only configured vs missing.

Useful options:

```bash
node scripts/audit-secondbrain-quality.js --help
node scripts/audit-secondbrain-quality.js --json
node scripts/audit-secondbrain-quality.js --strict
SECOND_BRAIN_API_URL=http://localhost:4001 node scripts/audit-secondbrain-quality.js
node scripts/audit-secondbrain-quality.js --api-url=http://localhost:4001
```

`--strict` exits non-zero when WARN findings are present. FAIL findings exit non-zero regardless.

## Query categories

### Source freshness

Read-only count and max timestamp checks for raw/source tables:

- `email.emails`: `COUNT(*)`, `MAX(date)`
- `public.messages`: `COUNT(*)`, `MAX(ts)`
- `limitless.lifelogs`: `COUNT(*)`, `MAX(start_time)`

Missing tables are reported as skipped/warned; the script does not create or migrate anything.

### Derived freshness

Read-only count and max timestamp checks for derived intelligence tables:

- `relationships.contacts`: `COUNT(*)`, `MAX(last_interaction_at)`
- Open `relationships.insights`: `COUNT(*) WHERE NOT is_actioned AND NOT is_dismissed`
- `projects.projects`: `COUNT(*)`, `MAX(last_activity_at)`
- `intelligence.opportunities`: `COUNT(*)`, `MAX(last_seen_at)`

### Quality indicators

The script reports compact counts and small ID samples for:

- Duplicate `relationships.contacts.normalized_name` values among non-noise contacts.
- Contacts whose `display_name` appears to be only a phone number.
- Strong/moderate non-noise contacts missing either `company` or `job_title`.
- Open relationship insights older than 30, 60, and 90 days.
- `projects.project_communications` rows with `contact_id IS NULL`.

These are indicators, not automatic failures. They are intended to guide cleanup and later compaction.

### Smoke gates

#### Stats field names used by the UI

The UI currently reads these fields:

- `/api/relationships/stats`: `total_contacts`, `pending_insights`, `strong_contacts`, `last_analysis_at`
- `/api/projects/stats`: `total_projects`, `active_projects`, `stalled_projects`

The audit checks DB-equivalent payloads without requiring a server. If `SECOND_BRAIN_API_URL`, `API_URL`, or `--api-url=<url>` is set, it also performs HTTP `GET` checks against:

- `<url>/api/relationships/stats`
- `<url>/api/projects/stats`

No raw IP or default port is assumed.

#### `my_role` PATCH manual mutation smoke

The default audit **does not mutate**. To verify that `my_role` PATCH persists and is recorded in `manual_overrides`, choose a safe test contact first, then opt in explicitly.

1. Select a safe test contact id:

   ```sql
   SELECT id, display_name, my_role, manual_overrides
   FROM relationships.contacts
   WHERE NOT is_noise
   ORDER BY last_interaction_at DESC NULLS LAST
   LIMIT 20;
   ```

2. Start or point to the SecondBrain API server.

3. Run the gated smoke:

   ```bash
   SECOND_BRAIN_API_URL=http://localhost:4001 \
     node scripts/audit-secondbrain-quality.js \
       --patch-my-role \
       --contact-id=<SAFE_TEST_CONTACT_ID> \
       --my-role-value=audit_test_role
   ```

The script sends `PATCH /api/relationships/contacts/:id` with `{ "my_role": "audit_test_role" }` and verifies the response contains both:

- `my_role: "audit_test_role"`
- `manual_overrides.my_role.value: "audit_test_role"`

Because this intentionally changes the selected contact, only run it on a safe test contact or restore the previous value afterward through the UI/API.

#### `WHATSAPP_SELF_JID` loud check

The audit checks whether `WHATSAPP_SELF_JID` is present in environment or `system.config` (`system.WHATSAPP_SELF_JID` / `WHATSAPP_SELF_JID`). If missing, it reports a loud WARN finding explaining that self-message identification may fail.

This check does not write config and does not change runtime behavior.

Manual DB check:

```sql
SELECT key, CASE WHEN NULLIF(value, '') IS NULL THEN 'missing' ELSE 'configured' END AS status
FROM system.config
WHERE key IN ('system.WHATSAPP_SELF_JID', 'WHATSAPP_SELF_JID');
```

#### Research provider preflight

The audit reports active vs skipped providers for:

- Tavily: `TAVILY_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- People Data Labs: `PEOPLEDATALABS_API_KEY`
- SerpAPI: `SERPAPI_API_KEY`

It only checks environment variables and `system.config` keys as used by `getConfig('system.<KEY>')` — stored rows normally use unqualified keys like `TAVILY_API_KEY` inside `system.config` (legacy fully-qualified keys like `system.TAVILY_API_KEY` are also tolerated). It never calls unconfigured or configured external provider APIs.

## Schema drift check

The audit compares live columns from `information_schema.columns` against checked-in expectations for the touched tables:

- `email.emails`
- `public.messages`
- `limitless.lifelogs`
- `relationships.contacts`
- `relationships.insights`
- `relationships.communications`
- `relationships.contact_research`
- `projects.projects`
- `projects.project_communications`
- `projects.project_insights`
- `intelligence.opportunities`
- `intelligence.opportunity_contacts`
- `intelligence.opportunity_projects`
- `intelligence.opportunity_evidence`
- `intelligence.signals`
- `intelligence.opportunity_feedback_events`

It reports missing or extra live columns as drift. It does **not** run migrations, edit schemas, or auto-repair drift.

## Safety notes

- Default mode is read-only and suitable for production audits when `DATABASE_URL` points to the target database.
- Optional API smoke checks use HTTP `GET` only unless `--patch-my-role` is explicitly provided.
- The script redacts sensitive config values by design; there is no output mode that prints secrets.
- Use `--json` if a later process needs machine-readable JSON output.
