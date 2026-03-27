# secondbrain

Personal intelligence system — ingests Gmail, Limitless.ai lifelogs, and WhatsApp into Postgres, then uses Claude to synthesize projects and relationships.

## Commands

```bash
npm run ui:dev          # Next.js (port 4000) + Express API (port 4001) — main dev command
npm run ui              # Production UI

npm run email           # Email sync agent (Gmail IMAP)
npm run limitless       # Limitless lifelog fetch + Claude processing
npm run relationships   # Relationships analysis agent
npm run projects        # Projects analysis agent
npm run ai:claude       # AI agent (Claude)
npm run ai:openai       # AI agent (OpenAI)
npm run ai:gemini       # AI agent (Gemini)
npm run whatsapp        # WhatsApp bridge (requires CLIENT_ID env var)
npm run whatsapp:setup  # Download Chromium for WhatsApp bridge (run once)

npm run init-db         # Initialize all agent schemas
```

## Architecture

```
packages/
├── db/                     Shared Postgres connection pool (pg Pool)
├── agents/
│   ├── email/              Gmail IMAP → email.emails
│   ├── limitless/          Limitless.ai API → Claude processing
│   ├── projects/           Claude project discovery across all sources
│   ├── relationships/      Claude contact profiling + relationship graph
│   ├── ai/                 Standalone AI agent (Claude / OpenAI / Gemini)
│   └── whatsapp/           WhatsApp Web bridge → public.messages (whatsapp-web.js + puppeteer)
└── ui/
    ├── app/                Next.js 14 frontend (port 4000)
    │   ├── agents/         Agent dashboard (start/stop/logs)
    │   ├── relationships/  Contact list + manual editing
    │   ├── groups/         WhatsApp group intelligence
    │   ├── projects/       Project tracker
    │   └── search/         Full-text + semantic search
    ├── services/
    │   ├── embedder.js     Gemini embedding API (gemini-embedding-2-preview, 3072 dims)
    │   └── indexer.js      Background embedding indexer (runs every 10 min)
    ├── server.js           Express API (port 4001) — agent process management + DB queries
    └── sql/
        └── search_schema.sql  pgvector schema (run once manually)
```

## Environment

`.env.local` in repo root — only `DATABASE_URL` is required. All other config (API keys, cron schedules, batch sizes) is stored in `system.config` / per-agent config tables and managed via the UI at `/agents`.

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/secondbrain

# Optional — API keys can be seeded from here on first startup,
# or entered later through the UI. See .env.example for the full list.
# UI_PORT=4001
```

On first startup the server seeds sensible defaults (cron schedules, batch sizes, embedding model) automatically. API keys are never defaulted — add them via the UI or `.env.local`.

## Database Schemas

All schemas are initialized automatically on `npm run ui` startup — no manual `psql` commands needed. The server runs each schema file in dependency order (agent schemas → system config schema → search/pgvector schema).

The `search.*` schema (pgvector) is optional — startup logs a warning and continues if the `vector` extension is not installed.

Key schemas: `email.*`, `limitless.*`, `projects.*`, `relationships.*`, `ai.*`, `system.*`, `search.*`, `public.messages` (WhatsApp).

## Gotchas

- **pgvector is optional** — if the `vector` extension isn't installed, semantic search is unavailable but everything else works. Server logs a warning on startup.
- **Agent process management lives in `server.js`** — agents are spawned as child processes; PIDs tracked in `.agent-pids/`, logs in `.agent-logs/`.
- **Manual overrides are sticky** — any field edited in the UI is written to `manual_overrides JSONB` on `projects.projects` / `relationships.contacts`. Agents never overwrite these. To unlock, send `_clearOverrides: ['field_name']` in a PATCH request.
- **WhatsApp bridge** — `packages/agents/whatsapp/` uses whatsapp-web.js + puppeteer to mirror messages into `public.messages`. Requires `CLIENT_ID` env var and a one-time `npm run whatsapp:setup` to download Chromium. Session auth stored in `.wwebjs_auth/` (gitignored). Start via `npm run whatsapp`; QR code appears in terminal on first run.
- **Semantic search needs a Gemini API key** — embedder reads `system.GEMINI_API_KEY` from the DB (configurable via Agents → Embeddings panel). Missing key throws at runtime.
- **npm workspaces, not yarn** — despite `yarn.lock` being present, the monorepo uses npm workspaces. Use `npm install` / `npm run <script>`.
- **Analysis agents are incremental** — Projects and Relationships agents run every 12 hours and only process new communications after the first run.
