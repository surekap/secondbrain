#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') });
} catch (_) {
  // dotenv is optional for syntax/help/missing-env paths; npm install provides it in normal use.
}

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const getArg = name => {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
};

const HELP = `SecondBrain read-only audit / smoke checks

Usage:
  node scripts/audit-secondbrain-quality.js [options]

Default mode is read-only. It connects to DATABASE_URL and prints source freshness,
derived freshness, quality indicators, smoke-gate status, research provider preflight,
and schema drift. It never calls external research providers.

Options:
  --help                         Show this help and exit.
  --json                         Emit JSON instead of human-readable text.
  --strict                       Exit non-zero when WARN/FAIL findings are present.
  --api-url=<url>                Override SECOND_BRAIN_API_URL/API_URL for optional GET smoke.
  --patch-my-role                Opt-in mutation smoke for my_role PATCH (requires --contact-id and API URL).
  --contact-id=<id>              Safe test relationships.contacts id for --patch-my-role.
  --my-role-value=<value>        Value used by --patch-my-role (default: audit_test_role).

Environment:
  DATABASE_URL                   Required except for --help.
  SECOND_BRAIN_API_URL/API_URL   Optional base URL for GET stats endpoint smoke checks.
  WHATSAPP_SELF_JID              Checked as a loud smoke signal only; no runtime mutation.
`;

if (args.has('--help') || args.has('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to run SecondBrain audit checks. Set DATABASE_URL or create .env.local.');
  process.exit(1);
}

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  console.error(`Unable to load pg dependency: ${e.message}`);
  process.exit(1);
}

const JSON_MODE = args.has('--json');
const STRICT = args.has('--strict');
const API_URL = stripTrailingSlash(getArg('--api-url') || process.env.SECOND_BRAIN_API_URL || process.env.API_URL || '');
const PATCH_MY_ROLE = args.has('--patch-my-role');
const CONTACT_ID = getArg('--contact-id');
const MY_ROLE_VALUE = getArg('--my-role-value') || 'audit_test_role';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const report = {
  generated_at: new Date().toISOString(),
  source_freshness: {},
  derived_freshness: {},
  quality_indicators: {},
  smoke_gates: {},
  research_provider_preflight: {},
  schema_drift: {},
  findings: [],
};

function stripTrailingSlash(s) { return s ? s.replace(/\/+$/, '') : ''; }
function status(level, message, details = undefined) { report.findings.push({ level, message, details }); }
function redact(v) { return v ? '[configured]' : '[missing]'; }
function countVal(row, key) { return Number(row?.[key] || 0); }
function sanitizeUrlForLog(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search ? '?[redacted-query]' : ''}`;
  } catch (_) {
    return '[invalid-url]';
  }
}

async function tableExists(name) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS regclass', [name]);
  return Boolean(rows[0]?.regclass);
}

async function safeQuery(label, table, sql, params = []) {
  if (!(await tableExists(table))) {
    status('WARN', `${label} skipped: ${table} does not exist`);
    return null;
  }
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (e) {
    status('FAIL', `${label} query failed`, e.message);
    return null;
  }
}

async function scalarFreshness(label, table, dateColumn) {
  const rows = await safeQuery(label, table, `SELECT COUNT(*)::bigint AS count, MAX(${dateColumn}) AS max_value FROM ${table}`);
  return rows ? { count: countVal(rows[0], 'count'), [`max_${dateColumn}`]: rows[0].max_value } : { skipped: true };
}

async function runSourceFreshness() {
  report.source_freshness['email.emails'] = await scalarFreshness('email freshness', 'email.emails', 'date');
  report.source_freshness['public.messages'] = await scalarFreshness('WhatsApp freshness', 'public.messages', 'ts');
  report.source_freshness['limitless.lifelogs'] = await scalarFreshness('Limitless freshness', 'limitless.lifelogs', 'start_time');
}

async function runDerivedFreshness() {
  report.derived_freshness['relationships.contacts'] = await scalarFreshness('contacts freshness', 'relationships.contacts', 'last_interaction_at');
  const insightRows = await safeQuery('open relationships insights', 'relationships.insights', `
    SELECT COUNT(*)::bigint AS open_insights
    FROM relationships.insights
    WHERE NOT is_actioned AND NOT is_dismissed
  `);
  report.derived_freshness['relationships.insights_open'] = insightRows ? countVal(insightRows[0], 'open_insights') : { skipped: true };
  report.derived_freshness['projects.projects'] = await scalarFreshness('projects freshness', 'projects.projects', 'last_activity_at');
}

async function runQualityIndicators() {
  const dupRows = await safeQuery('duplicate normalized names', 'relationships.contacts', `
    SELECT normalized_name, COUNT(*)::bigint AS count, ARRAY_AGG(id ORDER BY id) AS contact_ids
    FROM relationships.contacts
    WHERE normalized_name IS NOT NULL AND normalized_name <> '' AND NOT is_noise
    GROUP BY normalized_name
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC, normalized_name
    LIMIT 25
  `);
  report.quality_indicators.duplicate_normalized_names = dupRows || { skipped: true };

  const phoneRows = await safeQuery('phone-number-only contact names', 'relationships.contacts', `
    SELECT COUNT(*)::bigint AS count,
           ARRAY_AGG(id ORDER BY last_interaction_at DESC NULLS LAST) FILTER (WHERE sample_rank <= 20) AS sample_contact_ids
    FROM (
      SELECT id, last_interaction_at,
             ROW_NUMBER() OVER (ORDER BY last_interaction_at DESC NULLS LAST) AS sample_rank
      FROM relationships.contacts
      WHERE NOT is_noise
        AND regexp_replace(display_name, '[^0-9+]', '', 'g') = display_name
        AND display_name ~ '^[+0-9][0-9 +().-]{5,}$'
    ) s
  `);
  report.quality_indicators.contacts_with_only_phone_number_names = phoneRows ? phoneRows[0] : { skipped: true };

  const missingProfileRows = await safeQuery('strong/moderate contacts missing company/job title', 'relationships.contacts', `
    SELECT COUNT(*)::bigint AS count,
           ARRAY_AGG(id ORDER BY last_interaction_at DESC NULLS LAST) FILTER (WHERE sample_rank <= 25) AS sample_contact_ids
    FROM (
      SELECT id, last_interaction_at,
             ROW_NUMBER() OVER (ORDER BY last_interaction_at DESC NULLS LAST) AS sample_rank
      FROM relationships.contacts
      WHERE NOT is_noise
        AND relationship_strength IN ('strong', 'moderate')
        AND (NULLIF(TRIM(COALESCE(company, '')), '') IS NULL OR NULLIF(TRIM(COALESCE(job_title, '')), '') IS NULL)
    ) s
  `);
  report.quality_indicators.strong_or_moderate_contacts_missing_company_or_job_title = missingProfileRows ? missingProfileRows[0] : { skipped: true };

  const oldInsightRows = await safeQuery('open insights age buckets', 'relationships.insights', `
    SELECT
      COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '30 days')::bigint AS older_than_30_days,
      COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '60 days')::bigint AS older_than_60_days,
      COUNT(*) FILTER (WHERE created_at < NOW() - INTERVAL '90 days')::bigint AS older_than_90_days
    FROM relationships.insights
    WHERE NOT is_actioned AND NOT is_dismissed
  `);
  report.quality_indicators.open_insights_older_than_30_60_90_days = oldInsightRows ? oldInsightRows[0] : { skipped: true };

  const nullContactRows = await safeQuery('project communications null contact_id', 'projects.project_communications', `
    SELECT COUNT(*)::bigint AS count,
           ARRAY_AGG(id ORDER BY occurred_at DESC NULLS LAST) FILTER (WHERE sample_rank <= 25) AS sample_project_communication_ids
    FROM (
      SELECT id, occurred_at, ROW_NUMBER() OVER (ORDER BY occurred_at DESC NULLS LAST) AS sample_rank
      FROM projects.project_communications
      WHERE contact_id IS NULL
    ) s
  `);
  report.quality_indicators.project_communications_with_null_contact_id = nullContactRows ? nullContactRows[0] : { skipped: true };
}

async function runStatsSmoke() {
  const expected = {
    relationships: ['total_contacts', 'pending_insights', 'strong_contacts', 'last_analysis_at'],
    projects: ['total_projects', 'active_projects', 'stalled_projects'],
  };

  // DB-side equivalents of the API stats payloads, so the check does not require a running server.
  const relRows = await safeQuery('relationships stats DB smoke', 'relationships.contacts', `
    SELECT COUNT(*) FILTER (WHERE NOT is_noise) AS total_contacts,
           COUNT(*) FILTER (WHERE relationship_strength = 'strong' AND NOT is_noise) AS strong_contacts,
           COUNT(*) FILTER (WHERE relationship_strength = 'moderate' AND NOT is_noise) AS moderate_contacts
    FROM relationships.contacts
  `);
  const relInsightRows = await safeQuery('relationships insights stats DB smoke', 'relationships.insights', `
    SELECT COUNT(*) AS total_insights,
           COUNT(*) FILTER (WHERE NOT is_actioned AND NOT is_dismissed) AS pending_insights
    FROM relationships.insights
  `);
  report.smoke_gates.relationships_stats_fields_db = relRows && relInsightRows
    ? checkFields({ ...relRows[0], ...relInsightRows[0], last_analysis_at: null }, expected.relationships)
    : { skipped: true };

  const projectRows = await safeQuery('projects stats DB smoke', 'projects.projects', `
    SELECT COUNT(*) AS total_projects,
           COUNT(*) FILTER (WHERE status = 'active') AS active_projects,
           COUNT(*) FILTER (WHERE status = 'stalled') AS stalled_projects
    FROM projects.projects
    WHERE is_archived = FALSE
  `);
  report.smoke_gates.projects_stats_fields_db = projectRows ? checkFields(projectRows[0], expected.projects) : { skipped: true };

  if (API_URL) {
    report.smoke_gates.relationships_stats_api = await getAndCheck(`${API_URL}/api/relationships/stats`, expected.relationships);
    report.smoke_gates.projects_stats_api = await getAndCheck(`${API_URL}/api/projects/stats`, expected.projects);
  } else {
    report.smoke_gates.api_stats_get = { skipped: true, reason: 'SECOND_BRAIN_API_URL/API_URL not set' };
  }
}

function checkFields(obj, expected) {
  const missing = expected.filter(k => !(k in obj));
  if (missing.length) status('FAIL', `stats payload missing UI-read field(s): ${missing.join(', ')}`);
  return { ok: missing.length === 0, expected, missing };
}

async function getAndCheck(url, expected) {
  const safeUrl = sanitizeUrlForLog(url);
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      status('FAIL', `GET ${safeUrl} returned HTTP ${res.status}`);
      return { ok: false, http_status: res.status, url: safeUrl };
    }
    const body = await res.json();
    return { http_status: res.status, ...checkFields(body, expected) };
  } catch (e) {
    status('FAIL', `GET ${safeUrl} failed`, e.message);
    return { ok: false, error: e.message, url: safeUrl };
  }
}

async function runMyRolePatchSmoke() {
  if (!PATCH_MY_ROLE) {
    report.smoke_gates.my_role_patch = { skipped: true, reason: 'read-only default; pass --patch-my-role --contact-id=<safe-test-id> and API URL to run' };
    return;
  }
  if (!API_URL || !CONTACT_ID) {
    status('FAIL', '--patch-my-role requires --contact-id and SECOND_BRAIN_API_URL/API_URL or --api-url');
    report.smoke_gates.my_role_patch = { ok: false, error: 'missing api url or contact id' };
    return;
  }
  const url = `${API_URL}/api/relationships/contacts/${encodeURIComponent(CONTACT_ID)}`;
  try {
    const patchRes = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ my_role: MY_ROLE_VALUE }),
    });
    const patchBody = await patchRes.json().catch(() => ({}));
    if (!patchRes.ok) {
      status('FAIL', `my_role PATCH returned HTTP ${patchRes.status}`);
      report.smoke_gates.my_role_patch = { ok: false, http_status: patchRes.status, body: patchBody };
      return;
    }
    const ok = patchBody.my_role === MY_ROLE_VALUE && patchBody.manual_overrides?.my_role?.value === MY_ROLE_VALUE;
    if (!ok) status('FAIL', 'my_role PATCH did not persist or manual_overrides.my_role was not returned');
    report.smoke_gates.my_role_patch = { ok, http_status: patchRes.status, contact_id: CONTACT_ID };
  } catch (e) {
    status('FAIL', 'my_role PATCH smoke failed', e.message);
    report.smoke_gates.my_role_patch = { ok: false, error: e.message };
  }
}

async function runWhatsAppSelfJidCheck() {
  const envSet = Boolean(process.env.WHATSAPP_SELF_JID);
  let dbSet = false;
  if (await tableExists('system.config')) {
    try {
      const { rows } = await pool.query(`SELECT value FROM system.config WHERE key IN ('system.WHATSAPP_SELF_JID', 'WHATSAPP_SELF_JID') LIMIT 1`);
      dbSet = rows.some(r => Boolean(r.value));
    } catch (_) {}
  }
  const sourceFiles = await staticSearch('WHATSAPP_SELF_JID');
  const ok = envSet || dbSet;
  if (!ok) status('WARN', 'WHATSAPP_SELF_JID is not configured; self-message identification may fail. This audit flags it loudly but does not mutate runtime config.');
  report.smoke_gates.whatsapp_self_jid = {
    ok,
    env: redact(envSet),
    db_config: redact(dbSet),
    code_references: sourceFiles,
  };
}

async function runResearchProviderPreflight() {
  const providers = [
    ['tavily', 'TAVILY_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['peopledatalabs', 'PEOPLEDATALABS_API_KEY'],
    ['serpapi', 'SERPAPI_API_KEY'],
  ];
  const entries = [];
  const hasSystemConfig = await tableExists('system.config');
  for (const [name, key] of providers) {
    let configured = Boolean(process.env[key]);
    if (!configured && hasSystemConfig) {
      try {
        // shared getConfig('system.KEY') stores/reads key='KEY' inside system.config.
        // Also accept a legacy fully-qualified key if one was inserted manually.
        const { rows } = await pool.query(
          `SELECT value FROM system.config WHERE key = ANY($1::text[]) LIMIT 1`,
          [[key, `system.${key}`]]
        );
        configured = Boolean(rows[0]?.value);
      } catch (e) {
        status('WARN', `research provider config lookup failed for ${name}`, e.message);
      }
    }
    entries.push({ provider: name, config_key: key, status: configured ? 'active' : 'skipped_unconfigured' });
  }
  report.research_provider_preflight.providers = entries;
  report.research_provider_preflight.note = 'Configuration presence only; no external provider APIs were called.';
}

async function runSchemaDrift() {
  const expected = {
    'email.emails': ['id','account_id','message_id','gmail_uid','thread_id','subject','from_address','to_addresses','cc_addresses','bcc_addresses','reply_to','date','received_at','body_text','body_html','raw_headers','attachments','labels','is_read','created_at'],
    'public.messages': ['id','client_id','event','data','chat_id','group_id','msg_type','ts','wa_msg_id'],
    'limitless.lifelogs': ['id','title','start_time','end_time','contents','markdown','processed','processing_error','processing_attempts','last_attempt_at','created_at','updated_at'],
    'relationships.contacts': ['id','display_name','normalized_name','emails','phone_numbers','wa_jids','company','job_title','summary','relationship_type','relationship_strength','tags','last_interaction_at','first_interaction_at','is_noise','raw_data','created_at','updated_at','manual_overrides','my_role','research_summary'],
    'relationships.insights': ['id','contact_id','insight_type','title','description','source_refs','priority','is_actioned','is_dismissed','created_at','updated_at','contact_ids','source_ref'],
    'relationships.communications': ['id','contact_id','source','source_id','direction','content_snippet','subject','chat_id','is_group','group_name','is_read','is_replied','occurred_at','metadata','created_at'],
    'relationships.contact_research': ['id','contact_id','source','query','result_json','summary','researched_name','researched_at'],
    'projects.projects': ['id','name','description','status','health','priority','tags','next_action','last_activity_at','comm_count','key_contact_ids','is_archived','ai_summary','created_at','updated_at','manual_overrides'],
    'projects.project_communications': ['id','project_id','source','source_id','contact_id','content_snippet','subject','occurred_at','relevance_score','created_at'],
    'projects.project_insights': ['id','project_id','insight_type','content','priority','is_resolved','created_at','updated_at'],
  };

  for (const [table, cols] of Object.entries(expected)) {
    if (!(await tableExists(table))) {
      report.schema_drift[table] = { skipped: true, reason: 'table missing' };
      status('WARN', `schema drift skipped: ${table} missing`);
      continue;
    }
    const [schema, name] = table.split('.');
    const { rows } = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, name]);
    const live = rows.map(r => r.column_name);
    const missing = cols.filter(c => !live.includes(c));
    const extra = live.filter(c => !cols.includes(c));
    if (missing.length || extra.length) status('WARN', `schema drift in ${table}`, { missing, extra });
    report.schema_drift[table] = { ok: missing.length === 0 && extra.length === 0, missing, extra };
  }
}

async function staticSearch(needle) {
  const roots = ['packages', 'scripts', 'docs'];
  const hits = [];
  for (const root of roots) walk(path.join(ROOT, root), file => {
    if (!/\.(js|jsx|ts|tsx|md|sql|json|env|example)$/.test(file)) return;
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (txt.includes(needle)) hits.push(path.relative(ROOT, file));
    } catch (_) {}
  });
  return hits;
}

function walk(dir, cb) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.hermes') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

function printHuman() {
  console.log('SecondBrain audit / smoke report');
  console.log(`Generated: ${report.generated_at}`);
  section('Source freshness', report.source_freshness);
  section('Derived freshness', report.derived_freshness);
  section('Quality indicators', report.quality_indicators);
  section('Smoke gates', report.smoke_gates);
  section('Research provider preflight', report.research_provider_preflight);
  section('Schema drift', report.schema_drift);
  console.log('\nFindings');
  if (!report.findings.length) console.log('  OK: no WARN/FAIL findings');
  for (const f of report.findings) console.log(`  ${f.level}: ${f.message}${f.details ? ` (${JSON.stringify(f.details)})` : ''}`);
}

function section(title, obj) {
  console.log(`\n${title}`);
  for (const [k, v] of Object.entries(obj)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}

async function main() {
  await runSourceFreshness();
  await runDerivedFreshness();
  await runQualityIndicators();
  await runStatsSmoke();
  await runMyRolePatchSmoke();
  await runWhatsAppSelfJidCheck();
  await runResearchProviderPreflight();
  await runSchemaDrift();

  if (JSON_MODE) console.log(JSON.stringify(report, null, 2));
  else printHuman();

  const hasFail = report.findings.some(f => f.level === 'FAIL');
  const hasWarn = report.findings.some(f => f.level === 'WARN');
  process.exitCode = hasFail ? 2 : (STRICT && hasWarn ? 2 : 0);
}

main().catch(e => {
  console.error(`Audit failed: ${e.stack || e.message}`);
  process.exitCode = 2;
}).finally(async () => {
  await pool.end().catch(() => {});
});
