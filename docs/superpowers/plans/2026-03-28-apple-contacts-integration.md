# Apple Contacts Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Apple Contacts into `relationships.contacts` with enrichment, avatar support, and a VCF upload fallback for Linux deployments.

**Architecture:** New package `packages/agents/apple-contacts/` with three services (`vcfParser.js`, `nativeReader.js`, `syncer.js`) and an `index.js` entry point. Server.js gains an AGENTS entry, an import endpoint, and stats. The relationships page gains avatar photo rendering.

**Tech Stack:** Node.js CJS, `vcf@^2.x` (vCard parsing), `node-mac-contacts@^1.x` (macOS native, optional), PostgreSQL via `packages/db`, Express multipart via `multer`.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/agents/apple-contacts/sql/schema.sql` | Create | ALTER TABLE to add `apple_contact_id` and `avatar_data` |
| `packages/agents/apple-contacts/package.json` | Create | Package manifest with optional native dep |
| `packages/agents/apple-contacts/index.js` | Create | Agent entry — schedules native sync or exits on Linux |
| `packages/agents/apple-contacts/services/vcfParser.js` | Create | Parse .vcf string into normalized contact objects |
| `packages/agents/apple-contacts/services/nativeReader.js` | Create | macOS native reader via node-mac-contacts |
| `packages/agents/apple-contacts/services/syncer.js` | Create | DB matching + upsert shared by both readers |
| `packages/ui/server.js` | Modify | AGENTS entry, stats fn, import endpoint, schema registration |
| `packages/ui/app/agents/page.jsx` | Modify | Sync Now + Upload VCF buttons, apple-contacts stats |
| `packages/ui/app/relationships/page.jsx` | Modify | Render avatar photo from `avatar_data` |
| `package.json` (root) | Modify | Add `apple-contacts` run script |

---

### Task 1: Schema SQL

**Files:**
- Create: `packages/agents/apple-contacts/sql/schema.sql`

- [ ] **Step 1: Create the schema file**

```sql
-- Apple Contacts integration — adds two columns to relationships.contacts
-- Idempotent: safe to run multiple times

ALTER TABLE relationships.contacts
  ADD COLUMN IF NOT EXISTS apple_contact_id TEXT;

ALTER TABLE relationships.contacts
  ADD COLUMN IF NOT EXISTS avatar_data TEXT; -- base64-encoded JPEG

CREATE INDEX IF NOT EXISTS contacts_apple_contact_id_idx
  ON relationships.contacts (apple_contact_id)
  WHERE apple_contact_id IS NOT NULL;
```

Save to `packages/agents/apple-contacts/sql/schema.sql`.

- [ ] **Step 2: Verify columns don't already exist, then run the SQL manually**

```bash
psql "$DATABASE_URL" -c "\d relationships.contacts" | grep -E 'apple_contact|avatar'
```
Expected: no output (columns not yet present).

```bash
psql "$DATABASE_URL" -f packages/agents/apple-contacts/sql/schema.sql
```
Expected:
```
ALTER TABLE
ALTER TABLE
CREATE INDEX
```

- [ ] **Step 3: Verify columns exist**

```bash
psql "$DATABASE_URL" -c "\d relationships.contacts" | grep -E 'apple_contact|avatar'
```
Expected:
```
 apple_contact_id | text |
 avatar_data      | text |
```

- [ ] **Step 4: Commit**

```bash
git add packages/agents/apple-contacts/sql/schema.sql
git commit -m "feat: add apple_contact_id and avatar_data columns to relationships.contacts"
```

---

### Task 2: Package manifest

**Files:**
- Create: `packages/agents/apple-contacts/package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@secondbrain/apple-contacts",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {},
  "dependencies": {
    "vcf": "^2.1.1",
    "multer": "^1.4.5-lts.1",
    "dotenv": "^16.0.0",
    "pg": "^8.11.0"
  },
  "optionalDependencies": {
    "node-mac-contacts": "^1.3.0"
  }
}
```

Save to `packages/agents/apple-contacts/package.json`.

- [ ] **Step 2: Install deps from repo root**

```bash
npm install
```

Expected: `vcf` and `multer` installed; `node-mac-contacts` installed on macOS (may fail on Linux — that's fine, it's optional).

- [ ] **Step 3: Verify vcf is importable**

```bash
node -e "const vCard = require('vcf'); console.log('vcf ok:', typeof vCard)"
```
Expected: `vcf ok: function`

- [ ] **Step 4: Commit**

```bash
git add packages/agents/apple-contacts/package.json package.json package-lock.json
git commit -m "feat: add @secondbrain/apple-contacts package"
```

---

### Task 3: vcfParser.js

**Files:**
- Create: `packages/agents/apple-contacts/services/vcfParser.js`

- [ ] **Step 1: Create services directory and write vcfParser.js**

```js
'use strict';

const vCard = require('vcf');

/**
 * Parse a .vcf file string into an array of normalized contact objects.
 * @param {string} vcfText
 * @returns {Array<NormalizedContact>}
 */
function parseVcf(vcfText) {
  const cards = vCard.parse(vcfText);
  return cards.map(normalizeCard).filter(Boolean);
}

function normalizeCard(card) {
  const get = (field) => {
    const f = card.get(field);
    if (!f) return null;
    return Array.isArray(f) ? f[0].valueOf() : f.valueOf();
  };

  const getAll = (field) => {
    const f = card.get(field);
    if (!f) return [];
    return (Array.isArray(f) ? f : [f]).map(x => x.valueOf()).filter(Boolean);
  };

  // UID — stable ID; prefix vcf: to avoid collisions with native Apple IDs
  let uid = get('uid');
  const fn = get('fn') || '';
  const emails = getAll('email').map(e => e.toLowerCase().trim()).filter(Boolean);

  if (!uid) {
    // deterministic fallback from FN + first email
    uid = 'vcf:' + Buffer.from((fn + (emails[0] || '')).toLowerCase()).toString('base64');
  } else {
    uid = 'vcf:' + uid;
  }

  // N field: "Last;First;Middle;Prefix;Suffix"
  let firstName = null;
  let lastName = null;
  const n = card.get('n');
  if (n) {
    const parts = n.valueOf().split(';');
    lastName  = (parts[0] || '').trim() || null;
    firstName = (parts[1] || '').trim() || null;
  }

  const displayName = fn ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    null;

  if (!displayName) return null; // skip empty cards

  // Phone numbers — digits only, keep last 10
  const phoneNumbers = getAll('tel')
    .map(t => t.replace(/\D/g, ''))
    .filter(t => t.length >= 7)
    .map(t => t.slice(-10));

  // Company
  const org = get('org');
  const company = org ? org.split(';')[0].trim() || null : null;

  // Job title
  const jobTitle = get('title') || null;

  // Avatar — PHOTO field
  let avatarData = null;
  const photo = card.get('photo');
  if (photo) {
    const raw = photo.valueOf();
    // raw may be base64 or a URL; only store base64 blobs
    if (raw && !raw.startsWith('http') && raw.length > 100) {
      // Strip any data URI prefix if present
      avatarData = raw.replace(/^data:[^;]+;base64,/, '').trim() || null;
    }
  }

  return {
    apple_contact_id: uid,
    display_name:     displayName,
    first_name:       firstName,
    last_name:        lastName,
    emails,
    phone_numbers:    phoneNumbers,
    company,
    job_title:        jobTitle,
    avatar_data:      avatarData,
  };
}

module.exports = { parseVcf };
```

- [ ] **Step 2: Write a quick smoke test**

```bash
node -e "
const { parseVcf } = require('./packages/agents/apple-contacts/services/vcfParser');
const vcf = \`BEGIN:VCARD
VERSION:3.0
UID:test-uid-123
FN:Jane Doe
N:Doe;Jane;;;
EMAIL:jane@example.com
TEL:+1 (555) 867-5309
ORG:Acme Corp
TITLE:Engineer
END:VCARD\`;
const result = parseVcf(vcf);
console.log(JSON.stringify(result, null, 2));
"
```

Expected output (structure):
```json
[
  {
    "apple_contact_id": "vcf:test-uid-123",
    "display_name": "Jane Doe",
    "first_name": "Jane",
    "last_name": "Doe",
    "emails": ["jane@example.com"],
    "phone_numbers": ["5558675309"],
    "company": "Acme Corp",
    "job_title": "Engineer",
    "avatar_data": null
  }
]
```

- [ ] **Step 3: Test fallback UID (no UID field)**

```bash
node -e "
const { parseVcf } = require('./packages/agents/apple-contacts/services/vcfParser');
const vcf = \`BEGIN:VCARD
VERSION:3.0
FN:Bob Smith
EMAIL:bob@test.com
END:VCARD\`;
const [c] = parseVcf(vcf);
console.log('uid starts with vcf:', c.apple_contact_id.startsWith('vcf:'));
console.log('uid is stable:', c.apple_contact_id === parseVcf(vcf)[0].apple_contact_id);
"
```
Expected: both lines `true`.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/apple-contacts/services/vcfParser.js
git commit -m "feat: add vcfParser for cross-platform vCard parsing"
```

---

### Task 4: nativeReader.js

**Files:**
- Create: `packages/agents/apple-contacts/services/nativeReader.js`

- [ ] **Step 1: Create nativeReader.js**

```js
'use strict';

if (process.platform !== 'darwin') {
  throw new Error('Native Apple Contacts sync requires macOS');
}

let contacts;
try {
  contacts = require('node-mac-contacts');
} catch (err) {
  throw new Error(
    'node-mac-contacts is not installed or could not be loaded. ' +
    'Run: npm install --optional  (Error: ' + err.message + ')'
  );
}

/**
 * Read all contacts from Apple Contacts (macOS only).
 * Triggers the macOS Contacts privacy permission dialog on first access.
 * @returns {Promise<Array<NormalizedContact>>}
 */
async function readNativeContacts() {
  let raw;
  try {
    raw = contacts.getAllContacts();
  } catch (err) {
    if (err.message && err.message.includes('denied')) {
      console.error(
        '[apple-contacts] Access to Contacts denied. ' +
        'Grant access in System Settings → Privacy & Security → Contacts.'
      );
      process.exit(1);
    }
    throw err;
  }

  if (!Array.isArray(raw)) {
    throw new Error('node-mac-contacts.getAllContacts() returned unexpected value');
  }

  return raw.map(normalizeNativeContact).filter(Boolean);
}

function normalizeNativeContact(c) {
  const firstName = (c.firstName || '').trim() || null;
  const lastName  = (c.lastName  || '').trim() || null;
  const nickname  = (c.nickname  || '').trim() || null;
  const org       = (c.organization || '').trim() || null;

  const displayName =
    [firstName, lastName].filter(Boolean).join(' ') ||
    org ||
    nickname ||
    null;

  if (!displayName) return null;

  const emails = (c.emailAddresses || [])
    .map(e => (e.value || '').toLowerCase().trim())
    .filter(Boolean);

  const phoneNumbers = (c.phoneNumbers || [])
    .map(p => (p.value || '').replace(/\D/g, ''))
    .filter(t => t.length >= 7)
    .map(t => t.slice(-10));

  // image is a Buffer (JPEG data) when present
  let avatarData = null;
  if (c.image && Buffer.isBuffer(c.image) && c.image.length > 0) {
    avatarData = c.image.toString('base64');
  }

  return {
    apple_contact_id: c.identifier,  // stable UUID from macOS
    display_name:     displayName,
    first_name:       firstName,
    last_name:        lastName,
    emails,
    phone_numbers:    phoneNumbers,
    company:          org,
    job_title:        (c.jobTitle || '').trim() || null,
    avatar_data:      avatarData,
  };
}

module.exports = { readNativeContacts };
```

- [ ] **Step 2: Verify it throws on non-macOS (skip on macOS)**

On Linux, run:
```bash
node -e "require('./packages/agents/apple-contacts/services/nativeReader')" 2>&1 | grep -c 'requires macOS'
```
Expected: `1` (error thrown as expected).

On macOS, verify the module loads without crashing:
```bash
node -e "const r = require('./packages/agents/apple-contacts/services/nativeReader'); console.log(typeof r.readNativeContacts)"
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add packages/agents/apple-contacts/services/nativeReader.js
git commit -m "feat: add nativeReader for macOS Apple Contacts access"
```

---

### Task 5: syncer.js

**Files:**
- Create: `packages/agents/apple-contacts/services/syncer.js`

This is the most critical file. It matches incoming contacts against the DB using a priority order (apple_contact_id → phone → email → name) and upserts.

- [ ] **Step 1: Create syncer.js**

```js
'use strict';

const { Pool } = require('pg');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') });

let _db = null;
function getDb() {
  if (!_db) _db = new Pool({ connectionString: process.env.DATABASE_URL });
  return _db;
}

/**
 * Sync an array of normalized contact objects into relationships.contacts.
 * @param {Array<NormalizedContact>} contacts
 * @returns {{ total: number, matched: number, created: number, skipped: number }}
 */
async function syncContacts(contacts) {
  const db = getDb();
  let matched = 0;
  let created = 0;
  let skipped = 0;

  for (const contact of contacts) {
    try {
      const existing = await findMatch(db, contact);
      if (existing) {
        await enrichExisting(db, existing, contact);
        matched++;
      } else {
        await createContact(db, contact);
        created++;
      }
    } catch (err) {
      console.error('[apple-contacts] Failed to sync contact:', contact.display_name, err.message);
      skipped++;
    }
  }

  return { total: contacts.length, matched, created, skipped };
}

/**
 * Find an existing contact matching the incoming contact.
 * Priority: apple_contact_id → phone → email → normalized name
 */
async function findMatch(db, contact) {
  // 1. apple_contact_id (fast re-sync path)
  if (contact.apple_contact_id) {
    const { rows } = await db.query(
      'SELECT * FROM relationships.contacts WHERE apple_contact_id = $1 LIMIT 1',
      [contact.apple_contact_id]
    );
    if (rows.length) return rows[0];
  }

  // 2. Phone number match (last 10 digits against phone_numbers array)
  if (contact.phone_numbers && contact.phone_numbers.length > 0) {
    const { rows } = await db.query(
      `SELECT * FROM relationships.contacts
       WHERE phone_numbers && $1::text[]
       LIMIT 1`,
      [contact.phone_numbers]
    );
    if (rows.length) return rows[0];
  }

  // 3. Email match (lowercase exact)
  if (contact.emails && contact.emails.length > 0) {
    const { rows } = await db.query(
      `SELECT * FROM relationships.contacts
       WHERE emails && $1::text[]
       LIMIT 1`,
      [contact.emails]
    );
    if (rows.length) return rows[0];
  }

  // 4. Normalized name (last resort, no fuzzy)
  if (contact.display_name) {
    const normalized = contact.display_name.toLowerCase().trim();
    const { rows } = await db.query(
      'SELECT * FROM relationships.contacts WHERE normalized_name = $1 LIMIT 1',
      [normalized]
    );
    if (rows.length) return rows[0];
  }

  return null;
}

/**
 * Enrich an existing contact with Apple Contacts data.
 * Respects manual_overrides for company and job_title.
 */
async function enrichExisting(db, existing, contact) {
  const overrides = existing.manual_overrides || {};

  // Merge emails (array union, deduped)
  const mergedEmails = Array.from(new Set([
    ...(existing.emails || []),
    ...(contact.emails  || []),
  ]));

  // Merge phone_numbers (array union, deduped)
  const mergedPhones = Array.from(new Set([
    ...(existing.phone_numbers || []),
    ...(contact.phone_numbers  || []),
  ]));

  // company — only fill if null AND not overridden
  const newCompany = (!existing.company && !overrides.company && contact.company)
    ? contact.company
    : existing.company;

  // job_title — only fill if null AND not overridden
  const newJobTitle = (!existing.job_title && !overrides.job_title && contact.job_title)
    ? contact.job_title
    : existing.job_title;

  await db.query(
    `UPDATE relationships.contacts SET
       apple_contact_id = $1,
       avatar_data      = $2,
       emails           = $3,
       phone_numbers    = $4,
       company          = $5,
       job_title        = $6,
       updated_at       = NOW()
     WHERE id = $7`,
    [
      contact.apple_contact_id,
      contact.avatar_data,
      mergedEmails,
      mergedPhones,
      newCompany,
      newJobTitle,
      existing.id,
    ]
  );
}

/**
 * Create a new contact record from Apple Contacts data.
 */
async function createContact(db, contact) {
  const normalized = contact.display_name.toLowerCase().trim();
  await db.query(
    `INSERT INTO relationships.contacts
       (display_name, normalized_name, emails, phone_numbers,
        company, job_title, apple_contact_id, avatar_data,
        relationship_type, relationship_strength, is_noise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unknown','weak',false)`,
    [
      contact.display_name,
      normalized,
      contact.emails       || [],
      contact.phone_numbers || [],
      contact.company      || null,
      contact.job_title    || null,
      contact.apple_contact_id,
      contact.avatar_data  || null,
    ]
  );
}

module.exports = { syncContacts };
```

- [ ] **Step 2: Smoke-test the matching query syntax against the DB**

```bash
node -e "
const { Pool } = require('pg');
require('dotenv').config({ path: '.env.local' });
const db = new Pool({ connectionString: process.env.DATABASE_URL });
db.query(\"SELECT COUNT(*) FROM relationships.contacts WHERE phone_numbers && ARRAY['5551234567']\")
  .then(r => { console.log('query ok, count:', r.rows[0].count); db.end(); })
  .catch(e => { console.error('FAIL:', e.message); db.end(); process.exit(1); });
"
```
Expected: `query ok, count: <number>` (0 is fine — just verifying the query runs).

- [ ] **Step 3: Smoke-test createContact with a test record, then clean up**

```bash
node -e "
const { syncContacts } = require('./packages/agents/apple-contacts/services/syncer');
const testContact = {
  apple_contact_id: 'vcf:smoke-test-delete-me',
  display_name: 'Smoke Test Contact',
  first_name: 'Smoke',
  last_name: 'Test',
  emails: ['smoketest_deleteme@example.com'],
  phone_numbers: ['0000000000'],
  company: 'Test Corp',
  job_title: 'Tester',
  avatar_data: null,
};
syncContacts([testContact]).then(r => {
  console.log('result:', JSON.stringify(r));
  process.exit(0);
});
" && psql "$DATABASE_URL" -c "DELETE FROM relationships.contacts WHERE apple_contact_id = 'vcf:smoke-test-delete-me'"
```
Expected: `result: {"total":1,"matched":0,"created":1,"skipped":0}` followed by `DELETE 1`.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/apple-contacts/services/syncer.js
git commit -m "feat: add syncer with phone/email/name matching and DB upsert"
```

---

### Task 6: index.js (agent entry point)

**Files:**
- Create: `packages/agents/apple-contacts/index.js`

- [ ] **Step 1: Create index.js**

```js
'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const { syncContacts } = require('./services/syncer');

const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runNativeSync() {
  console.log('[apple-contacts] Starting native sync…');
  let reader;
  try {
    reader = require('./services/nativeReader');
  } catch (err) {
    console.error('[apple-contacts] Cannot load native reader:', err.message);
    process.exit(1);
  }

  const contacts = await reader.readNativeContacts();
  console.log(`[apple-contacts] Read ${contacts.length} contacts from Apple Contacts`);

  const result = await syncContacts(contacts);
  console.log(
    `[apple-contacts] Sync complete — total: ${result.total}, ` +
    `matched: ${result.matched}, created: ${result.created}, skipped: ${result.skipped}`
  );
  return result;
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[apple-contacts] Native Apple Contacts sync not available on this platform.');
    console.log('[apple-contacts] Use "Upload VCF" on the Agents page to import contacts.');
    process.exit(0);
  }

  // Run immediately on start
  await runNativeSync();

  // Then schedule daily
  setInterval(async () => {
    try {
      await runNativeSync();
    } catch (err) {
      console.error('[apple-contacts] Sync error:', err.message);
    }
  }, SYNC_INTERVAL_MS);

  // Stay alive
  process.on('SIGINT',  () => { console.log('[apple-contacts] Stopped.'); process.exit(0); });
  process.on('SIGTERM', () => { console.log('[apple-contacts] Stopped.'); process.exit(0); });
}

main().catch(err => {
  console.error('[apple-contacts] Fatal:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Test Linux/non-macOS exit behavior (skip on macOS, verify on Linux)**

On Linux:
```bash
node packages/agents/apple-contacts/index.js
```
Expected: prints "Native Apple Contacts sync not available on this platform." and exits 0.

On macOS (if not granting contacts access), set the platform guard manually:
```bash
node -e "
process.platform = 'linux';
// Just verify import doesn't crash
const i = require('./packages/agents/apple-contacts/index.js');
" 2>&1 | head -5
```
(This won't execute main because of how the file is structured, so just verify no syntax errors.)

Actually, simpler check:
```bash
node --check packages/agents/apple-contacts/index.js && echo "syntax ok"
```
Expected: `syntax ok`

- [ ] **Step 3: Commit**

```bash
git add packages/agents/apple-contacts/index.js
git commit -m "feat: add apple-contacts agent entry point with daily sync schedule"
```

---

### Task 7: Server.js integration

**Files:**
- Modify: `packages/ui/server.js`

This task adds the schema file to `runSystemSchema()`, adds the AGENTS entry, `appleContactsStats()`, the import endpoint, and wires stats into `GET /api/agents`.

- [ ] **Step 1: Register schema in runSystemSchema**

In `packages/ui/server.js`, find the `schemas` array in `runSystemSchema()`. It currently ends with:
```js
    { file: '../agents/whatsapp/src/db/schema.sql',    required: true  },
    { file: '../agents/shared/sql/system-schema.sql',  required: true  },
    { file: './sql/search_schema.sql',                 required: false },
```

Add the apple-contacts schema after whatsapp and before shared:
```js
    { file: '../agents/whatsapp/src/db/schema.sql',       required: true  },
    { file: '../agents/apple-contacts/sql/schema.sql',    required: true  },
    { file: '../agents/shared/sql/system-schema.sql',     required: true  },
    { file: './sql/search_schema.sql',                    required: false },
```

- [ ] **Step 2: Add the AGENTS entry**

In `packages/ui/server.js`, find the `AGENTS` object. After the `whatsapp` entry:
```js
  whatsapp: {
    id:          'whatsapp',
    name:        'WhatsApp Connector',
    description: 'Bridges WhatsApp Web to Postgres — saves messages and fans out to webhook subscribers',
    entrypoint:  path.resolve(__dirname, '../agents/whatsapp/src/app.js'),
  },
```

Add:
```js
  'apple-contacts': {
    id:              'apple-contacts',
    name:            'Apple Contacts',
    description:     'Syncs Apple Contacts into the relationships database. VCF upload available on all platforms.',
    entrypoint:      path.resolve(__dirname, '../agents/apple-contacts/index.js'),
    nativeAvailable: process.platform === 'darwin',
  },
```

- [ ] **Step 3: Add appleContactsStats function**

After `researchStats()` or after `whatsappStats()`, add:

```js
async function appleContactsStats() {
  if (!db) return null;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE apple_contact_id IS NOT NULL)                               AS total_synced,
        COUNT(*) FILTER (WHERE apple_contact_id IS NOT NULL AND first_interaction_at IS NULL) AS no_comms,
        MAX(updated_at) FILTER (WHERE apple_contact_id IS NOT NULL)                        AS last_sync_at
      FROM relationships.contacts
    `);
    return rows[0];
  } catch { return null; }
}
```

- [ ] **Step 4: Wire stats into GET /api/agents**

Find the `GET /api/agents` route. It currently has:
```js
  const [eStats, lStats, rStats, pStats, oaiStats, gemStats, rsStats, waStats] = await Promise.all([
    emailStats(), limitlessStats(), relationshipsStats(), projectsStats(),
    aiStats('openai'), aiStats('gemini'), researchStats(), whatsappStats(),
  ]);
```

Change to:
```js
  const [eStats, lStats, rStats, pStats, oaiStats, gemStats, rsStats, waStats, acStats] = await Promise.all([
    emailStats(), limitlessStats(), relationshipsStats(), projectsStats(),
    aiStats('openai'), aiStats('gemini'), researchStats(), whatsappStats(), appleContactsStats(),
  ]);
```

In the stats assignment block, find:
```js
                 : id === 'whatsapp'      ? waStats
                 : null,
```

Change to:
```js
                 : id === 'whatsapp'       ? waStats
                 : id === 'apple-contacts' ? acStats
                 : null,
```

Also add `'apple-contacts'` to the `logs` init (find `Object.keys(AGENTS).forEach(id => { logs[id] = []; });` — this will work automatically since we added apple-contacts to AGENTS).

- [ ] **Step 5: Add the import endpoint**

After the existing `GET /api/agents/:id/qr` endpoint or near the other agent-specific endpoints, add:

```js
// POST /api/agents/apple-contacts/import  — accepts raw .vcf text or multipart
app.post('/api/agents/apple-contacts/import', express.text({ type: ['text/vcard', 'text/x-vcard', 'text/plain'], limit: '10mb' }), async (req, res) => {
  try {
    let vcfText = req.body;
    if (!vcfText || typeof vcfText !== 'string') {
      return res.status(400).json({ error: 'Request body must be a .vcf text file' });
    }
    const { parseVcf } = require('../agents/apple-contacts/services/vcfParser');
    const { syncContacts } = require('../agents/apple-contacts/services/syncer');
    const contacts = parseVcf(vcfText);
    if (!contacts.length) {
      return res.status(400).json({ error: 'No valid vCard records found in the uploaded file' });
    }
    const result = await syncContacts(contacts);
    res.json(result);
  } catch (err) {
    console.error('[apple-contacts import]', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

Also add `nativeAvailable` field passthrough in the `GET /api/agents` response. Find where `result[id]` is built:
```js
    result[id] = {
      id,
      name:        def.name,
      description: def.description,
      status,
      ...
    };
```

Add `nativeAvailable: def.nativeAvailable ?? null,` to the object.

- [ ] **Step 6: Restart the server and verify the new agent appears**

```bash
curl -s http://localhost:4001/api/agents | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const a=JSON.parse(d); console.log('apple-contacts:', JSON.stringify(a['apple-contacts'], null, 2))"
```
Expected: apple-contacts agent entry with `nativeAvailable: true` (on macOS) and `stats` with `total_synced`, `no_comms`, `last_sync_at`.

- [ ] **Step 7: Test the import endpoint with a small VCF**

```bash
curl -s -X POST http://localhost:4001/api/agents/apple-contacts/import \
  -H "Content-Type: text/vcard" \
  --data-binary 'BEGIN:VCARD
VERSION:3.0
FN:Import Test
EMAIL:importtest_deleteme@example.com
END:VCARD'
```
Expected: `{"total":1,"matched":0,"created":1,"skipped":0}`

Clean up:
```bash
psql "$DATABASE_URL" -c "DELETE FROM relationships.contacts WHERE apple_contact_id LIKE 'vcf:%' AND display_name = 'Import Test'"
```

- [ ] **Step 8: Commit**

```bash
git add packages/ui/server.js
git commit -m "feat: wire apple-contacts agent into server — stats, import endpoint, schema registration"
```

---

### Task 8: Agents UI — Sync Now + Upload VCF

**Files:**
- Modify: `packages/ui/app/agents/page.jsx`

- [ ] **Step 1: Add AppleContactsStats to AgentStats component**

In `packages/ui/app/agents/page.jsx`, find the `AgentStats` component. After the `whatsapp` block and before the `return null`, add:

```jsx
  if (id === 'apple-contacts') {
    return (
      <div className="agent-stats">
        <div className="stat"><span className="stat-val">{formatNum(stats?.total_synced)}</span><span className="stat-label">Synced</span></div>
        <div className="stat"><span className="stat-val">{formatNum(stats?.no_comms)}</span><span className="stat-label">No comms</span></div>
        <div className="stat"><span className="stat-val dim">{relativeTime(stats?.last_sync_at)}</span><span className="stat-label">Last sync</span></div>
      </div>
    )
  }
```

- [ ] **Step 2: Add the AppleContactsControls component**

Before the main `export default function AgentsPage()` add:

```jsx
function AppleContactsControls({ agent, onSync, onUpload, syncing, importing }) {
  const fileRef = useRef(null)
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {agent.nativeAvailable && (
        <button className="btn btn-primary" disabled={syncing} onClick={onSync}>
          {syncing ? 'Syncing…' : '⟳ Sync Now'}
        </button>
      )}
      <>
        <input
          type="file" accept=".vcf"
          style={{ display: 'none' }}
          ref={fileRef}
          onChange={e => { onUpload(e.target.files[0]); e.target.value = '' }}
        />
        <button className="btn btn-secondary" disabled={importing} onClick={() => fileRef.current?.click()}>
          {importing ? 'Uploading…' : '↑ Upload VCF'}
        </button>
      </>
    </div>
  )
}
```

- [ ] **Step 3: Add state and handlers in the main AgentsPage component**

Inside the main `AgentsPage` component, find the `importing` state (used by openai/gemini), then add alongside it:

```jsx
  const [acSyncing,   setAcSyncing]   = useState(false)
  const [acImporting, setAcImporting] = useState(false)

  async function handleAppleSync() {
    setAcSyncing(true)
    try {
      await apiFetch('POST', '/api/agents/apple-contacts/start')
      showToast('Apple Contacts sync started')
    } catch (err) {
      showToast(err.message || 'Sync failed')
    }
    setAcSyncing(false)
  }

  async function handleAppleVcfUpload(file) {
    if (!file) return
    setAcImporting(true)
    try {
      const text = await file.text()
      const result = await fetch('/api/agents/apple-contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/vcard' },
        body: text,
      }).then(r => r.json())
      if (result.error) throw new Error(result.error)
      showToast(`Synced ${result.total} contacts: ${result.matched} enriched, ${result.created} new`)
    } catch (err) {
      showToast(err.message || 'Upload failed')
    }
    setAcImporting(false)
  }
```

- [ ] **Step 4: Render AppleContactsControls in the agent card**

Find the block that renders the OpenAI/Gemini import button. It looks like:
```jsx
                    ) : (id === 'openai' || id === 'gemini') ? (
                      <>
                        <input ...>
                        <button ...>↑ Import JSON</button>
                      </>
                    ) : (
```

Add the apple-contacts case before the `openai`/`gemini` case (or alongside):
```jsx
                    ) : id === 'apple-contacts' ? (
                      <AppleContactsControls
                        agent={agent}
                        onSync={handleAppleSync}
                        onUpload={handleAppleVcfUpload}
                        syncing={acSyncing}
                        importing={acImporting}
                      />
                    ) : (id === 'openai' || id === 'gemini') ? (
```

- [ ] **Step 5: Verify the UI renders the apple-contacts card**

With the dev server running (`npm run ui:dev`), open `http://localhost:4000/agents` and confirm:
- Apple Contacts card appears
- "⟳ Sync Now" visible on macOS, hidden on Linux
- "↑ Upload VCF" always visible
- Stats show `Synced / No comms / Last sync`

- [ ] **Step 6: Test VCF upload via the UI**

Create a minimal VCF file:
```bash
cat > /tmp/test-upload.vcf << 'EOF'
BEGIN:VCARD
VERSION:3.0
FN:UI Upload Test
EMAIL:uiuploadtest_deleteme@example.com
END:VCARD
EOF
```

Click "↑ Upload VCF" in the UI, select `/tmp/test-upload.vcf`.
Expected toast: `Synced 1 contacts: 0 enriched, 1 new`

Clean up:
```bash
psql "$DATABASE_URL" -c "DELETE FROM relationships.contacts WHERE display_name = 'UI Upload Test'"
```

- [ ] **Step 7: Commit**

```bash
git add packages/ui/app/agents/page.jsx
git commit -m "feat: add Apple Contacts agent card with Sync Now and Upload VCF controls"
```

---

### Task 9: Relationships page — avatar photos

**Files:**
- Modify: `packages/ui/app/relationships/page.jsx`
- Modify: `packages/ui/server.js` (add `avatar_data` to contact SELECT)

- [ ] **Step 1: Add avatar_data to the contacts API response**

In `packages/ui/server.js`, find `GET /api/relationships/contacts`:
```js
    const { rows } = await db.query(`
      SELECT id, display_name, company, job_title, relationship_type,
             relationship_strength, summary, tags, last_interaction_at, first_interaction_at
      FROM relationships.contacts
      ${where}
      ORDER BY last_interaction_at DESC NULLS LAST
      LIMIT 200
    `, params);
```

Add `avatar_data` to the SELECT:
```js
    const { rows } = await db.query(`
      SELECT id, display_name, company, job_title, relationship_type,
             relationship_strength, summary, tags, last_interaction_at, first_interaction_at,
             avatar_data
      FROM relationships.contacts
      ${where}
      ORDER BY last_interaction_at DESC NULLS LAST
      LIMIT 200
    `, params);
```

- [ ] **Step 2: Update avatar rendering in relationships/page.jsx**

In `packages/ui/app/relationships/page.jsx`, find the existing `isJpegB64` function:
```js
function isJpegB64(s) {
  return typeof s === 'string' && s.startsWith('/9j/') && s.length > 200
}
```

This is already defined. Now find where contact avatars are rendered. Search for `avatarInitial` or `avatarColor` usage in the JSX. It will look something like:
```jsx
<div className="contact-avatar" style={{ background: avatarColor(c.display_name) }}>
  {avatarInitial(c.display_name)}
</div>
```

Replace with:
```jsx
{c.avatar_data && isJpegB64(c.avatar_data) ? (
  <img
    src={`data:image/jpeg;base64,${c.avatar_data}`}
    alt={c.display_name}
    className="contact-avatar"
    style={{ objectFit: 'cover', borderRadius: '50%' }}
  />
) : (
  <div className="contact-avatar" style={{ background: avatarColor(c.display_name) }}>
    {avatarInitial(c.display_name)}
  </div>
)}
```

Note: `isJpegB64` checks for `/9j/` prefix which is the JPEG magic in base64. PNG starts with `iVBOR`. Update `isJpegB64` to handle both:
```js
function isJpegB64(s) {
  return typeof s === 'string' && (s.startsWith('/9j/') || s.startsWith('iVBOR')) && s.length > 200
}
```

- [ ] **Step 3: Verify avatar rendering**

If you have any Apple Contacts synced with photos, open `http://localhost:4000/relationships` and confirm photos render.

Without real data, verify the fallback still works (initials + color circle) for contacts without `avatar_data`.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/app/relationships/page.jsx packages/ui/server.js
git commit -m "feat: render Apple Contacts avatar photos in relationships page"
```

---

### Task 10: Root package.json run script

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Read current scripts in root package.json**

```bash
node -e "const p = require('./package.json'); console.log(JSON.stringify(p.scripts, null, 2))"
```

- [ ] **Step 2: Add apple-contacts script**

Open `package.json` and in the `scripts` block, add alongside `email`, `limitless`, etc.:
```json
"apple-contacts": "node packages/agents/apple-contacts/index.js"
```

- [ ] **Step 3: Verify the script runs**

```bash
npm run apple-contacts
```

On Linux: should print "Native Apple Contacts sync not available on this platform." and exit 0.
On macOS: should attempt to run native sync (may prompt for Contacts permission).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add apple-contacts npm run script"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task covering it |
|---|---|
| `apple_contact_id` + `avatar_data` columns | Task 1 |
| `vcfParser.js` cross-platform | Task 3 |
| `nativeReader.js` macOS only | Task 4 |
| `syncer.js` phone→email→name matching | Task 5 |
| `index.js` entry point (macOS daily / Linux exit) | Task 6 |
| Schema registered in `runSystemSchema()` | Task 7 Step 1 |
| AGENTS entry with `nativeAvailable` | Task 7 Step 2 |
| `appleContactsStats()` | Task 7 Step 3 |
| Stats wired into `GET /api/agents` | Task 7 Step 4 |
| `POST /api/agents/apple-contacts/import` | Task 7 Step 5 |
| `nativeAvailable` in API response | Task 7 Step 5 |
| Sync Now button (macOS only) | Task 8 |
| Upload VCF button (all platforms) | Task 8 |
| Toast with result counters | Task 8 Step 3 |
| avatar_data in contacts API | Task 9 Step 1 |
| Avatar photo rendering in relationships page | Task 9 Step 2 |
| `manual_overrides` respected for company/job_title | Task 5 Step 1 |
| New contacts created with `relationship_type: 'unknown'` | Task 5 Step 1 |
| `npm run apple-contacts` | Task 10 |

### Gaps checked — none found.

### Type consistency — `NormalizedContact` shape used consistently across Tasks 3, 4, 5, 6.
