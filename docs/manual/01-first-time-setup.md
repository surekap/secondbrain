# First-Time Setup

This guide gets you from "installed" to "usable."

## Goal

By the end of this guide, you should be able to:

- open the app
- save the important configuration values
- start the right agents
- confirm that data is beginning to arrive

## Before you start

You need at least:

- a working PostgreSQL database
- a `DATABASE_URL` in the repo's `.env.local`

Optional but strongly recommended:

- Gmail app password for email sync
- Limitless API key for lifelogs
- Gemini API key for semantic search
- one or more AI providers for the agents

## The minimum viable setup

If you want the fastest route to a working system, do this:

```text
 1. Set DATABASE_URL
 2. Start the UI
 3. Open /agents
 4. Configure Email and/or Limitless
 5. Add at least one LLM provider
 6. Start Email, Relationships, and Projects
 7. Wait for data to appear
```

## Step 1: check `.env.local`

The app expects a file named `.env.local` in the project root.

The one required value is:

```env
DATABASE_URL=postgresql://user:pass@localhost:5432/secondbrain
```

If this value is missing or wrong, the app may open but many screens will fail because the database is unavailable.

## Step 2: start the app

From the project root, the main command is:

```bash
npm run ui:dev
```

This starts:

- the web UI on `http://localhost:4000`
- the API server on `http://localhost:4001`

Open `http://localhost:4000` in your browser.

The listeners are loopback-only by default. For remote access from another device on your tailnet, keep those bindings private and expose the main UI with Tailscale Serve:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4000
tailscale serve status
```

If port 443 is already occupied, use Tailscale's supported 8443 port and include
it in the browser URL:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:4000
```

Add the exact HTTPS URL reported by Tailscale to `.env.local` and restart the app:

```env
SECOND_BRAIN_ALLOWED_ORIGINS=https://your-mac.your-tailnet.ts.net
```

For the 8443 form, use `https://your-mac.your-tailnet.ts.net:8443`.

For the development server, also set `SECOND_BRAIN_ALLOWED_DEV_ORIGINS=your-mac.your-tailnet.ts.net`. Access control belongs in your Tailscale ACLs; ports 3000, 4000, and 4001 should not be opened directly.

## Step 3: let the app initialize the database

On startup, the server automatically creates the main schemas it needs.

It also restores the long-running Email, Limitless, Relationships, Projects, Intelligence, WhatsApp, and Sampler agents when their durable desired state is `running`. A Stop action is durable, so an intentionally stopped core agent stays stopped after a UI restart. Unexpected exits are retried with capped exponential backoff.

That means you usually do not need to run manual SQL commands just to begin.

The one special case is semantic search:

- search can be unavailable if your database does not have the `vector` extension
- everything else can still work

## Step 4: go to the Agents page

Open `/agents` from the top navigation.

This is your control center for:

- configuration
- start and stop controls
- logs
- LLM provider setup
- embedding setup for search

## Step 5: configure the system-wide panels first

At the top of `/agents` there are two important shared panels.

### LLM Providers

Add at least one provider here so the analysis agents can think.

Supported provider types:

- Anthropic
- Claude CLI
- OpenAI
- Gemini

You can add more than one. Each agent can then be told which provider to try first.

### Embeddings

This controls semantic search.

Fill in:

- `Gemini API Key`
- optionally `Embedding model`

Without this, the Search page may not work even if the rest of the product does.

## Step 6: configure your data sources

### Email

On the Email Agent card:

1. Open the `Config` tab.
2. Add one or more Gmail accounts.
3. Paste each Gmail app password.
4. Save.
5. Restart the agent if the page tells you a restart is needed.

The email agent fetches mail every 15 minutes and also runs an initial fetch when it starts.

### Limitless

On the Limitless Agent card:

1. Open the `Config` tab.
2. Add your Limitless API key.
3. Choose the fetch interval and history window.
4. Save.
5. Restart the agent if needed.

The Limitless agent fetches new lifelogs every 5 minutes. Relationship and intelligence agents analyze the canonicalized evidence separately.

### WhatsApp

If you want WhatsApp data, you also need the WhatsApp Connector.

Important notes:

- it requires a `CLIENT_ID` environment variable
- it uses WhatsApp Web login
- when it connects, it performs a historical sync for about the last 14 days

If your setup includes the connector, start it from `/agents` and complete the QR code login flow described in [02-agents-and-data-sources.md](/Users/prateeksureka/Sites/secondbrain/docs/manual/02-agents-and-data-sources.md).

## Step 7: start the core agents

For most people, the most useful starting combination is:

- `Email Agent`
- `Relationships Agent`
- `Projects Agent`

If you use Limitless, start that too.

Recommended order:

```text
 Email / Limitless / WhatsApp
            |
            v
   Relationships + Projects
            |
            v
        Search indexer
```

Why this order matters:

- ingestion agents collect raw data first
- analysis agents depend on raw data
- search depends on indexed content

## Step 8: assign LLM priority for each agent

Each agent card has an `LLM` tab.

Use it to decide which provider that agent should try first, second, and third.

Example:

```text
 Relationships Agent
 1. Claude CLI
 2. Anthropic API
 3. OpenAI API
```

This is useful if:

- one provider is cheaper
- one provider is better for a certain task
- one provider runs out of credits

## Step 9: confirm it is working

You should now check three things:

### A. Logs are moving

Open the `Logs` tab on the running agent cards.

Good signs:

- "started"
- "fetch completed"
- "schema ready"
- records found, analyzed, imported, or indexed

### B. Stats are no longer empty

On the Agents page, cards should start showing totals such as:

- total emails
- total lifelogs
- enriched contacts
- imported conversations

### C. Product pages stop looking blank

Check:

- `/` for dashboard insights
- `/relationships` for contacts
- `/projects` for project entries
- `/groups` for WhatsApp group analysis
- `/search` for indexed counts

## A realistic first-day timeline

```text
 First 5 minutes:
   UI opens, agents start, logs begin

 First 15 minutes:
   email starts appearing
   some relationships and projects may appear

 First 1-2 hours:
   analysis gets more useful
   dashboard becomes more meaningful

 First day:
   recurring agents have had time to build patterns
```

## If nothing appears

Use this quick checklist:

- Is `DATABASE_URL` correct?
- Did you save the config on `/agents`?
- Did you restart the agent after saving?
- Is the agent running?
- Does its log show errors?
- Did you connect at least one real data source?

If needed, move to [09-troubleshooting.md](/Users/prateeksureka/Sites/secondbrain/docs/manual/09-troubleshooting.md).
