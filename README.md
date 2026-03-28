# SecondBrain

A personal intelligence system that synthesizes your email, voice recordings, WhatsApp, and AI conversation history into actionable insight about your projects, relationships, and priorities.

<br>

> ### 📖 [User Manual →](docs/manual/README.md)
> Setup guides, agent configuration, and workflow playbooks for everyday users.

---

## Overview

[![Watch overview](https://img.youtube.com/vi/MyICwpD8Gew/maxresdefault.jpg)](https://youtu.be/MyICwpD8Gew)

---

## Demo

[![Watch demo](https://img.youtube.com/vi/MuMkDAK9Sp0/maxresdefault.jpg)](https://youtu.be/MuMkDAK9Sp0)

---

## Screenshots

**Relationships — Contact Intelligence**
Every contact profiled from your communications, tagged by relationship type, and ranked by recency.

![Relationships list](docs/screenshots/01-relationships-list.png)

**Relationships — Communication Timeline**
Full history across Email, WhatsApp, and Limitless in one scrollable view per person.

![Communications detail](docs/screenshots/02-relationships-detail-comms.png)

**Projects — Active Tracker**
AI-discovered projects with blockers, risks, next actions, and opportunities surfaced automatically.

![Projects](docs/screenshots/05-projects.png)

**Search — Semantic Search**
Natural language search across all indexed emails, messages, and lifelogs.

![Search results](docs/screenshots/06-search-results.png)

**Agents — Control Panel**
Start, stop, and configure all background agents from one place. View live logs, set schedules, and manage API keys.

![Agents dashboard](docs/screenshots/07-agents-dashboard.png)

---

## Getting Started

secondbrain is designed so you can get the whole application running with one command:

```bash
npm run ui
```

That starts:

- the Next.js UI on `http://localhost:4000`
- the Express API / agent-control server on `http://localhost:4001`

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- a database you can reach via `DATABASE_URL`

### Install

```bash
git clone <repo>
cd secondbrain
npm install
```

### Configure

Create `.env.local` in the repo root.

Minimum required:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/secondbrain
```

Optional values can be added now or later through the UI:

```env
# Gmail (optional)
GMAIL_EMAIL_1=you@gmail.com
GMAIL_APP_PASSWORD_1=xxxx xxxx xxxx xxxx

# Limitless (optional)
LIMITLESS_API_KEY=...

# AI / search (optional)
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...

# UI/API port override (optional)
UI_PORT=4001
```

### Start the app

```bash
npm run ui
```

Then open:

```text
http://localhost:4000
```

### First startup behavior

On startup, the server automatically and idempotently:

- initializes all agent schemas
- initializes shared system tables
- attempts to initialize the optional search / pgvector schema
- seeds sensible default config values into the database when missing

You do **not** need to run manual `psql` schema commands for normal setup.

If the PostgreSQL `vector` extension is not installed, semantic search is skipped and the rest of the app still works.

### Initial setup in the UI

Once the app is open, go to `/agents` and do this:

1. Add at least one `LLM Provider`.
2. Configure `Email` if you want Gmail sync.
3. Configure `Limitless` if you use Limitless.ai.
4. Add `Embeddings` if you want semantic search.
5. Start the agents you want to run.

Recommended starting order:

```text
 1. Email / Limitless / WhatsApp
 2. Relationships + Projects
 3. Research (optional)
```

The UI lets you start and stop background agents from one place, so after `npm run ui` you usually do not need to manage separate terminal windows for day-to-day usage.

### Quick-start path

If you just want a useful system quickly:

```text
 1. Set DATABASE_URL
 2. Run npm run ui
 3. Open /agents
 4. Add one LLM provider
 5. Configure Gmail
 6. Start Email, Relationships, and Projects
 7. Check Dashboard, Relationships, and Projects
```

---

## What secondbrain does

secondbrain turns fragmented communication into working intelligence.

It helps you answer questions like:

- Who matters right now?
- Which projects are drifting?
- What follow-up did I forget?
- Which groups are signaling opportunity or risk?
- What do I need to know before this meeting?

Instead of manually stitching together inboxes, chats, transcripts, and notes, secondbrain gives you one operating layer across all of them.

![Security](docs/infographics/security.png)

---

## Product Overview

### Main pages

| URL | What it does |
|-----|---------------|
| `/` | Dashboard for open insights, recent activity, and daily triage |
| `/relationships` | Contact intelligence, communication history, research, and opportunities |
| `/groups` | WhatsApp group intelligence, key topics, roles, and opportunities |
| `/projects` | Project tracking, recent communications, blockers, risks, and next actions |
| `/agents` | Agent control, configuration, logs, LLM providers, and embeddings |
| `/search` | Semantic search across indexed content |

### Core ideas

- Background agents ingest and analyze your data over time.
- Manual edits are sticky: if you correct a contact or project in the UI, later agent runs respect those overrides.
- Search is optional and depends on embeddings plus PostgreSQL `vector`.

---

## Agents

### Email Agent

Syncs Gmail inboxes into Postgres using IMAP.

- polls every 15 minutes
- supports multiple Gmail accounts
- powers relationship and project discovery

### Limitless Agent

Fetches and processes Limitless.ai lifelogs.

- fetches every 5 minutes
- processes batches every 30 seconds
- feeds meeting and spoken-context signals into the system

### WhatsApp Connector

Lives in this repo and is no longer external.

- bridges WhatsApp Web into Postgres
- stores messages, chat metadata, and media references
- powers the Groups page and strengthens Relationships / Projects
- performs a historical sync after connection

You can also run it directly with:

```bash
npm run whatsapp
```

### Relationships Agent

Builds contact profiles and relationship insights from your communications.

- links messages and people
- generates relationship summaries and follow-up insights
- analyzes WhatsApp groups

### Projects Agent

Discovers and tracks projects across email, WhatsApp, and lifelogs.

- groups communications into project threads
- generates blockers, risks, next actions, and opportunities
- updates projects incrementally over time

### Research Agent

Enriches contact profiles using outside research providers.

- optional
- useful for important external stakeholders
- can be triggered per contact from the Relationships page

### OpenAI and Gemini Importers

Import ChatGPT and Gemini conversation exports into the `ai` schema.

- useful for long-term memory and future workflows
- configured from the Agents page

---

## Architecture

```text
 Gmail         Limitless         WhatsApp         AI Exports
   |               |                 |                 |
   v               v                 v                 v
 +----------------------------------------------------------+
 |                    Ingestion Agents                      |
 |   Email   Limitless   WhatsApp   OpenAI/Gemini Importers |
 +----------------------------------------------------------+
                         |
                         v
 +----------------------------------------------------------+
 |                         Postgres                         |
 | email.* limitless.* relationships.* projects.* ai.*     |
 | system.* search.* public.messages                        |
 +----------------------------------------------------------+
                         |
                         v
 +----------------------------------------------------------+
 |                   Analysis / Enrichment                  |
 |      Relationships Agent   Projects Agent   Research     |
 +----------------------------------------------------------+
                         |
                         v
 +----------------------------------------------------------+
 |                           UI                             |
 | Dashboard | Relationships | Groups | Projects | Search  |
 | Agents                                                   |
 +----------------------------------------------------------+
```

All packages share a single Postgres database via `packages/db`.

The UI server manages:

- schema initialization
- config seeding
- agent start / stop / logs
- system configuration APIs
- semantic search indexing

---

## Repository Layout

```text
packages/
├── db/                     Shared Postgres connection pool
├── agents/
│   ├── email/              Gmail IMAP sync -> email.*
│   ├── limitless/          Limitless fetch + processing
│   ├── projects/           Project discovery and insights
│   ├── relationships/      Contact and group intelligence
│   ├── research/           External contact enrichment
│   ├── ai/                 OpenAI / Gemini importers
│   └── whatsapp/           WhatsApp Web connector
└── ui/
    ├── app/                Next.js frontend (port 4000)
    ├── services/           Search / embeddings background services
    ├── sql/                Search schema
    └── server.js           Express API + agent process manager
```

---

## Useful Commands

### Main app

```bash
npm run ui
```

Starts the UI plus API / agent-control server.

### Development mode

```bash
npm run ui:dev
```

Runs the same stack with Next.js dev mode.

### Individual agents

```bash
npm run email
npm run limitless
npm run relationships
npm run projects
npm run research
npm run whatsapp
npm run ai:openai
npm run ai:gemini
```

In normal usage, you can usually start and stop agents from `/agents` instead of using these commands directly.

---

## Notes

### Manual overrides

When you edit a project or contact in the UI, secondbrain stores that as a manual override and future agent runs try not to overwrite those fields.

### Search

Semantic search depends on:

- a Gemini API key for embeddings
- PostgreSQL `vector`

If either is missing, search may be unavailable while the rest of the system still works.

### WhatsApp

The WhatsApp connector is included in this repo. It is not an external dependency anymore.

---

## License

MIT
