# Model catalog discovery via OpenRouter

## Problem

The model dropdown in the Agents UI (provider + model pickers for both chat agents and the Embeddings panel) is backed by hand-maintained static lists in `packages/agents/shared/model-catalog.js`:

- `PROVIDER_DEFINITIONS` — fixed array of providers (anthropic, claude_cli, openai, gemini, kimi, ollama, jina).
- `STATIC_MODELS` — fixed array of `{label, value, provider_type, capabilities}` entries, one per known model.

This requires a manual code change every time a provider ships a new model. `packages/agents/shared/model-fetcher.js` already does *live* discovery for Anthropic and OpenAI (hitting their native `/v1/models` endpoints, falling back to static on failure), but Gemini, Kimi, Jina, and the provider list itself are still static. There's also a second, unused, duplicate `STATIC_MODELS` array inside `model-fetcher.js` (dead code — every call site there resolves through `getStaticModels()` from `model-catalog.js` instead).

## Goal

Replace the hardcoded chat provider + model lists with a live catalog sourced from OpenRouter's public model directory, while keeping embedding-model discovery on native provider APIs where no public chat-style catalog exists for them.

## Scope

**In scope:**
- Chat provider list and chat model lists sourced live from OpenRouter.
- Gemini embedding model list sourced live from Google's native ListModels API.
- Jina embedding model list stays static (no public discovery API exists).
- Ollama keeps its existing live discovery against the local Ollama server (chat + embeddings) — unchanged.
- `claude_cli` keeps a fixed single provider entry with no model list (the CLI manages its own default model) — unchanged.
- Cleanup: delete the unused duplicate `STATIC_MODELS` in `model-fetcher.js`; delete the hardcoded `PROVIDER_DEFINITIONS`/chat-capability `STATIC_MODELS` entries in `model-catalog.js`.

**Out of scope:**
- Actually calling any newly-discovered provider that the app has no native call integration for (e.g. Mistral, Meta, etc. that appear in OpenRouter's catalog but have no SDK/API code in `packages/agents/ai/`). Selecting such a provider in the dropdown is expected to surface a clear error when used; wiring up real call support for them is separate future work.
- Changing how Anthropic/OpenAI/Gemini chat calls are actually made (still native SDK calls, unaffected by this change — only the *listing* of available models changes).

## Architecture

### New module: `packages/agents/shared/openrouter-catalog.js`

Responsibilities:
1. Fetch `GET https://openrouter.ai/api/v1/models` (public, no API key required).
2. Cache the parsed result in-memory with a 1-hour TTL (module-level variable; cache is per server process, reset on restart — consistent with how the rest of `model-fetcher.js` has no persistent cache today).
3. Derive and expose:
   - `getOpenRouterProviders()` → `[{ value: slug, label: TitleCase(slug), capabilities: ['chat'], requires_api_key: true }, ...]`, one entry per unique vendor slug found in model IDs (the part before the first `/`, e.g. `anthropic/claude-3.5-sonnet` → `anthropic`).
   - `getOpenRouterModels({ providerType })` → `[{ label: model.name, value: model.id, provider_type: slug, capabilities: ['chat'] }, ...]`, filtered to IDs starting with `${providerType}/`.
4. On fetch failure:
   - If a previous successful fetch exists in cache (even if past TTL), serve the stale cache and log a warning.
   - If there has never been a successful fetch, return a small built-in fallback list covering `anthropic`, `openai`, `google` (3-4 well-known model IDs total) so the dropdown is never empty.

### `packages/agents/shared/model-catalog.js`

- Remove `PROVIDER_DEFINITIONS` entries and `STATIC_MODELS` entries that have `capabilities: ['chat']` only (i.e. anthropic, openai, gemini-chat, kimi rows). These become dynamic via OpenRouter.
- Keep fixed entries for `ollama` (chat + embeddings, local) and `claude_cli` (chat, local, no model list) in `PROVIDER_DEFINITIONS`, since OpenRouter has no concept of either.
- Keep the embeddings-only rows (`gemini-embedding-2-preview` row is replaced by live Gemini fetch — see below; Jina embedding rows stay as static entries since no Jina endpoint exists to discover them).
- `getProviderDefinitions(capability)` now returns: fixed local entries (`ollama`, `claude_cli`) + dynamic OpenRouter-derived entries (for `capability === 'chat'` or unset) + Jina (for `capability === 'embeddings'` or unset, since it has no chat capability anyway).

### `packages/agents/shared/model-fetcher.js`

- Delete the unused local `STATIC_MODELS` constant (dead code) and its export.
- Add `fetchGeminiModels()`: calls `https://generativelanguage.googleapis.com/v1beta/models?key=<GEMINI_API_KEY>`, filters response to models whose `supportedGenerationMethods` includes `embedContent`, maps to `{label: model.displayName, value: model.name.replace('models/', ''), provider_type: 'gemini', capabilities: ['embeddings']}`. Falls back to the existing static Gemini embedding entry on failure or missing key.
- `getAvailableModels({ providerType, apiKey, capability })`:
  - `providerType === 'anthropic'` → existing native fetch (unchanged).
  - `providerType === 'openai'` → existing native fetch (unchanged).
  - `providerType === 'gemini' && capability === 'embeddings'` → `fetchGeminiModels()`.
  - `capability === 'chat'` (any other providerType, e.g. `gemini` for chat, `kimi`, or any OpenRouter-discovered provider) → `getOpenRouterModels({ providerType })` from the new module.
  - `providerType === 'jina'` → static (`getStaticModels`), unchanged.
  - `providerType === 'ollama'` → existing live local-server discovery in `server.js`, unchanged.

### `packages/ui/server.js` — `GET /api/system/model-catalog`

- `providers` response: `getProviderDefinitions(capability)` now naturally includes the dynamic OpenRouter providers when `capability` is `'chat'` or unset (handled inside `model-catalog.js` per above) — no route change needed beyond ensuring it awaits correctly (it's no longer fully synchronous, since deriving providers requires the OpenRouter fetch). Route handler becomes `async` around `getProviderDefinitions` if not already.
- `models` response: routes through `getAvailableModels` (already imported) for all branches except the existing static fallback; the "for other providers, use static models" catch-all becomes the OpenRouter-or-Jina-or-fallback path described above.

### `packages/ui/app/agents/page.jsx`

- `EmbeddingsConfig`'s provider `<select>` keeps its current 3 hardcoded options (`gemini`, `jina`, `ollama`) — embeddings provider choice is intentionally narrow (only providers with working embedding call-integration), unchanged by this work.
- The **chat** provider/model pickers (wherever in this file chat-capability dropdowns are rendered for AI agents) switch from any hardcoded `<option>` list to populating from `fetchModelCatalog({ capability: 'chat' })`, the same helper already used for embeddings models — no new client-side fetch logic needed, just removing hardcoded `<option>` elements and rendering `providers` from the response.

## Data flow (chat dropdown)

1. User opens a provider dropdown in the Agents UI.
2. Client calls `GET /api/system/model-catalog?capability=chat`.
3. Server calls `getProviderDefinitions('chat')` → returns `[ollama, claude_cli, ...openRouterProviders]` (OpenRouter fetch served from cache if fresh, otherwise fetched live and cached).
4. User picks a provider (e.g. `anthropic`); client calls `GET /api/system/model-catalog?provider_type=anthropic&capability=chat`.
5. Server's existing `anthropic` branch fires (native live fetch, unchanged) — OpenRouter is only consulted for providers without native fetch code.
6. If the user picks a provider that *only* exists via OpenRouter discovery (e.g. `mistralai`), the model list comes from `getOpenRouterModels({ providerType: 'mistralai' })`; selecting and saving that model is allowed by the UI, but the AI agent will fail at call-time with a clear "no integration for provider mistralai" error (out of scope to fix here).

## Error handling

| Failure | Behavior |
|---|---|
| OpenRouter API unreachable, cache has prior data | Serve stale cache, log warning, no user-facing error |
| OpenRouter API unreachable, no prior cache | Serve built-in fallback list (anthropic/openai/google, 3-4 models), log warning |
| OpenRouter returns malformed/empty data | Treated as failure, same fallback behavior as above |
| Gemini ListModels fails (bad key, network) | Fall back to the existing single static `gemini-embedding-2-preview` entry |
| Selected provider has no native call integration | Existing AI agent error surfaces normally when the user runs it; no new error handling added |

## Testing

- Unit test for the slug-parsing/grouping logic in `openrouter-catalog.js` (given a sample OpenRouter response fixture, verify correct provider list and per-provider model filtering) — pure function, no network needed.
- Manual verification: open Agents UI, confirm chat provider dropdown is populated beyond the previous 5 options, confirm Gemini embeddings still lists at least the current default model, confirm Ollama and Jina panels are unaffected.
- No automated test for live network calls to OpenRouter/Gemini (matches existing precedent — Anthropic/OpenAI live fetches in `model-fetcher.js` have no test coverage today either).
