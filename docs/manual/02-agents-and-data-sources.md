# Agents and Data Sources

This guide explains the moving parts behind secondbrain.

## The big picture

secondbrain works in layers:

```text
 Layer 1: bring data in
   Email Agent
   Limitless Agent
   WhatsApp Connector

 Layer 2: understand the data
   Relationships Agent
   Projects Agent
   Research Agent

 Layer 3: let you use it
   Dashboard
   Relationships
   Groups
   Projects
   Search
```

## Why agents matter

Agents are background workers. They do the slow, repetitive work for you:

- fetching new information
- analyzing conversations
- linking messages to people and projects
- keeping the system fresh over time

You do not need to keep clicking buttons all day. Once configured, they keep the system alive.

## Email Agent

### What it does

- connects to Gmail using IMAP
- saves emails into the database
- supports multiple Gmail accounts

### Why it is useful

- it gives secondbrain a steady stream of real work and relationship signals
- project discovery becomes much better
- contact profiles become much better

### What you configure

- Gmail address
- Gmail app password
- batch size
- mailbox name, usually `INBOX`

### Schedule

- runs every 15 minutes
- also runs once when it starts

### Workflow

```text
 Gmail inbox
    |
    v
 Email Agent
    |
    v
 email.emails
    |
    +--> Relationships Agent
    |
    +--> Projects Agent
    |
    +--> Search indexer
```

## Limitless Agent

### What it does

- fetches Limitless lifelogs
- stores them as immutable source evidence
- leaves semantic analysis to the relationship and intelligence pipelines

### Why it is useful

- it captures meetings, spoken context, and memory signals that never appear in email
- it helps secondbrain detect people, topics, and projects you discussed out loud

### What you configure

- Limitless API key
- fetch interval
- number of days to fetch

### Schedule

- fetches every 5 minutes
- processes batches every 30 seconds

### Workflow

```text
 Limitless
    |
    v
 Limitless Agent
    |
    v
 limitless.lifelogs
    |
    +--> Relationships Agent
    |
    +--> Projects Agent
    |
    +--> Search indexer
```

## WhatsApp Connector

### What it does

- logs into WhatsApp Web
- saves WhatsApp messages into Postgres
- syncs recent history after connection
- keeps group and chat information current

### Why it is useful

- it unlocks the Groups page
- it makes the Relationships page far more personal and timely
- it gives Projects another strong source of real-world activity

### What it needs

- `CLIENT_ID` environment variable
- a working WhatsApp Web login
- a QR code scan from your phone

### What to expect

When it starts successfully:

1. it shows a QR code in its logs if needed
2. you scan the code with WhatsApp on your phone
3. it connects
4. it performs a historical sync of roughly the last 14 days

### Extra admin screen

The connector also exposes its own small admin page, usually at:

`http://localhost:3000/admin/`

That page is useful for:

- checking connector status
- seeing recent messages
- managing webhook subscribers if your setup uses them

### Workflow

```text
 WhatsApp phone app
       |
       v
 WhatsApp Web session
       |
       v
 WhatsApp Connector
       |
       v
 public.messages
       |
       +--> Relationships Agent
       |
       +--> Groups page
       |
       +--> Projects Agent
       |
       +--> Search indexer
```

## Relationships Agent

### What it does

- builds contact profiles
- links communications to people
- generates relationship insights
- analyzes WhatsApp groups

### Why it is useful

- it tells you who matters
- it surfaces neglected or promising relationships
- it gives context before you reach out to someone

### Schedule

- runs on startup
- then every 6 hours

### Important truth

The "Run Analysis" action in the UI does not force an immediate deep rerun. If you want a fresh run now, restarting the agent is the reliable method.

## Projects Agent

### What it does

- discovers projects from communications
- groups related activity under a project
- generates project insights such as blockers and next actions

### Why it is useful

- it turns scattered activity into a project view
- it helps you see momentum, risk, and silence
- it avoids relying on memory alone

### Schedule

- runs on startup
- then every 12 hours

### Important truth

Like the Relationships Agent, the UI's run message is mostly a reminder about the schedule. Restarting the agent is the practical way to trigger immediate fresh work.

## Research Agent

### What it does

- enriches strong or moderate contacts with outside research
- can use Tavily, OpenAI, PeopleDataLabs, and SerpAPI
- creates a research summary for the contact

### Why it is useful

- it adds external professional context
- it helps with people you know but have not thought about recently
- it can improve meeting prep and follow-ups

### Schedule

- runs daily
- can also be triggered per contact from the Relationships page

## OpenAI Importer

### What it does

- imports ChatGPT export files into the `ai` database schema

### Why you might use it

- long-term archiving
- future workflows that rely on your past AI conversations

### Important truth

The current UI shows import stats, but it does not yet provide a dedicated page for browsing imported ChatGPT conversations.

## Gemini Importer

### What it does

- imports Gemini export files into the `ai` database schema

### Why you might use it

- long-term archiving
- keeping another source of personal thinking in one place

### Important truth

As with the OpenAI importer, the main benefit right now is storage and future usefulness, not a finished front-end browsing experience.

## A good default setup for most people

If you are not sure what to run, use this stack:

```text
 Required:
   Email Agent
   Relationships Agent
   Projects Agent

 Recommended:
   Limitless Agent
   Search embeddings

 Optional:
   WhatsApp Connector
   Research Agent
   OpenAI Importer
   Gemini Importer
```

## How to think about "enough setup"

You do not need every source connected on day one.

A practical path is:

1. connect Gmail
2. add one LLM provider
3. start Relationships and Projects
4. review results
5. add Limitless and WhatsApp later

That approach gets value quickly without overwhelming the setup process.
