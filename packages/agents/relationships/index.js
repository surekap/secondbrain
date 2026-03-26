#!/usr/bin/env node
'use strict'

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.local') })

const cron = require('node-cron')
const db   = require('@secondbrain/db')

const extractor     = require('./services/extractor')
const analyzer      = require('./services/analyzer')
const insights      = require('./services/insights')
const opportunities = require('./services/opportunities')

console.log('🧠 Relationships Agent v1.0')
console.log('📊 Builds contact profiles from WhatsApp, Email & Limitless\n')

// ── Schema bootstrap ──────────────────────────────────────────────────────────

async function ensureSchema() {
  const fs   = require('fs')
  const path = require('path')
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, 'sql/schema.sql'), 'utf8')
    await db.query(sql)
    console.log('✅ Schema ready')
  } catch (err) {
    console.error('❌ Schema setup error:', err.message)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeName(name) {
  if (!name) return null
  return name.toLowerCase().trim().replace(/\s+/g, ' ')
}

async function upsertContact(profile, chatId) {
  const phone = chatId.replace('@c.us', '')
  const waJid = chatId

  try {
    // Try to find existing by wa_jid
    const { rows: existing } = await db.query(`
      SELECT id FROM relationships.contacts
      WHERE wa_jids @> ARRAY[$1]::text[]
         OR normalized_name = $2
      LIMIT 1
    `, [waJid, normalizeName(profile.display_name)])

    if (existing.length > 0) {
      const id = existing[0].id
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
    return inserted[0].id
  } catch (err) {
    console.error('[index] upsertContact error:', err.message)
    return null
  }
}

// Base64 JPEG thumbnails start with this prefix (FF D8 FF in base64)
const JPEG_B64_PREFIX = '/9j/'

function buildMediaSnippetAndMeta(msg) {
  const type = msg.msg_type || 'chat'
  const body = msg.body || ''

  // If body looks like a base64 JPEG thumbnail, treat as media
  const isMediaBody = body.startsWith(JPEG_B64_PREFIX) && body.length > 100

  if (type === 'image' || (isMediaBody && type !== 'chat')) {
    const caption = (msg.caption || '').trim()
    return {
      snippet:  caption || '📷 Photo',
      metadata: { msg_type: 'image', thumbnail_b64: body.slice(0, 4000) },
    }
  }
  if (type === 'video') {
    const caption = (msg.caption || '').trim()
    return {
      snippet:  caption || '🎥 Video',
      metadata: { msg_type: 'video', thumbnail_b64: body.slice(0, 4000) },
    }
  }
  if (type === 'document') {
    const name = (msg.filename || msg.caption || '').trim()
    return {
      snippet:  name ? `📎 ${name}` : '📎 Document',
      metadata: { msg_type: 'document', filename: msg.filename || null, thumbnail_b64: body.slice(0, 4000) },
    }
  }
  if (type === 'ptt' || type === 'audio') {
    return { snippet: '🎤 Voice message', metadata: { msg_type: type } }
  }
  if (type === 'sticker') {
    return { snippet: '🎴 Sticker', metadata: { msg_type: 'sticker' } }
  }
  if (type === 'location') {
    return { snippet: '📍 Location', metadata: { msg_type: 'location' } }
  }
  if (type === 'vcard') {
    return { snippet: '👤 Contact card', metadata: { msg_type: 'vcard' } }
  }

  // Plain text
  return { snippet: body.slice(0, 300), metadata: { msg_type: type || 'chat' } }
}

async function upsertCommunications(contactId, messages, chatId) {
  let count = 0
  for (const msg of messages.slice(0, 50)) {
    if (!msg.body) continue
    try {
      const sourceId = `wa:${chatId}:${msg.ts ? new Date(msg.ts).getTime() : Math.random()}`
      const { snippet, metadata } = buildMediaSnippetAndMeta(msg)
      await db.query(`
        INSERT INTO relationships.communications (
          contact_id, source, source_id, direction,
          content_snippet, chat_id, is_group, occurred_at, metadata
        ) VALUES ($1, 'whatsapp', $2, $3, $4, $5, false, $6, $7)
        ON CONFLICT (source, source_id, contact_id) DO UPDATE SET
          content_snippet = EXCLUDED.content_snippet,
          metadata        = EXCLUDED.metadata
      `, [
        contactId,
        sourceId,
        msg.from_me ? 'outbound' : 'inbound',
        snippet,
        chatId,
        msg.ts,
        JSON.stringify(metadata),
      ])
      count++
    } catch (err) {
      // ignore
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
      if (exists.length > 0) return exists[0].id
    }

    const contactIds = Array.isArray(insightData.contact_ids) ? insightData.contact_ids : []

    const { rows } = await db.query(`
      INSERT INTO relationships.insights (
        contact_id, insight_type, title, description, priority, source_ref, contact_ids
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      contactId,
      insightData.insight_type,
      insightData.title,
      insightData.description,
      insightData.priority || 'medium',
      insightData.source_ref || null,
      contactIds,
    ])
    return rows[0]?.id || null
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

// ── Check if analysis is running ──────────────────────────────────────────────

async function isAnalysisRunning() {
  try {
    const { rows } = await db.query(`
      SELECT id FROM relationships.analysis_runs
      WHERE status = 'running'
        AND started_at > NOW() - INTERVAL '2 hours'
      LIMIT 1
    `)
    return rows.length > 0
  } catch { return false }
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function runAnalysis() {
  const alreadyRunning = await isAnalysisRunning()
  if (alreadyRunning) {
    console.log('⏭  Analysis already running, skipping')
    return
  }

  let runId = null
  let contactsProcessed = 0
  let insightsGenerated = 0

  try {
    // Get incremental watermark
    const lastRunAt = await getLastRunAt()
    if (lastRunAt) {
      console.log(`⏱  Incremental mode: processing new activity since ${lastRunAt.toISOString()}`)
    } else {
      console.log('🆕 First run: full analysis')
    }

    // Create run record
    const { rows } = await db.query(`
      INSERT INTO relationships.analysis_runs (status) VALUES ('running') RETURNING id
    `)
    runId = rows[0].id
    console.log(`\n🔍 Starting analysis run #${runId}`)

    // ── 1. Extract direct chat contacts ──────────────────────────────────────
    console.log('📱 Extracting WhatsApp direct contacts...')
    const directContacts = await extractor.extractDirectChatContacts()
    console.log(`   Found ${directContacts.length} direct chat contacts`)

    // Filter: skip contacts with no new messages since last run (if incremental)
    const meaningfulContacts = directContacts.filter(c => {
      const total = Number(c.msg_count)
      if (total < 3 && !c.display_name) return false
      // Incremental: skip if last message is older than last run
      if (lastRunAt && c.last_msg_at && new Date(c.last_msg_at) <= lastRunAt) return false
      return true
    })
    console.log(`   Processing ${meaningfulContacts.length} contacts with new activity`)

    // ── 2. Process in batches of 5 ───────────────────────────────────────────
    const BATCH_SIZE = 5
    const BATCH_DELAY = 2000

    for (let i = 0; i < meaningfulContacts.length; i += BATCH_SIZE) {
      const batch = meaningfulContacts.slice(i, i + BATCH_SIZE)
      console.log(`   Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(meaningfulContacts.length / BATCH_SIZE)} (contacts ${i + 1}–${Math.min(i + BATCH_SIZE, meaningfulContacts.length)})`)

      for (const contact of batch) {
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

          if (existingId && lastRunAt) {
            // Existing contact: just add new messages, skip Claude
            const newMessages = messages.filter(m => m.ts && new Date(m.ts) > lastRunAt)
            if (newMessages.length > 0) {
              const added = await upsertCommunications(existingId, newMessages, contact.chat_id)
              if (added > 0) {
                await db.query(`
                  UPDATE relationships.contacts SET
                    last_interaction_at = GREATEST(last_interaction_at, $1),
                    updated_at          = NOW()
                  WHERE id = $2
                `, [contact.last_msg_at, existingId])
                console.log(`   ↑ ${contact.display_name || contact.chat_id} (+${added} new messages)`)
                contactsProcessed++
              }
            }
          } else {
            // New contact (or first run): full Claude analysis
            const hasMeaningfulContent = messages.some(m => m.body && m.body.length > 5)
            if (!hasMeaningfulContent && !contact.display_name) continue

            // Fetch existing manual overrides so Claude respects user-confirmed facts
            let existingOverrides = {}
            if (existingId) {
              const { rows: orRows } = await db.query(
                'SELECT manual_overrides FROM relationships.contacts WHERE id = $1', [existingId]
              )
              existingOverrides = orRows[0]?.manual_overrides || {}
            }

            const profile = await analyzer.analyzeDirectChatContact(contact.chat_id, contact, messages, existingOverrides)
            profile.last_msg_at  = contact.last_msg_at
            profile.first_msg_at = contact.first_msg_at

            const contactId = await upsertContact(profile, contact.chat_id)
            if (!contactId) continue

            await upsertCommunications(contactId, messages, contact.chat_id)
            contactsProcessed++

            if (!profile.is_noise) {
              console.log(`   ✓ NEW ${profile.display_name} (${profile.relationship_type}, ${profile.relationship_strength})`)
            }

            // Only delay after Claude calls
            await analyzer.sleep(500)
          }
        } catch (err) {
          console.error(`   ✗ Error processing ${contact.chat_id}:`, err.message)
        }
      }

      // Delay between batches (except last)
      if (i + BATCH_SIZE < meaningfulContacts.length) {
        await analyzer.sleep(BATCH_DELAY)
      }

      // Update progress
      await db.query(`
        UPDATE relationships.analysis_runs
        SET contacts_processed = $1
        WHERE id = $2
      `, [contactsProcessed, runId])
    }

    // ── 3. Process email contacts ─────────────────────────────────────────────
    console.log('\n📧 Processing email contacts...')
    const emailSenders = await extractor.getEmailContacts()
    const NOISE_EMAIL_PATTERNS = [/noreply/i, /no-reply/i, /donotreply/i, /notification/i,
      /alert/i, /newsletter/i, /marketing/i, /mailer/i, /support@/i, /bounce/i, /postmaster/i]

    // Incremental: skip senders with no new emails since last run
    const activeSenders = lastRunAt
      ? emailSenders.filter(s => !s.last_email_at || new Date(s.last_email_at) > lastRunAt)
      : emailSenders
    console.log(`   ${activeSenders.length} senders with new activity (of ${emailSenders.length} total)`)

    let emailContactsProcessed = 0
    for (const sender of activeSenders) {
      if (!sender.parsed_email) continue
      const isNoise = NOISE_EMAIL_PATTERNS.some(p => p.test(sender.raw_address))

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

        // Try to link to an existing contact by email or name
        const { rows: existingByEmail } = await db.query(`
          SELECT id FROM relationships.contacts WHERE emails @> ARRAY[$1]::text[] LIMIT 1
        `, [sender.email])

        let contactId = existingByEmail[0]?.id || null
        let isNew = !contactId

        if (!contactId && sender.name) {
          const { rows: existingByName } = await db.query(`
            SELECT id FROM relationships.contacts WHERE normalized_name = $1 LIMIT 1
          `, [normalizeName(sender.name)])
          contactId = existingByName[0]?.id || null
          if (contactId) isNew = false
        }

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

        // Link email_sender to contact
        await db.query(`
          UPDATE relationships.email_senders SET contact_id = $1 WHERE raw_address = $2
        `, [contactId, sender.from_address])

        // Upsert recent emails as communications (only new ones for existing contacts)
        const emails = await extractor.getEmailsBySender(sender.from_address, 20)
        const emailsToProcess = (lastRunAt && !isNew)
          ? emails.filter(e => !e.date || new Date(e.date) > lastRunAt)
          : emails
        for (const em of emailsToProcess) {
          const snippet = (em.body_text || em.subject || '').replace(/\s+/g, ' ').slice(0, 280)
          try {
            await db.query(`
              INSERT INTO relationships.communications
                (contact_id, source, source_id, direction, content_snippet, subject,
                 is_read, occurred_at)
              VALUES ($1, 'email', $2, 'inbound', $3, $4, $5, $6)
              ON CONFLICT (source, source_id, contact_id) DO NOTHING
            `, [contactId, `email:${em.id}`, snippet, em.subject, em.is_read, em.date])
          } catch { /* ignore duplicate */ }
        }

        emailContactsProcessed++
      } catch (err) {
        console.error(`[index] email contact error for ${sender.from_address}:`, err.message)
      }
    }
    console.log(`   Processed ${emailContactsProcessed} email contacts`)

    // ── 3b. Process WhatsApp groups ───────────────────────────────────────────
    console.log('\n👥 Processing WhatsApp groups...')
    const groups = await extractor.extractGroupChats()
    let groupsAnalyzed = 0

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
          SELECT analyzed_at FROM relationships.groups WHERE wa_chat_id = $1
        `, [group.chat_id])
        const analyzedAt = existing[0]?.analyzed_at

        const hasNewActivity = !analyzedAt ||
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

          // Surface group opportunities as insights
          for (const opp of (analysis.opportunities || []).slice(0, 3)) {
            await upsertInsight(null, {
              insight_type: 'opportunity',
              title:        opp.title || 'Group opportunity',
              description:  `[${groupName || group.chat_id}] ${opp.description || ''}`,
              priority:     opp.priority || 'medium',
            })
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
      }
    }
    console.log(`   Analyzed ${groupsAnalyzed} groups (of ${groups.length} total)`)

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
        const name = existing[0]?.display_name || contact.display_name || contact.chat_id.replace('@c.us', '')
        const daysSince = Math.round((Date.now() - new Date(contact.last_msg_at)) / 86400000)

        const insightId = await upsertInsight(contactId, {
          insight_type: 'awaiting_reply',
          title: `Reply to ${name}`,
          description: `Last message ${daysSince}d ago: "${(contact.last_msg_body || '').slice(0, 120)}"`,
          priority: daysSince > 7 ? 'high' : daysSince > 3 ? 'medium' : 'low',
          source_ref: `awaiting:${contact.chat_id}`,
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
        const groupName = await extractor.getGroupName(group.chat_id) || group.chat_id

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

  } catch (err) {
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
  }
}

// ── Schedule & start ──────────────────────────────────────────────────────────

async function main() {
  await ensureSchema()

  // Run immediately on startup
  console.log('🏁 Starting initial analysis...\n')
  await runAnalysis()

  // Then every 6 hours
  console.log('⏰ Scheduling analysis every 6 hours')
  cron.schedule('0 */6 * * *', () => {
    console.log('⏰ Scheduled analysis triggered')
    runAnalysis().catch(err => console.error('❌ Scheduled analysis error:', err.message))
  })
}

main().catch(err => {
  console.error('❌ Fatal startup error:', err.message)
  process.exit(1)
})

process.on('SIGINT', async () => {
  console.log('\n🛑 Graceful shutdown...')
  try {
    await db.end()
    console.log('✅ Database closed')
  } catch { /* ignore */ }
  console.log('👋 Relationships Agent stopped')
  process.exit(0)
})
