#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalWhatsAppChatIdSql } = require('../packages/agents/shared/whatsapp-chat');

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
  report.derived_freshness['intelligence.opportunities'] = await scalarFreshness('opportunities freshness', 'intelligence.opportunities', 'last_seen_at');
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

async function runCanonicalQualityGates() {
  if (!(await tableExists('relationships.communications'))) {
    report.quality_indicators.canonical_quality_gates = { skipped: true };
    return;
  }

  const { rows: canonicalRows } = await pool.query(`
    WITH duplicate_keys AS (
      SELECT source, source_id, COUNT(*)::bigint AS copies
      FROM relationships.communications
      GROUP BY source, source_id
      HAVING COUNT(*) > 1
    )
    SELECT
      COUNT(*)::bigint AS canonical_events,
      COUNT(*) FILTER (WHERE contact_id IS NOT NULL)::bigint AS linked_events,
      COUNT(*) FILTER (WHERE contact_id IS NULL)::bigint AS unresolved_events,
      COALESCE((SELECT SUM(copies - 1) FROM duplicate_keys), 0)::bigint AS duplicate_events,
      MAX(occurred_at) AS latest_canonical_at
    FROM relationships.communications
  `);
  const canonical = canonicalRows[0];
  const canonicalCount = countVal(canonical, 'canonical_events');
  const duplicateCount = countVal(canonical, 'duplicate_events');
  const duplicateRate = canonicalCount ? duplicateCount / canonicalCount : 0;
  report.quality_indicators.canonical_communications = {
    ...canonical,
    duplicate_rate: Number(duplicateRate.toFixed(6)),
  };
  if (duplicateRate >= 0.001) {
    status('FAIL', 'canonical communication duplicate rate is above the 0.1% gate', { duplicate_count: duplicateCount, duplicate_rate: duplicateRate });
  }

  const rawBySource = {};
  if (await tableExists('email.emails')) {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::bigint AS count, MAX(COALESCE(date, received_at, created_at)) AS latest_at
      FROM email.emails
      WHERE id IS NOT NULL AND COALESCE(date, received_at, created_at) IS NOT NULL
    `);
    rawBySource.email = rows[0];
  }
  if (await tableExists('public.messages')) {
    const selfJid = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID || '';
    const chatSql = canonicalWhatsAppChatIdSql({
      dataExpression: 'm.data',
      storedChatExpression: 'm.chat_id',
      selfExpression: '$1',
    });
    const { rows } = await pool.query(`
      SELECT COUNT(DISTINCT COALESCE(NULLIF(m.wa_msg_id, ''), NULLIF(m.data->'id'->>'_serialized', '')))::bigint AS native_count,
             COUNT(*) FILTER (WHERE COALESCE(NULLIF(m.wa_msg_id, ''), NULLIF(m.data->'id'->>'_serialized', '')) IS NULL)::bigint AS fallback_rows,
             MAX(m.ts) AS latest_at
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
      WHERE m.event IN ('message','message_create','message_historical')
        AND chat.chat_id IS NOT NULL
    `, [selfJid]);
    rawBySource.whatsapp = rows[0];
  }
  if (await tableExists('limitless.lifelogs')) {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::bigint AS count, MAX(COALESCE(start_time, created_at)) AS latest_at
      FROM limitless.lifelogs
      WHERE id IS NOT NULL
        AND COALESCE(NULLIF(markdown, ''), NULLIF(contents, ''), NULLIF(title, '')) IS NOT NULL
        AND COALESCE(start_time, created_at) IS NOT NULL
    `);
    rawBySource.limitless = rows[0];
  }
  const { rows: canonicalBySource } = await pool.query(`
    SELECT source, COUNT(*)::bigint AS count, MAX(occurred_at) AS latest_at
    FROM relationships.communications
    GROUP BY source
  `);
  const canonicalMap = Object.fromEntries(canonicalBySource.map(row => [row.source, row]));
  const coverage = {};
  for (const [source, raw] of Object.entries(rawBySource)) {
    const rawCount = source === 'whatsapp'
      ? countVal(raw, 'native_count') + countVal(raw, 'fallback_rows')
      : countVal(raw, 'count');
    const normalized = countVal(canonicalMap[source], 'count');
    let missingCount = Math.max(rawCount - normalized, 0);
    const detail = {};
    if (source === 'whatsapp') {
      const { rows: whatsappCanonical } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE source_id LIKE 'wa:%' AND source_id NOT LIKE 'wa:fallback:%')::bigint AS native_count,
          COUNT(*) FILTER (WHERE source_id LIKE 'wa:fallback:%')::bigint AS fallback_count
        FROM relationships.communications
        WHERE source = 'whatsapp'
      `);
      const canonicalNative = countVal(whatsappCanonical[0], 'native_count');
      missingCount = Math.max(countVal(raw, 'native_count') - canonicalNative, 0);
      Object.assign(detail, {
        raw_native_count: countVal(raw, 'native_count'),
        raw_fallback_rows: countVal(raw, 'fallback_rows'),
        canonical_native_count: canonicalNative,
        canonical_fallback_count: countVal(whatsappCanonical[0], 'fallback_count'),
        note: 'Fallback rows use deterministic content fingerprints; raw row count is not an event-parity denominator.',
      });
    }
    coverage[source] = {
      raw_count: rawCount,
      canonical_count: normalized,
      missing_count: missingCount,
      raw_latest_at: raw.latest_at,
      canonical_latest_at: canonicalMap[source]?.latest_at || null,
      ...detail,
    };
    if (coverage[source].missing_count > 0) {
      status('WARN', `${source} raw-to-canonical recovery is incomplete`, coverage[source]);
    }
  }
  report.quality_indicators.raw_to_canonical_coverage = coverage;

  if (await tableExists('public.media_files')) {
    const selfJid = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID || '';
    const chatSql = canonicalWhatsAppChatIdSql({
      dataExpression: 'm.data',
      storedChatExpression: 'm.chat_id',
      selfExpression: '$1',
    });
    const { rows } = await pool.query(`
      WITH eligible_media AS (
        SELECT DISTINCT ON (mf.id) mf.*
        FROM public.media_files mf
        JOIN public.messages m
          ON COALESCE(NULLIF(m.wa_msg_id, ''), NULLIF(m.data->'id'->>'_serialized', '')) = mf.wa_msg_id
        CROSS JOIN LATERAL (SELECT ${chatSql} AS chat_id) chat
        WHERE m.event IN ('message','message_create','message_historical')
          AND chat.chat_id IS NOT NULL
        ORDER BY mf.id, m.id DESC
      )
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(mf.semantic_text, ''), NULLIF(mf.extracted_text, '')) IS NOT NULL)::bigint AS analyzed,
        COUNT(*) FILTER (
          WHERE COALESCE(NULLIF(mf.semantic_text, ''), NULLIF(mf.extracted_text, '')) IS NOT NULL
            AND communication.id IS NULL
        )::bigint AS analyzed_without_canonical_event,
        COUNT(*) FILTER (
          WHERE COALESCE(NULLIF(mf.semantic_text, ''), NULLIF(mf.extracted_text, '')) IS NOT NULL
            AND communication.id IS NOT NULL
            AND NULLIF(communication.metadata->>'media_semantic_text', '') IS NULL
        )::bigint AS canonical_event_missing_semantics
      FROM eligible_media mf
      LEFT JOIN relationships.communications communication
        ON communication.source = 'whatsapp'
       AND communication.source_id = 'wa:' || mf.wa_msg_id
    `, [selfJid]);
    report.quality_indicators.media_semantic_coverage = rows[0];
    if (countVal(rows[0], 'analyzed_without_canonical_event') || countVal(rows[0], 'canonical_event_missing_semantics')) {
      status('WARN', 'analyzed media has not fully converged into canonical communications', rows[0]);
    }
  }

  if (await tableExists('intelligence.opportunities') && await tableExists('intelligence.opportunity_evidence')) {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE opportunity.status = 'open')::bigint AS open_items,
        COUNT(*) FILTER (WHERE opportunity.status = 'open' AND evidence.opportunity_id IS NULL)::bigint AS open_without_evidence,
        COUNT(*) FILTER (
          WHERE opportunity.status = 'open'
            AND opportunity.primary_contact_id IS NULL
            AND opportunity.primary_project_id IS NULL
        )::bigint AS open_without_entity
      FROM intelligence.opportunities opportunity
      LEFT JOIN (
        SELECT DISTINCT opportunity_id FROM intelligence.opportunity_evidence
      ) evidence ON evidence.opportunity_id = opportunity.id
    `);
    report.quality_indicators.intelligence_evidence_coverage = rows[0];
    if (countVal(rows[0], 'open_without_evidence')) status('FAIL', 'open intelligence items without evidence exist', rows[0]);
  }

  if (await tableExists('intelligence.attention_queue')) {
    const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS count FROM intelligence.attention_queue WHERE evidence_count = 0`);
    report.quality_indicators.attention_without_evidence = rows[0];
    if (countVal(rows[0], 'count')) status('FAIL', 'attention queue contains items without evidence', rows[0]);
  }

  if (await tableExists('relationships.identity_conflicts')) {
    const { rows } = await pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending FROM relationships.identity_conflicts`);
    report.quality_indicators.identity_conflicts = rows[0];
  }

  if (await tableExists('intelligence.pipeline_runs')) {
    const { rows } = await pool.query(`
      SELECT status, started_at, heartbeat_at, completed_at, error
      FROM intelligence.pipeline_runs
      ORDER BY started_at DESC
      LIMIT 1
    `);
    report.derived_freshness.latest_intelligence_pipeline = rows[0] || null;
    if (!rows[0] || rows[0].status !== 'completed') status('WARN', 'latest durable intelligence run is not completed', rows[0] || null);
  }
}

async function runReleaseContractGates() {
  const gates = {};
  const selfJid = process.env.WHATSAPP_SELF_JID || process.env.MY_WA_JID || '';
  const releaseChatSql = canonicalWhatsAppChatIdSql({
    dataExpression: 'm.data',
    storedChatExpression: 'm.chat_id',
    selfExpression: '$1',
  });

  const keySets = await pool.query(`
    WITH expected_email AS (
      SELECT 'email:' || id::text AS source_id
      FROM email.emails
      WHERE id IS NOT NULL AND COALESCE(date, received_at, created_at) IS NOT NULL
    ), actual_email AS (
      SELECT source_id FROM relationships.communications WHERE source = 'email'
    ), expected_limitless AS (
      SELECT 'limitless:' || id::text AS source_id
      FROM limitless.lifelogs
      WHERE id IS NOT NULL
        AND COALESCE(NULLIF(markdown, ''), NULLIF(contents, ''), NULLIF(title, '')) IS NOT NULL
        AND COALESCE(start_time, created_at) IS NOT NULL
    ), actual_limitless AS (
      SELECT source_id FROM relationships.communications WHERE source = 'limitless'
    )
    SELECT
      (SELECT COUNT(*) FROM (SELECT source_id FROM expected_email EXCEPT SELECT source_id FROM actual_email) missing)::bigint AS email_missing,
      (SELECT COUNT(*) FROM (SELECT source_id FROM actual_email EXCEPT SELECT source_id FROM expected_email) extra)::bigint AS email_extra,
      (SELECT COUNT(*) FROM (SELECT source_id FROM expected_limitless EXCEPT SELECT source_id FROM actual_limitless) missing)::bigint AS limitless_missing,
      (SELECT COUNT(*) FROM (SELECT source_id FROM actual_limitless EXCEPT SELECT source_id FROM expected_limitless) extra)::bigint AS limitless_extra
  `);
  gates.bidirectional_source_keys = keySets.rows[0];
  if (Object.values(keySets.rows[0]).some(value => Number(value) !== 0)) {
    status('FAIL', 'email/Limitless canonical key sets do not exactly match immutable source rows', keySets.rows[0]);
  }

  const whatsapp = await pool.query(`
    WITH eligible_raw AS (
      SELECT m.id,
             COALESCE(NULLIF(m.wa_msg_id, ''), NULLIF(m.data->'id'->>'_serialized', '')) AS native_id
      FROM public.messages m
      CROSS JOIN LATERAL (SELECT ${releaseChatSql} AS canonical_chat_id) chat
      WHERE m.event IN ('message','message_create','message_historical')
        AND chat.canonical_chat_id IS NOT NULL
    ), raw_matches AS (
      SELECT raw.id
      FROM eligible_raw raw
      JOIN relationships.communication_source_rows lineage
        ON lineage.source = 'whatsapp' AND lineage.source_row_id = raw.id
      JOIN relationships.communications communication
        ON communication.id = lineage.communication_id AND communication.source = 'whatsapp'
      UNION
      SELECT raw.id
      FROM eligible_raw raw
      JOIN relationships.communications communication
        ON COALESCE(communication.metadata->>'source_row_id', '') = raw.id::text
       AND communication.source = 'whatsapp'
      UNION
      SELECT raw.id
      FROM eligible_raw raw
      JOIN relationships.communications communication
        ON communication.source = 'whatsapp'
       AND raw.native_id IS NOT NULL
       AND communication.source_id = 'wa:' || raw.native_id
    ), candidate_pairs AS (
      SELECT fallback.id fallback_id, native.id native_id
      FROM relationships.communications fallback
      JOIN public.messages raw
        ON COALESCE(fallback.metadata->>'source_row_id', '') ~ '^[0-9]+$'
       AND raw.id = (fallback.metadata->>'source_row_id')::bigint
      JOIN relationships.communications native
        ON native.source = 'whatsapp'
       AND native.source_id = 'wa:' || COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', ''))
      WHERE fallback.source = 'whatsapp'
        AND fallback.source_id LIKE 'wa:fallback:%'
        AND COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', '')) IS NOT NULL
        AND fallback.id <> native.id
    ), verified_communication_ids AS (
      SELECT communication.id
      FROM relationships.communications communication
      JOIN relationships.communication_source_rows lineage
        ON lineage.communication_id = communication.id AND lineage.source = 'whatsapp'
      JOIN public.messages raw ON raw.id = lineage.source_row_id
      WHERE communication.source = 'whatsapp'
      UNION
      SELECT communication.id
      FROM relationships.communications communication
      JOIN public.messages raw
        ON COALESCE(communication.metadata->>'source_row_id', '') ~ '^[0-9]+$'
       AND raw.id = (communication.metadata->>'source_row_id')::bigint
      WHERE communication.source = 'whatsapp'
      UNION
      SELECT communication.id
      FROM public.messages raw
      JOIN relationships.communications communication
        ON communication.source = 'whatsapp'
       AND communication.source_id = 'wa:' || COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', ''))
      WHERE COALESCE(NULLIF(raw.wa_msg_id, ''), NULLIF(raw.data->'id'->>'_serialized', '')) IS NOT NULL
    ), active_rawless AS (
      SELECT communication.id
      FROM relationships.communications communication
      WHERE communication.source = 'whatsapp'
        AND NOT EXISTS (SELECT 1 FROM verified_communication_ids verified WHERE verified.id = communication.id)
        AND COALESCE(communication.metadata->>'lineage_status', '') <> 'quarantined_missing_raw'
    )
    SELECT
      (SELECT COUNT(*) FROM eligible_raw raw
       WHERE NOT EXISTS (SELECT 1 FROM raw_matches matched WHERE matched.id = raw.id))::bigint AS raw_rows_without_canonical,
      (SELECT COUNT(*) FROM candidate_pairs)::bigint AS logical_fallback_native_pairs,
      (SELECT COUNT(*) FROM active_rawless)::bigint AS active_canonical_without_raw,
      (SELECT COUNT(*) FROM relationships.communications
       WHERE source = 'whatsapp' AND metadata->>'lineage_status' = 'quarantined_missing_raw')::bigint AS quarantined_without_raw
  `, [selfJid]);
  gates.whatsapp_lineage = whatsapp.rows[0];
  for (const key of ['raw_rows_without_canonical', 'logical_fallback_native_pairs', 'active_canonical_without_raw']) {
    if (countVal(whatsapp.rows[0], key)) status('FAIL', `WhatsApp lineage gate failed: ${key}`, whatsapp.rows[0]);
  }

  const identity = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE conflict.status = 'pending')::bigint AS pending_conflicts,
      (SELECT COUNT(*) FROM relationships.contact_identities identity
       JOIN relationships.contacts contact ON contact.id = identity.contact_id
       LEFT JOIN relationships.contact_merge_redirects redirect ON redirect.from_contact_id = contact.id
       WHERE identity.is_active AND (contact.is_noise OR redirect.from_contact_id IS NOT NULL))::bigint AS active_on_noise_or_redirect,
      (SELECT COUNT(*) FROM (
        SELECT source, identity_type, identity_value
        FROM relationships.contact_identities WHERE is_active
        GROUP BY source, identity_type, identity_value HAVING COUNT(*) > 1
      ) duplicates)::bigint AS active_identity_collisions
    FROM relationships.identity_conflicts conflict
  `);
  gates.identity = identity.rows[0];
  if (Object.values(identity.rows[0]).some(value => Number(value) !== 0)) status('FAIL', 'identity convergence gate failed', identity.rows[0]);

  const evidence = await pool.query(`
    WITH resolved AS (
      SELECT evidence.id, evidence.opportunity_id,
        CASE
          WHEN evidence.source_table = 'relationships.communications' THEN EXISTS (
            SELECT 1 FROM relationships.communications row
            WHERE row.id = CASE WHEN evidence.source_id ~ '^[0-9]+$' THEN evidence.source_id::bigint ELSE -1 END
              AND COALESCE(row.metadata->>'lineage_status', 'verified') <> 'quarantined_missing_raw'
          )
          ELSE FALSE
        END AS resolves_directly
      FROM intelligence.opportunity_evidence evidence
    )
    SELECT
      COUNT(*) FILTER (WHERE NOT resolves_directly)::bigint AS dangling_or_derived_evidence,
      COUNT(DISTINCT opportunity.id) FILTER (
        WHERE opportunity.status = 'open' AND opportunity.lifecycle_state = 'active'
          AND NOT EXISTS (SELECT 1 FROM resolved row WHERE row.opportunity_id = opportunity.id AND row.resolves_directly)
      )::bigint AS active_without_direct_evidence,
      COUNT(DISTINCT opportunity.id) FILTER (
        WHERE opportunity.status = 'open' AND opportunity.lifecycle_state = 'active'
          AND opportunity.primary_contact_id IS NULL AND opportunity.primary_project_id IS NULL
      )::bigint AS active_without_entity,
      COUNT(DISTINCT opportunity.id) FILTER (
        WHERE opportunity.lifecycle_state IS DISTINCT FROM CASE opportunity.status
          WHEN 'actioned' THEN 'resolved' WHEN 'dismissed' THEN 'dismissed'
          WHEN 'expired' THEN 'expired' ELSE opportunity.lifecycle_state END
      )::bigint AS lifecycle_mismatches
    FROM intelligence.opportunities opportunity
    LEFT JOIN resolved ON resolved.opportunity_id = opportunity.id
  `);
  gates.evidence_and_lifecycle = evidence.rows[0];
  if (Object.values(evidence.rows[0]).some(value => Number(value) !== 0)) status('FAIL', 'evidence/lifecycle convergence gate failed', evidence.rows[0]);

  const projects = await pool.query(`
    WITH aggregate AS (
      SELECT project.id,
             COUNT(communication.id)::int AS actual_count,
             MAX(communication.occurred_at) AS actual_last_activity
      FROM projects.projects project
      LEFT JOIN projects.project_communications communication ON communication.project_id = project.id
      GROUP BY project.id
    )
    SELECT
      COUNT(*) FILTER (WHERE project.comm_count IS DISTINCT FROM aggregate.actual_count)::bigint AS count_mismatches,
      COUNT(*) FILTER (WHERE project.last_activity_at IS DISTINCT FROM aggregate.actual_last_activity)::bigint AS last_activity_mismatches,
      (SELECT COUNT(*) FROM projects.project_insights insight
       WHERE insight.is_resolved AND insight.resolution_status = 'open')::bigint AS resolved_marked_open,
      (SELECT COUNT(*) FROM projects.project_insights insight
       WHERE NOT insight.is_resolved AND insight.resolution_status = 'open'
         AND (COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(insight.evidence_refs) = 'array' THEN insight.evidence_refs ELSE '[]'::jsonb END), 0) = 0
              OR insight.insight_fingerprint IS NULL))::bigint AS open_without_lineage
    FROM projects.projects project JOIN aggregate USING (id)
  `);
  gates.projects = projects.rows[0];
  if (Object.values(projects.rows[0]).some(value => Number(value) !== 0)) status('FAIL', 'project convergence gate failed', projects.rows[0]);

  const clarifications = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'answered' AND answer_guidance_fact_id IS NULL)::bigint AS answered_without_guidance,
      COUNT(*) FILTER (WHERE status = 'pending' AND impact <> 'high' AND occurrences >= 3)::bigint AS low_level_interruptions,
      COUNT(*) FILTER (WHERE status IN ('answered','auto_resolved') AND COALESCE(answered_at, resolved_at) IS NULL)::bigint AS closed_without_timestamp
    FROM intelligence.clarification_questions
  `);
  gates.clarifications = clarifications.rows[0];
  if (Object.values(clarifications.rows[0]).some(value => Number(value) !== 0)) status('FAIL', 'clarification/guidance lifecycle gate failed', clarifications.rows[0]);

  const timeAndRuns = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM email.emails WHERE COALESCE(date, received_at, created_at) > NOW() + INTERVAL '6 hours')::bigint AS future_email_rows,
      (SELECT COUNT(*) FROM relationships.communications WHERE occurred_at > NOW() + INTERVAL '6 hours')::bigint AS future_canonical_rows,
      (SELECT status FROM relationships.analysis_runs ORDER BY started_at DESC LIMIT 1) AS latest_relationship_run,
      (SELECT status FROM projects.analysis_runs ORDER BY started_at DESC LIMIT 1) AS latest_project_run,
      (SELECT status FROM intelligence.pipeline_runs ORDER BY started_at DESC LIMIT 1) AS latest_intelligence_run
  `);
  gates.time_and_runs = timeAndRuns.rows[0];
  if (countVal(timeAndRuns.rows[0], 'future_email_rows') || countVal(timeAndRuns.rows[0], 'future_canonical_rows')) {
    status('FAIL', 'source or canonical timestamps are implausibly future-dated', timeAndRuns.rows[0]);
  }
  for (const key of ['latest_relationship_run', 'latest_project_run', 'latest_intelligence_run']) {
    if (timeAndRuns.rows[0][key] !== 'completed') status('FAIL', `${key} is not completed`, timeAndRuns.rows[0][key]);
  }

  if (await tableExists('public.media_files')) {
    const media = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE analysis_status IN ('pending','processing'))::bigint AS unfinished,
        COUNT(*) FILTER (WHERE analysis_status = 'failed')::bigint AS failed,
        COUNT(*) FILTER (WHERE analysis_status = 'completed' AND COALESCE(NULLIF(semantic_text, ''), NULLIF(extracted_text, '')) IS NULL)::bigint AS completed_without_semantics
      FROM public.media_files
    `);
    gates.media = media.rows[0];
    if (Object.values(media.rows[0]).some(value => Number(value) !== 0)) status('FAIL', 'media semantic processing is not converged', media.rows[0]);
  }

  report.quality_indicators.release_contract = gates;
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
    'intelligence.communication_events': ['id','event_key','event_kind','title','description','communicated_at','starts_at','ends_at','source_table','source_id','source_ref','source_contact_id','source_project_id','source_subject','source_excerpt','confidence','metadata','created_at','updated_at'],
    'intelligence.opportunities': ['id','opportunity_type','title','description','recommended_next_action','why_now','status','priority','confidence','impact_score','urgency_score','relationship_score','expected_value_score','score_explanation','source_system','source_ref','source_hash','dedupe_key','primary_contact_id','primary_project_id','surfaced_insight_id','surfaced_project_insight_id','expires_at','snoozed_until','first_seen_at','last_seen_at','actioned_at','dismissed_at','feedback','feedback_note','metadata','created_at','updated_at'],
    'intelligence.opportunity_contacts': ['opportunity_id','contact_id','role','confidence','created_at'],
    'intelligence.opportunity_projects': ['opportunity_id','project_id','role','confidence','created_at'],
    'intelligence.opportunity_evidence': ['id','opportunity_id','source_table','source_id','source_ref','occurred_at','quote','relevance','metadata','created_at'],
    'intelligence.signals': ['id','signal_type','title','description','contact_id','project_id','source_table','source_id','source_ref','occurred_at','confidence','strength','metadata','created_at','updated_at'],
    'intelligence.opportunity_feedback_events': ['id','opportunity_id','feedback','note','created_by','created_at'],
  };

  for (const [table, cols] of Object.entries(expected)) {
    if (!(await tableExists(table))) {
      report.schema_drift[table] = { skipped: true, reason: 'table missing' };
      status('FAIL', `required table is missing: ${table}`);
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
    if (missing.length) status('FAIL', `required columns are missing from ${table}`, { missing });
    report.schema_drift[table] = { ok: missing.length === 0, missing, additive_columns: extra };
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
  await runCanonicalQualityGates();
  await runReleaseContractGates();
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
