# Model routing and budget

Status: normative workload policy, benchmark/cost snapshot dated 2026-07-20.

## Current policy

| Workload | Primary model | Effort | Why |
|---|---|---:|---|
| Bulk extraction, classification, and media semantics | OpenAI `gpt-5.6-luna` | low | High throughput and low unit cost for schema-bound work |
| Project and relationship synthesis | OpenAI `gpt-5.6-terra` | high | Better multi-evidence reasoning without Sol's cost/latency |
| Signal/claim verification | OpenAI `gpt-5.6-terra` | high | Stronger actor, polarity, lifecycle, and evidence validation |
| Autonomous tool loops | OpenAI `gpt-5.6-sol` | medium | Frontier capability for rare tool-using work, not bulk ingestion |
| Manual frontier review | Claude Fable 5, then OpenAI `gpt-5.6-sol` | maximum | Explicit, rare escalation only |

Ollama is supported only as an explicit operator choice. It is disabled in the
live provider registry and absent from automatic profiles because a quota
failure must not load a multi-gigabyte local model and degrade the ingestion
host. Embeddings currently use remote Jina and do not require Ollama.

Bulk and synthesis profiles use the exact OpenAI routes above by default and
fail closed when no per-agent provider priority has been saved. A saved
per-agent priority is an explicit operator override: the runtime walks every
enabled, funded provider in that order, skips quota failures and temporary
provider failures, and uses the first provider that succeeds. This allows a
durable job to continue through an OpenAI quota outage without silently
changing the defaults for other agents.

Profile effort options are sent only when the selected provider and model match
the versioned route, because provider-specific reasoning parameters are not
portable. Schema, evidence, lifecycle, and structural quality checks remain in
force for every fallback model. The selected provider/model and profile are
recorded in usage telemetry so an operator override remains observable and can
be evaluated before any fallback becomes a new default.

Every model output remains a derived assertion. Models never establish source
identity, mutate raw evidence, bypass schema validation, or surface an item
without inspectable canonical evidence.

## Measured budget basis

The live usage ledger recorded 7.035 million input tokens and 1.417 million
output tokens during the inspected 30-day window. Replaying that entire volume
through one model at public list prices gives this comparison; actual Responses
API reasoning tokens, cached-input discounts, retries, and provider minimums
can change billed totals.

| Model | Estimated 30-day replay | SecondBrain quality | Appropriate role |
|---|---:|---:|---|
| OpenAI GPT-5.6 Sol | $77.70 | 5.0/5 | Rare frontier review/tool use |
| Kimi K3 | $42.37 | 4.7/5 | Strong alternative synthesis; slower first response and verbose |
| OpenAI GPT-5.6 Terra | $38.85 | 4.6/5 | Recommended synthesis/verifier |
| OpenAI GPT-5.6 Luna | $15.54 | 4.2/5 | Recommended bulk structured work |
| DeepSeek V4 Pro | $4.29 | 4.0/5 | Very low-cost text batch alternative; lower reasoning reliability |
| Kimi K2.6 | $12.35 | 4.0/5 | Cost-conscious multimodal alternative |
| Mistral Large 3 | $5.64 | 2.5/5 | Not recommended for core synthesis |

The star ratings are a task-specific engineering estimate from public
benchmark intelligence, modality, structured-output fit, and expected
evidence-reasoning reliability. They are not a substitute for the private gold
evaluation required by [QUALITY_GATES.md](QUALITY_GATES.md).

On the currently profiled subset of actual usage, Luna for bulk work plus Terra
for synthesis costs about **$6.41 per 30 days**, versus about **$8.91** for Luna
plus Sol. Legacy unprofiled calls and the initial media/claim catch-up make a
**$10–$20 initial run** plausible. Start with **$50 of API credit and a $25
monthly usage cap**; raise it only after the first full measured cycle.

## Change rule

A model or effort change requires:

1. a versioned profile/prompt change;
2. structural-output tests;
3. replay against the private gold set, including per-kind/channel results;
4. shadow comparison of evidence fidelity, false links, closure, latency, and cost;
5. rollback to the prior profile.

Do not replace a model solely because a general leaderboard score changed.
Provider availability, prices, and benchmarks are time-sensitive and must be
rechecked before a future routing decision.

Reference snapshot: [OpenAI latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[OpenAI models](https://developers.openai.com/api/docs/models), and
[Artificial Analysis model comparisons](https://artificialanalysis.ai/models).
