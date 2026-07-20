#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const cron = require('node-cron')
const db   = require('@secondbrain/db')
const { cleanupOrphanedRuns } = require('../shared/cleanup')

const extractor     = require('./services/extractor')
const analyzer      = require('./services/analyzer')
const insights      = require('./services/insights')
const opportunities = require('./services/opportunities')
const intelligence   = require('../intelligence')
const batching      = require('../shared/batching')
const caching       = require('../shared/caching')
const identity      = require('./services/identity')
const communication = require('./services/communication')
const { acquireRunLease } = require('../shared/run-lease')

let telemetry = null
try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
let _runId = null
let _analysisPromise = null
let _shutdownPromise = null
const FORCE_FULL = process.argv.includes('--full')
const RUN_ONCE = process.argv.includes('--once')

console.log('🧠 Relationships Agent v1.0')
console.log('📊 Builds contact profiles from WhatsApp, Email & Limitless\n')

// ── Schema bootstrap ──────────────────────────────────────────────────────────

async function ensureSchema() {
  const fs   = require('fs')
  const path = require('path')
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
    await db.query(sql)
    await identity.ensureIdentitySchema(db)
    console.log('✅ Schema ready')
  } catch (err) {
    console.error('❌ Schema setup error:', err.message)
    throw err
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPhoneJid(jid) {
  const num = jid.replace('@c.us', '').replace('@g.us', '')
  if (/^\d{7,15}$/.test(num)) return '+' + num
  return num
}

function normalizeName(name) {
  if (!name) return null
  return name.toLowerCase().trim().replace(/\s+/g, ' ')
}

async function upsertContact(profile, chatId) {
  const phone = chatId.replace('@c.us', '')
  const waJid = chatId

  try {
    await identity.ensureIdentitySchema(db)

    // Try exact source identities first. Name-only matches are intentionally
    // weaker and should not override stable WhatsApp/email/phone identity.
    let id = await identity.findContactByIdentity(db, { source: 'whatsapp', identity_type: 'wa_jid', identity_value: waJid })
    if (!id) id = await identity.findContactByIdentity(db, { source: 'phone', identity_type: 'phone', identity_value: phone })

    if (!id) {
      const { rows: existing } = await db.query(`
        SELECT id FROM relationships.contacts
        WHERE wa_jids @> ARRAY[$1]::text[]
           OR EXISTS (
             SELECT 1 FROM unnest(COALESCE(phone_numbers, '{}')) value
             WHERE REGEXP_REPLACE(value, '[^0-9]', '', 'g') = $2
           )
        ORDER BY CASE WHEN wa_jids @> ARRAY[$1]::text[] THEN 0
                      ELSE 1 END,
                 last_interaction_at DESC NULLS LAST,
                 id ASC
        LIMIT 1
      `, [waJid, phone])
      id = existing[0]?.id || null
    }

    if (id) {
      // Use CASE WHEN manual_overrides ? 'field' to skip agent overwrites on locked fields
      await db.query(`
        UPDATE relationships.contacts SET
          display_name          = CASE WHEN manual_overrides ? 'display_name'          THEN display_name          ELSE $1  END,
          normalized_name       = CASE WHEN manual_overrides ? 'display_name'          THEN normalized_name       ELSE $2  END,
          phone_numbers         = ARRAY(SELECT DISTINCT unnest(phone_numbers || ARRAY[$3]::text[])),
          wa_jids               = ARRAY(SELECT DISTINCT unnest(wa_jids || ARRAY[$4]::text[])),
          company               = CASE WHEN manual_overrides ? 'company'               THEN company               ELSE COALESCE($5, company) END,
          job_title             = CASE WHEN manual_overrides ? 'job_title'             THEN job_title             ELSE COALESCE($6, job_title) END,
          my_role               = CASE WHEN manual_overrides ? 'my_role'               THEN my_role               ELSE COALESCE($7, my_role) END,
          summary               = CASE WHEN manual_overrides ? 'summary'               THEN summary               ELSE $8  END,
          relationship_type     = CASE WHEN manual_overrides ? 'relationship_type'     THEN relationship_type     ELSE $9  END,
          relationship_strength = CASE WHEN manual_overrides ? 'relationship_strength' THEN relationship_strength ELSE $10 END,
          tags                  = CASE WHEN manual_overrides ? 'tags'                  THEN tags                  ELSE $11 END,
          is_noise              = CASE WHEN manual_overrides ? 'is_noise'              THEN is_noise              ELSE $12 END,
          last_interaction_at   = $13,
          first_interaction_at  = LEAST(first_interaction_at, $14),
          updated_at            = NOW()
        WHERE id = $15
      `, [
        profile.display_name,          // $1
        normalizeName(profile.display_name), // $2
        phone,                         // $3
        waJid,                         // $4
        profile.company,               // $5
        profile.job_title,             // $6
        profile.my_role,               // $7
        profile.summary,               // $8
        profile.relationship_type,     // $9
        profile.relationship_strength, // $10
        profile.tags,                  // $11
        profile.is_noise,              // $12
        profile.last_msg_at || null,   // $13
        profile.first_msg_at || null,  // $14
        id,                            // $15
      ])
      await identity.recordContactIdentities(db, id, [
        { source: 'whatsapp', identity_type: 'wa_jid', identity_value: waJid, confidence: 1 },
        { source: 'phone', identity_type: 'phone', identity_value: phone, confidence: 0.98 },
      ])
      return id
    }

    // Insert new
    const { rows: inserted } = await db.query(`
      INSERT INTO relationships.contacts (
        display_name, normalized_name, phone_numbers, wa_jids,
        company, job_title, my_role, summary,
        relationship_type, relationship_strength, tags, is_noise,
        last_interaction_at, first_interaction_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      profile.display_name,
      normalizeName(profile.display_name),
      [phone],
      [waJid],
      profile.company,
      profile.job_title,
      profile.my_role,
      profile.summary,
      profile.relationship_type,
      profile.relationship_strength,
      profile.tags,
      profile.is_noise,
      profile.last_msg_at || null,
      profile.first_msg_at || null,
    ])
    const contactId = inserted[0].id
    await identity.recordContactIdentities(db, contactId, [
      { source: 'whatsapp', identity_type: 'wa_jid', identity_value: waJid, confidence: 1 },
      { source: 'phone', identity_type: 'phone', identity_value: phone, confidence: 0.98 },
    ])
    return contactId
  } catch (err) {
    console.error('[index] upsertContact error:', err.message)
    return null
  }
}

async function upsertCommunications(contactId, messages, chatId) {
  let count = 0
  for (const msg of messages.slice(0, 50)) {
    if (!communication.messageTextForAnalysis(msg)) continue
    const sourceId = communication.whatsappSourceId(msg, chatId)
    try {
      const { snippet, metadata } = communication.buildMediaSnippetAndMeta(msg)
      await communication.upsertCanonicalCommunication(db, {
        contact_id: contactId,
        source: 'whatsapp',
        source_id: sourceId,
        direction: msg.from_me ? 'outbound' : 'inbound',
        content_snippet: snippet,
        chat_id: chatId,
        is_group: false,
        occurred_at: msg.ts,
        metadata,
      })
      count++
    } catch (err) {
      console.error(`[index] direct communication error for ${sourceId}:`, err.message)
    }
  }
  return count
}

async function upsertInsight(contactId, insightData) {
  try {
    // If a source_ref is provided, deduplicate: skip if an unactioned/undismissed insight already exists
    if (insightData.source_ref) {
      const { rows: exists } = await db.query(`
        SELECT id FROM relationships.insights
        WHERE source_ref = $1
          AND is_actioned  = false
          AND is_dismissed = false
        LIMIT 1
      `, [insightData.source_ref])
      if (exists.length > 0) {
        if (Array.isArray(insightData.source_refs) && insightData.source_refs.length > 0) {
          await db.query('UPDATE relationships.insights SET source_refs = $2::jsonb, updated_at = NOW() WHERE id = $1', [
            exists[0].id,
            JSON.stringify(insightData.source_refs),
          ])
        }
        if (!insightData.skip_intelligence) await intelligence.upsertFromRelationshipInsight(exists[0].id, contactId, insightData)
        return exists[0].id
      }
    }

    const contactIds = Array.isArray(insightData.contact_ids) ? insightData.contact_ids : []

    const { rows } = await db.query(`
      INSERT INTO relationships.insights (
        contact_id, insight_type, title, description, priority, source_ref, contact_ids, source_refs
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id
    `, [
      contactId,
      insightData.insight_type,
      insightData.title,
      insightData.description,
      insightData.priority || 'medium',
      insightData.source_ref || null,
      contactIds,
      JSON.stringify(insightData.source_refs || []),
    ])
    const insightId = rows[0]?.id || null
    if (insightId && !insightData.skip_intelligence) await intelligence.upsertFromRelationshipInsight(insightId, contactId, insightData)
    return insightId
  } catch (err) {
    console.error('[index] upsertInsight error:', err.message)
    return null
  }
}

// ── Get last completed run timestamp ──────────────────────────────────────────

async function getLastRunAt() {
  try {
    const { rows } = await db.query(`
      SELECT completed_at FROM relationships.analysis_runs
      WHERE status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `)
    return rows[0]?.completed_at || null
  } catch { return null }
}

async function recoverInterruptedRuns() {
  const { rows } = await db.query(`
    UPDATE relationships.analysis_runs
    SET status = 'failed', completed_at = NOW(),
        error = COALESCE(error, 'Agent process was replaced before the run completed')
    WHERE status = 'running'
    RETURNING id
  `)
  if (rows.length > 0) {
    console.log(`🧹 Recovered ${rows.length} interrupted analysis run(s)`)
  }
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function runAnalysis() {
  const lease = await acquireRunLease(db, 207202601)
  if (!lease.acquired) {
    console.log('⏭  Another relationships process owns the analysis lease')
    return { status: 'skipped' }
  }

  let runId = null
  let contactsProcessed = 0
  let insightsGenerated = 0
  let telemetryStatus = 'failed'
  let telemetryError = null
  const requiredFailures = []

  try {
    // Holding the database lease proves no prior process can still be writing.
    // Any running ledger row is therefore an interrupted predecessor.
    await recoverInterruptedRuns()
    if (telemetry) {
      try {
        _runId = await telemetry.startRun({ agentId: 'relationships', workflowName: 'relationship_analysis' })
      } catch (err) {
        console.warn('[telemetry] startRun failed:', err.message)
        _runId = null
      }
    }
    // Get incremental watermark
    const lastRunAt = FORCE_FULL ? null : await getLastRunAt()
    if (lastRunAt) {
      console.log(`⏱  Incremental mode: processing new activity since ${lastRunAt.toISOString()}`)
    } else {
      console.log('🆕 First run: full analysis')
    }

    // Create run record
    const { rows } = await db.query(`
      INSERT INTO relationships.analysis_runs (status) VALUES ('running')
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
    if (!rows.length) return { status: 'skipped' }
    runId = rows[0].id
    console.log(`\n🔍 Starting analysis run #${runId}`)

    // ── 1. Extract direct chat contacts ──────────────────────────────────────
    console.log('📱 Extracting WhatsApp direct contacts...')
    const directContacts = await extractor.extractDirectChatContacts()
    console.log(`   Found ${directContacts.length} direct chat contacts`)

    // Activity caches, not the last successful run timestamp, decide whether a
    // contact is current. This lets per-contact failures retry automatically on
    // the next run even when no new message arrived after the failed attempt.
    const meaningfulContacts = directContacts.filter(c => {
      const total = Number(c.msg_count)
      if (total < 3 && !c.display_name) return false
      return true
    })
    console.log(`   Considering ${meaningfulContacts.length} meaningful contacts`)

    // ── 2. Filter unchanged items (caching optimization) ────────────────────
    const directContactItems = meaningfulContacts.map(contact => ({
      ...contact,
      id: contact.chat_id,
      item_id: contact.chat_id,
      last_activity_at: contact.last_msg_at,
    }))
    const contactsNeedingAnalysis = FORCE_FULL
      ? directContactItems
      : await caching.filterUnprocessedItems('relationships', 'direct_contact', directContactItems)
    console.log(`   Filtered to ${contactsNeedingAnalysis.length} contacts needing analysis (${meaningfulContacts.length - contactsNeedingAnalysis.length} cached)`)

    // ── 3. Process contacts in parallel batches ────────────────────────────
    const PARALLEL_BATCH_SIZE = 5  // Process 5 contacts simultaneously
    const DELAY_BETWEEN_BATCHES = 1000  // 1s between batches to avoid overwhelming LLM

    let processedInBatch = 0
    const results = await batching.processBatch(
      contactsNeedingAnalysis,
      async (contact) => {
        try {
          // Check if this contact already exists in DB
          const { rows: existingRows } = await db.query(`
            SELECT id FROM relationships.contacts
            WHERE wa_jids @> ARRAY[$1]::text[]
            LIMIT 1
          `, [contact.chat_id])
          const existingId = existingRows[0]?.id || null

          // Get messages
          const messages = await extractor.getDirectMessages(contact.chat_id, 30)

          // Every cache miss is semantic work, including a prior failed
          // existing contact. Skipping analysis here would make failures
          // permanent when no later message arrives.
          const hasMeaningfulContent = messages.some(m => communication.messageTextForAnalysis(m).length > 5)
          if (!hasMeaningfulContent && !contact.display_name) return { skipped: true }

          let existingOverrides = {}
          if (existingId) {
            const { rows: orRows } = await db.query(
              'SELECT manual_overrides FROM relationships.contacts WHERE id = $1', [existingId]
            )
            existingOverrides = orRows[0]?.manual_overrides || {}
          }

          const profile = await analyzer.analyzeDirectChatContact(contact.chat_id, contact, messages, existingOverrides)
          if (profile.analysis_error) {
            return { error: profile.analysis_error, retryable: true, contact: contact.chat_id }
          }
          profile.last_msg_at  = contact.last_msg_at
          profile.first_msg_at = contact.first_msg_at

          const contactId = await upsertContact(profile, contact.chat_id)
          if (!contactId) return { error: 'Failed to upsert contact' }
          await upsertCommunications(contactId, messages, contact.chat_id)

          if (!profile.is_noise) {
            console.log(`   ✓ ${existingId ? 'UPDATED' : 'NEW'} ${profile.display_name} (${profile.relationship_type}, ${profile.relationship_strength})`)
          }
          await caching.recordProcessed('relationships', 'direct_contact', contact.chat_id, {
            is_noise: profile.is_noise,
          })
          return { success: true, contact: contact.chat_id, isNew: !existingId }
        } catch (err) {
          console.error(`   ✗ Error processing ${contact.chat_id}: ${err.message}`)
          return { error: err.message }
        }
      },
      {
        batchSize: PARALLEL_BATCH_SIZE,
        delayBetweenBatches: DELAY_BETWEEN_BATCHES,
        onBatchComplete: async (batchInfo) => {
          processedInBatch += batchInfo.successCount
          await db.query(`
            UPDATE relationships.analysis_runs
            SET contacts_processed = contacts_processed + $1
            WHERE id = $2
          `, [batchInfo.successCount, runId])
          console.log(`   Batch ${batchInfo.batchNum}/${batchInfo.totalBatches} complete (${batchInfo.successCount} success, ${batchInfo.errorCount} errors)`)
          if (telemetry && _runId) {
            telemetry.progress(_runId, 'people_matched', { completed: processedInBatch })
          }
        }
      }
    )

    contactsProcessed += results.filter(r => r?.success).length
    for (const result of results.filter(result => result?.error)) {
      requiredFailures.push(`direct:${result.contact || 'unknown'}:${result.error}`)
    }

    // The analysis sample is intentionally small; recovery is not. Each run
    // takes the oldest missing direct-message batch and advances the watermark
    // through stable WhatsApp IDs until all history is canonicalized.
    const missingDirectMessages = await extractor.getUnstoredDirectMessages(5000)
    const directCommRecovery = await communication.upsertDirectCommunications(db, missingDirectMessages)
    if (directCommRecovery.inserted > 0 || directCommRecovery.unresolved > 0) {
      console.log(`   Recovered ${directCommRecovery.inserted} direct messages (${directCommRecovery.unresolved} unresolved contacts)`)
    }

    // Media analysis is asynchronous. Refresh already-canonical WhatsApp rows
    // whenever a description/transcript/PDF summary arrives after ingestion.
    const staleMediaMessages = await extractor.getStaleMediaCommunications(500)
    const staleDirectMedia = staleMediaMessages.filter(message => !message.is_group)
    const staleGroupMedia = staleMediaMessages.filter(message => message.is_group)
    const directMediaRefresh = await communication.upsertDirectCommunications(db, staleDirectMedia)
    const groupMediaRefresh = await communication.upsertGroupCommunications(db, staleGroupMedia)
    const refreshedMedia = directMediaRefresh.updated + groupMediaRefresh.updated
    if (refreshedMedia > 0) console.log(`   Refreshed semantic text for ${refreshedMedia} media communications`)

    // ── 3. Process email contacts ─────────────────────────────────────────────
    console.log('\n📧 Processing email contacts...')
    const emailSenders = await extractor.getEmailContacts()
    const NOISE_EMAIL_PATTERNS = [/noreply/i, /no-reply/i, /donotreply/i, /notification/i,
      /alert/i, /newsletter/i, /marketing/i, /mailer/i, /support@/i, /bounce/i, /postmaster/i]

    // The per-sender cache is the only retry/watermark authority. A global
    // completed-run timestamp would hide a sender whose prior attempt failed.
    const activeSenders = emailSenders
    console.log(`   Considering ${activeSenders.length} senders`)

    // Filter senders that don't need re-processing (caching)
    const emailSenderItems = activeSenders.map(s => ({
        id: s.from_address,
        item_id: s.from_address,
        last_activity_at: s.last_email_at,
      }))
    const sendersToProcess = FORCE_FULL
      ? emailSenderItems
      : await caching.filterUnprocessedItems('relationships', 'email_sender', emailSenderItems)
    console.log(`   Further filtered to ${sendersToProcess.length} senders needing update`)

    let emailContactsProcessed = 0
    // Map back to full sender objects
    const senderAddressesToProcess = new Set([
      ...sendersToProcess.map(s => s.id),
      ...activeSenders.filter(s => !s.is_linked && !s.registry_is_noise).map(s => s.from_address),
    ])
    for (const sender of activeSenders) {
      if (!sender.email || !senderAddressesToProcess.has(sender.from_address)) continue
      const isNoise = NOISE_EMAIL_PATTERNS.some(p => p.test(sender.from_address))

      try {
        // Upsert into email_senders registry
        await db.query(`
          INSERT INTO relationships.email_senders
            (raw_address, parsed_name, parsed_email, email_count, unread_count,
             last_email_at, first_email_at, is_noise)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (raw_address) DO UPDATE SET
            parsed_name    = COALESCE(EXCLUDED.parsed_name, relationships.email_senders.parsed_name),
            email_count    = EXCLUDED.email_count,
            unread_count   = EXCLUDED.unread_count,
            last_email_at  = EXCLUDED.last_email_at,
            first_email_at = LEAST(relationships.email_senders.first_email_at, EXCLUDED.first_email_at),
            updated_at     = NOW()
        `, [sender.from_address, sender.name, sender.email, sender.email_count,
            sender.unread_count, sender.last_email_at, sender.first_email_at, isNoise])

        if (isNoise) continue

        // Try to link to an existing contact by exact source identity first,
        // then the legacy exact email array. Names are never identity evidence.
        let contactId = await identity.findContactByIdentity(db, { source: 'email', identity_type: 'email', identity_value: sender.email })

        if (!contactId) {
          const { rows: existingByEmail } = await db.query(`
            SELECT id FROM relationships.contacts WHERE emails @> ARRAY[$1]::text[] LIMIT 1
          `, [sender.email])
          contactId = existingByEmail[0]?.id || null
        }

        let isNew = !contactId

        if (!contactId) {
          // Create new contact from email sender
          const { rows: inserted } = await db.query(`
            INSERT INTO relationships.contacts
              (display_name, normalized_name, emails, last_interaction_at, first_interaction_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `, [
            sender.name || sender.email,
            normalizeName(sender.name || sender.email),
            [sender.email],
            sender.last_email_at,
            sender.first_email_at,
          ])
          contactId = inserted[0].id
        } else {
          // Merge email into existing contact
          await db.query(`
            UPDATE relationships.contacts SET
              emails = ARRAY(SELECT DISTINCT unnest(emails || ARRAY[$1]::text[])),
              last_interaction_at = GREATEST(last_interaction_at, $2),
              updated_at = NOW()
            WHERE id = $3
          `, [sender.email, sender.last_email_at, contactId])
        }

        await identity.recordContactIdentities(db, contactId, [
          { source: 'email', identity_type: 'email', identity_value: sender.email, confidence: 1 },
        ])

        // Link email_sender to contact
        await db.query(`
          UPDATE relationships.email_senders SET contact_id = $1 WHERE raw_address = $2
        `, [contactId, sender.from_address])

        // Upsert recent emails as communications (only new ones for existing contacts)
        const emails = await extractor.getEmailsBySender(sender.from_address, 20)
        const emailsToProcess = (lastRunAt && !isNew)
          ? emails.filter(e => !e.date || new Date(e.date) > lastRunAt)
          : emails
        await communication.upsertEmailCommunications(db, emailsToProcess.map(em => ({
          ...em,
          contact_id: contactId,
          from_address: sender.from_address,
          sender_name: sender.name,
          sender_email: sender.email,
          sender_is_noise: isNoise,
        })))

        emailContactsProcessed++
        // Record in cache
        await caching.recordProcessed('relationships', 'email_sender', sender.from_address)
      } catch (err) {
        console.error(`[index] email contact error for ${sender.from_address}:`, err.message)
        requiredFailures.push(`email:${sender.from_address}:${err.message}`)
      }
    }
    console.log(`   Processed ${emailContactsProcessed} email contacts`)

    const missingEmails = await extractor.getUnstoredEmailCommunications(5000)
    const emailCommRecovery = await communication.upsertEmailCommunications(db, missingEmails)
    if (emailCommRecovery.inserted > 0 || emailCommRecovery.unresolved > 0) {
      console.log(`   Recovered ${emailCommRecovery.inserted} email communications (${emailCommRecovery.unresolved} unresolved)`)
    }

    // ── 3b. Process WhatsApp groups ───────────────────────────────────────────
    console.log('\n👥 Processing WhatsApp groups...')
    const groups = await extractor.extractGroupChats()
    let groupsAnalyzed = 0

    // Recover missing group events with one source scan. Checking the full
    // messages table once per group is both redundant and O(groups × messages).
    const missingGroupMessages = await extractor.getUnstoredGroupMessagesBatch(5000)
    const groupCommRecovery = await communication.upsertGroupCommunications(db, missingGroupMessages)
    if (groupCommRecovery.inserted > 0 || groupCommRecovery.skipped > 0) {
      console.log(`   Recovered ${groupCommRecovery.inserted} group messages (${groupCommRecovery.linked} linked authors)`)
    }

    for (const group of groups) {
      try {
        const groupName = await extractor.getGroupName(group.chat_id)
        await db.query(`
          INSERT INTO relationships.groups
            (wa_chat_id, name, msg_count, my_msg_count, last_activity_at, first_seen_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (wa_chat_id) DO UPDATE SET
            name             = COALESCE(EXCLUDED.name, relationships.groups.name),
            msg_count        = EXCLUDED.msg_count,
            my_msg_count     = EXCLUDED.my_msg_count,
            last_activity_at = EXCLUDED.last_activity_at,
            updated_at       = NOW()
        `, [group.chat_id, groupName, group.msg_count, group.my_msgs,
            group.last_msg_at, group.first_msg_at])

        // Deep analysis: run if group has never been analyzed OR has new activity since last analysis
        const { rows: existing } = await db.query(`
          SELECT id, analyzed_at, group_type, my_role FROM relationships.groups WHERE wa_chat_id = $1
        `, [group.chat_id])
        const groupId = existing[0]?.id
        const analyzedAt = existing[0]?.analyzed_at

        const hasNewActivity = FORCE_FULL || !analyzedAt ||
          (group.last_msg_at && new Date(group.last_msg_at) > new Date(analyzedAt))

        if (hasNewActivity && !group.is_noise) {
          const messages = await extractor.getGroupSampleMessages(group.chat_id, 50)
          const groupRow  = {
            wa_chat_id:      group.chat_id,
            name:            groupName || group.chat_id,
            msg_count:       group.msg_count,
            my_msg_count:    group.my_msgs,
            last_activity_at: group.last_msg_at,
          }
          const analysis = await analyzer.analyzeGroup(groupRow, messages)
          if (analysis.analysis_error) {
            console.error(`   ✗ Group analysis deferred for ${groupName || group.chat_id}: ${analysis.analysis_error}`)
            requiredFailures.push(`group:${group.chat_id}:${analysis.analysis_error}`)
            continue
          }

          await db.query(`
            UPDATE relationships.groups SET
              group_type           = $1,
              my_role              = $2,
              ai_summary           = $3,
              key_topics           = $4,
              communication_advice = $5,
              notable_contacts     = $6,
              opportunities        = $7,
              is_noise             = $8,
              analyzed_at          = NOW(),
              updated_at           = NOW()
            WHERE wa_chat_id = $9
          `, [
            analysis.group_type,
            analysis.my_role,
            analysis.ai_summary,
            analysis.key_topics,
            analysis.communication_advice,
            JSON.stringify(analysis.notable_contacts),
            JSON.stringify(analysis.opportunities),
            analysis.is_noise,
            group.chat_id,
          ])

          // Surface group opportunities as legacy insights and first-class intelligence opportunities
          for (const [idx, opp] of (analysis.opportunities || []).slice(0, 3).entries()) {
            const sourceRef = `group:opportunity:${group.chat_id}:${idx}`
            await upsertInsight(null, {
              insight_type: 'opportunity',
              title:        opp.title || 'Group opportunity',
              description:  `[${groupName || group.chat_id}] ${opp.description || ''}`,
              priority:     opp.priority || 'medium',
              source_ref:   sourceRef,
              skip_intelligence: true,
            })
            if (groupId) {
              await intelligence.upsertFromGroupOpportunity(groupId, {
                id: groupId,
                wa_chat_id: group.chat_id,
                name: groupName || group.chat_id,
                group_type: analysis.group_type,
                my_role: analysis.my_role,
                last_activity_at: group.last_msg_at,
              }, opp, idx)
            }
            insightsGenerated++
          }

          if (!analysis.is_noise) {
            console.log(`   ✓ ${groupName || group.chat_id} → ${analysis.group_type} / ${analysis.my_role}`)
          }
          groupsAnalyzed++
          await analyzer.sleep(600)
        }
      } catch (err) {
        console.error(`[index] group error for ${group.chat_id}:`, err.message)
        requiredFailures.push(`group:${group.chat_id}:${err.message}`)
      }
    }
    console.log(`   Analyzed ${groupsAnalyzed} groups (of ${groups.length} total)`)

    // Limitless transcripts are canonical communications too. A bounded batch
    // per run makes historical recovery resumable without delaying fresh data.
    const missingLifelogs = await extractor.getUnstoredLimitlessConversations(500)
    const limitlessCommResult = await communication.upsertLimitlessCommunications(db, missingLifelogs)
    if (limitlessCommResult.inserted > 0) {
      console.log(`   Stored ${limitlessCommResult.inserted} Limitless communications`)
    }

    // ── 4. Generate insights ──────────────────────────────────────────────────
    console.log('\n💡 Generating insights...')

    // Awaiting reply
    const awaitingReply = await insights.findAwaitingReplyContacts()
    console.log(`   ${awaitingReply.length} contacts awaiting reply`)

    for (const contact of awaitingReply.slice(0, 20)) {
      try {
        // Find or create contact record
        const { rows: existing } = await db.query(`
          SELECT id, display_name FROM relationships.contacts
          WHERE wa_jids @> ARRAY[$1]::text[]
          LIMIT 1
        `, [contact.chat_id])

        const contactId = existing[0]?.id || null
        const name = existing[0]?.display_name || contact.display_name || formatPhoneJid(contact.chat_id)
        const daysSince = Math.round((Date.now() - new Date(contact.last_msg_at)) / 86400000)

        const bodyText = (contact.last_msg_body || '')
        const isJidBody = /^\d+@[cg]\.us$/.test(bodyText.trim())
        const displayBody = isJidBody ? '(media or system message)' : bodyText.slice(0, 120)

        const insightId = await upsertInsight(contactId, {
          insight_type: 'awaiting_reply',
          title: `Reply to ${name}`,
          description: `Last message ${daysSince}d ago: "${displayBody}"`,
          priority: daysSince > 7 ? 'high' : daysSince > 3 ? 'medium' : 'low',
          source_ref: `awaiting:${contact.chat_id}`,
          source_refs: contact.source_id ? [contact.source_id] : [],
        })
        if (insightId) insightsGenerated++
      } catch (err) {
        console.error('[index] awaiting reply insight error:', err.message)
      }
    }

    // Unread groups
    const activeGroups = await insights.findActiveGroupsNotParticipating()
    console.log(`   ${activeGroups.length} active groups not participating in`)

    for (const group of activeGroups.slice(0, 10)) {
      try {
        const rawId = group.chat_id.replace('@g.us', '')
        const groupName = await extractor.getGroupName(group.chat_id) || `Group (${rawId.length > 20 ? rawId.slice(-8) : rawId})`

        // Build sample context for richer insight description
        const sampleText = (group.sample_msgs || [])
          .slice(0, 3)
          .map(m => `"${(m.body || '').slice(0, 80)}"`)
          .join(', ')

        const insightId = await upsertInsight(null, {
          insight_type: 'unread_group',
          title: `Active group: ${groupName}`,
          description: `${group.their_msgs} messages in last 7 days, you haven't participated. Recent: ${sampleText}`,
          priority: Number(group.their_msgs) > 10 ? 'medium' : 'low',
          source_ref: `group:active:${group.chat_id}`,
          source_refs: group.source_refs || [],
        })
        if (insightId) insightsGenerated++
      } catch (err) {
        console.error('[index] unread group insight error:', err.message)
      }
    }

    // Cold / unread emails
    const coldEmails = await insights.findColdEmailsNotReplied()
    console.log(`   ${coldEmails.length} unread emails from human senders`)

    for (const em of coldEmails.slice(0, 20)) {
      try {
        // Find linked contact
        const { rows: linked } = await db.query(`
          SELECT c.id, c.display_name FROM relationships.contacts c
          JOIN relationships.email_senders es ON es.contact_id = c.id
          WHERE es.raw_address = $1 LIMIT 1
        `, [em.from_address])

        const { parseEmailAddress } = extractor
        const parsed = parseEmailAddress(em.from_address)
        const contactId = linked[0]?.id || null
        const senderName = linked[0]?.display_name || parsed.name || parsed.email

        const insightId = await upsertInsight(contactId, {
          insight_type: 'cold_email',
          title: `Unread: "${(em.subject || '(no subject)').slice(0, 60)}"`,
          description: `From ${senderName} on ${em.date ? new Date(em.date).toLocaleDateString() : 'unknown date'}. ${(em.body_text || '').slice(0, 120)}`,
          priority: 'medium',
          source_ref: `cold_email:${em.id}`,
          source_refs: [`email:${em.id}`],
        })
        if (insightId) insightsGenerated++
      } catch (err) {
        console.error('[index] cold email insight error:', err.message)
      }
    }

    // ── 4b. Opportunity swarm ─────────────────────────────────────────────────
    const swarmInsights = await opportunities.runOpportunitySwarm(lastRunAt)
    for (const insight of swarmInsights) {
      const id = await upsertInsight(insight.contact_id, insight)
      if (id) insightsGenerated++
    }
    console.log(`   Swarm generated ${swarmInsights.length} opportunity insights`)

    if (requiredFailures.length > 0) {
      throw new Error(`${requiredFailures.length} required relationship stage failure(s): ${requiredFailures.slice(0, 8).join('; ')}`)
    }

    // ── 5. Mark run complete ──────────────────────────────────────────────────
    await db.query(`
      UPDATE relationships.analysis_runs
      SET status = 'completed',
          contacts_processed = $1,
          insights_generated = $2,
          completed_at = NOW()
      WHERE id = $3
    `, [contactsProcessed + emailContactsProcessed, insightsGenerated, runId])

    console.log(`\n✅ Analysis run #${runId} complete`)
    console.log(`   Contacts processed: ${contactsProcessed}`)
    console.log(`   Insights generated: ${insightsGenerated}\n`)
    telemetryStatus = 'completed'

  } catch (err) {
    telemetryError = err.message
    console.error('❌ Analysis run failed:', err.message)
    if (runId) {
      try {
        await db.query(`
          UPDATE relationships.analysis_runs
          SET status = 'failed', error = $1, completed_at = NOW()
          WHERE id = $2
        `, [err.message, runId])
      } catch { /* ignore */ }
    }
    throw err
  } finally {
    const telemetryRunId = _runId
    _runId = null
    if (telemetry && telemetryRunId) {
      try {
        await telemetry.endRun(telemetryRunId, {
          status: telemetryStatus,
          error: telemetryError,
          contactsProcessed,
          insightsGenerated,
        })
        await telemetry.flush()
      } catch (err) {
        console.warn('[telemetry] endRun failed:', err.message)
      }
    }
    await lease.release()
  }
}

async function startAnalysis() {
  if (_analysisPromise) {
    console.log('⏭  Analysis already active in this process, skipping')
    return _analysisPromise
  }
  _analysisPromise = runAnalysis()
  try {
    return await _analysisPromise
  } finally {
    _analysisPromise = null
  }
}

// ── Schedule & start ──────────────────────────────────────────────────────────

async function main() {
  await ensureSchema()
  await cleanupOrphanedRuns(db, 'relationships')

  // Run immediately on startup
  console.log('🏁 Starting initial analysis...\n')
  await startAnalysis()

  if (RUN_ONCE) {
    await db.end()
    console.log('✅ One-shot relationships analysis complete')
    return
  }

  // Then every 6 hours
  console.log('⏰ Scheduling analysis every 6 hours')
  cron.schedule('0 */6 * * *', () => {
    console.log('⏰ Scheduled analysis triggered')
    startAnalysis().catch(err => console.error('❌ Scheduled analysis error:', err.message))
  })
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err.message)
  process.exit(1)
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})

async function shutdown() {
  if (_shutdownPromise) return _shutdownPromise
  _shutdownPromise = (async () => {
    console.log('\n🛑 Graceful shutdown requested...')
    // Do not close the pool underneath an in-flight recovery. The run owns its
    // durable status transition and is allowed to finish before process exit.
    if (_analysisPromise) await _analysisPromise.catch(() => {})
    if (telemetry) await telemetry.flush().catch(() => {})
    try {
      await db.end()
      console.log('✅ Database closed')
    } catch { /* ignore */ }
    console.log('👋 Relationships Agent stopped')
  })()
  await _shutdownPromise
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

module.exports = {
  ensureSchema,
  main,
  recoverInterruptedRuns,
  runAnalysis,
  startAnalysis,
  upsertContact,
}
