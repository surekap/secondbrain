# GPT-5.5 Validation — Round 1

**Model:** gpt-5.5 via openai-codex  
**Date:** 2026-06-23  
**Input reviewed:** `.hermes/model-critiques/sonnet-4-6-round-1.md`, current repo files, and `docs/plans/2026-06-23-relationship-intelligence-first-work.md`.

## Verdict

Sonnet 4.6 produced several good, code-grounded corrections. Most should be incorporated. A few need refinement before adoption.

## Accepted Suggestions

### ACCEPT HVS-1, with refinement

The concern is correct: `MY_WA_JID` is currently a synchronous exported constant from `extractor.js` and is imported by `insights.js`. Changing it to an async function or a function reference without updating all call sites would break runtime behavior while passing `node -c`.

**Refinement:** Do not require async DB config lookup in `extractor.js` during Phase 0A unless the relationship agent is refactored to initialize config before using extraction functions. `getConfig()` is async and the current exported constant shape is synchronous. The safest Phase 0A spec is:

- Preserve the `MY_WA_JID` export shape.
- Source it from `process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID`.
- Fail fast at module load if absent.
- Add `.env.example` and docs.
- Add a later config-unification task for `system.WHATSAPP_SELF_JID` if/when relationship agents support async config initialization.

### ACCEPT HVS-2

The original plan’s `const activeProviders = providers` is too blunt. Provider behavior differs:

- Tavily/OpenAI/SerpAPI throw if config missing.
- PeopleDataLabs returns a not-configured object.

Best spec: build active provider list by async `getConfig(system.KEY)` preflight, not `process.env`, then call only configured providers. Log active/skipped providers once per run.

### ACCEPT HVS-3

Task 1 severity should be narrowed. The real bug is `projStats.total` vs `total_projects`. The relationship insights count is less severe because it falls back to `relInsights.length`, but the UI should still use canonical `pending_insights`.

### ACCEPT HVS-4

The first subagent batch must be serial for Tasks 1 and 2 because of potential `server.js` overlap. Better: Task 1 should be UI-only and avoid server aliases.

### ACCEPT HVS-5, with refinement

The consistency issue is real, but Phase 0A should not over-refactor relationship config to async DB reads. Add `WHATSAPP_SELF_JID` to docs/env immediately; add DB config/UI unification as a follow-up design task unless implementation confirms a clean startup-time async path.

### ACCEPT HVS-6

The `Math.min` in `opportunities.js` is a clear bug. It should be added to Phase 0A as a high-leverage one-line fix with verification beyond syntax.

### ACCEPT HVS-7 as a Phase 1 design requirement, not Phase 0A implementation

The dedupe weakness is real, but semantic dedupe is not a papercut. Add it to the Opportunity Ledger/design spike and avoid slipping it into Phase 0A.

### ACCEPT HVS-8

Duplicate DDL is low-risk to clean up and clarifies schema ownership. Add as a small Phase 0A task or bundle with Task 4.

### ACCEPT HVS-9

Task 5 is a UI copy/behavior clarity task, not a frontier design task. Defer IPC trigger design.

### ACCEPT HVS-10

The verification gates are too weak. Add a smoke-test script or manual API/DB smoke-test checklist. Syntax checks alone are insufficient.

## Rejected / Modified Suggestions

### MODIFY: “Create a new feature branch before implementation”

This is sensible for code implementation, but the current user ask is to update the plan/spec on the existing PR. We should record that implementation should branch from the docs PR or main into `feature/phase-0a-papercuts` after the plan is approved, not move the current planning artifacts.

### MODIFY: “`gpt-5.5` / `openai-codex` is not a real model name”

In this Hermes runtime, the active model is reported as `gpt-5.5` and provider as `openai-codex`. We should keep the runtime-reported label and clarify that child model names must be recorded from actual tool/runtime output.

## Plan Updates Required

1. Add a cross-model review log section with Sonnet Round 1 + GPT validation Round 1.
2. Tighten Task 1 to UI-only canonical field reads; no server aliases.
3. Tighten Task 3 to preserve `MY_WA_JID` export shape; fail fast from env; add DB-config unification follow-up.
4. Tighten Task 4 to async `getConfig` preflight, not blind provider execution.
5. Simplify Task 5 to UI copy/status clarity only.
6. Add Task 6A: fix `Math.min` → `Math.max` in cross-person opportunity scan.
7. Add Task 6B or fold into Task 4: remove duplicate research schema DDL.
8. Add stronger smoke-test/behavior verification gates.
9. Change first subagent batch from parallel implementers to serial Tasks 1 → 2, with config audit read-only in parallel only if no file edits.
10. Add Phase 1 dedupe redesign requirement.
