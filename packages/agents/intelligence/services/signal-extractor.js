const crypto = require('crypto');

const SIGNAL_PATTERNS = {
  need: [
    /\b(need|help|looking for|require|urgent|stuck)\b/i,
    /\b(struggling|difficult|challenge|problem|issue)\b/i,
    /\b(advice|guidance|recommendation|suggestion)\b/i,
  ],
  offer: [
    /\b(can help|expertise|happy to|would be glad|offer|available)\b/i,
    /\b(good at|specialized in|experienced with|know a lot about)\b/i,
    /\b(introduce|connect|recommend)\b/i,
  ],
  event: [
    /\b(happening|upcoming|event|conference|meeting|workshop|launch|release)\b/i,
    /\b(scheduled|planned|coming|due|deadline)\b/i,
  ],
  risk: [
    /\b(risk|danger|concern|worried|anxious|issue|problem|bug|broken|fail|crash|blocked|delay)\b/i,
    /\b(vulnerable|security|compliance|threat|certificate|expiry|rotation)\b/i,
  ],
  location: [
    /\b(visiting|traveling to|moving to|based in|located in|trip to)\b/i,
    /\b(africa|kenya|nairobi|munich|dubai|india|singapore|london|mumbai|hyderabad)\b/i,
  ],
  capability: [
    /\b(built|created|developed|designed|wrote|implemented|deployed|launched)\b/i,
    /\b(expert|specialist|master|proficient|skilled in|director|head of|founder|partner)\b/i,
  ],
  interest: [
    /\b(interested in|passionate about|fascinated by|curious about|exploring)\b/i,
    /\b(love|enjoy|enthusiastic about)\b/i,
  ],
  intent: [
    /\b(planning to|going to|will|intend|want to|trying to|aiming to|arrange|review|send|book)\b/i,
    /\b(considering|thinking about|exploring the idea)\b/i,
  ],
};

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function compactText(value, max = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  const wellFormed = typeof normalized.toWellFormed === 'function'
    ? normalized.toWellFormed()
    : normalized.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
  // Slice by Unicode code point. UTF-16 slicing can split an emoji surrogate
  // pair, which JavaScript accepts but PostgreSQL correctly rejects as JSON.
  return Array.from(wellFormed).slice(0, max).join('');
}

function parseWhatsappTimestamp(record) {
  const raw = record.ts || record.occurred_at || record.timestamp || record.data?.timestamp || record.data?.t;
  if (!raw) return record.created_at || null;
  if (typeof raw === 'number') return new Date(raw < 10_000_000_000 ? raw * 1000 : raw);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? (record.created_at || null) : parsed;
}

function extractText(record, sourceTable) {
  switch (sourceTable) {
    case 'email':
      return compactText(`${record.subject || ''} ${record.content_snippet || record.body_text || record.body || ''}`, 4000);
    case 'whatsapp':
      return compactText(record.content_snippet || record.body || record.text || record.message || record.data?.body || record.data?.text || record.data?.message || '', 4000);
    case 'limitless':
      return compactText(record.content_snippet || record.transcript || record.markdown || record.summary || record.title || record.message_text || '', 4000);
    case 'groups':
      return compactText(`${record.name || ''} ${record.summary || record.ai_summary || ''} ${JSON.stringify(record.key_topics || [])} ${JSON.stringify(record.opportunities || [])}`, 4000);
    case 'opportunities':
      return compactText(`${record.title || ''} ${record.description || ''} ${record.why_now || ''}`, 4000);
    default:
      return compactText(record.text || record.body || record.summary || '', 4000);
  }
}

function sourceId(record, sourceTable) {
  if (record.canonical_table === 'relationships.communications' && record.id != null) return String(record.id);
  if (record.source_id != null) return String(record.source_id);
  if (record.id != null) return String(record.id);
  if (record.wa_msg_id) return String(record.wa_msg_id);
  return stableHash(`${sourceTable}:${extractText(record, sourceTable).slice(0, 100)}`);
}

function signalSourceRef(sourceTable, id, signalType) {
  const stableId = String(id)
  return stableId.startsWith(`${sourceTable}:`)
    ? `${stableId}:${signalType}`
    : `${sourceTable}:${stableId}:${signalType}`
}

function occurredAt(record, sourceTable) {
  switch (sourceTable) {
    case 'email': return record.occurred_at || record.date || record.received_at || record.created_at || null;
    case 'whatsapp': return parseWhatsappTimestamp(record);
    case 'limitless': return record.occurred_at || record.start_time || record.started_at || record.created_at || null;
    case 'groups': return record.updated_at || record.created_at || null;
    case 'opportunities': return record.source_last_seen_at || record.last_seen_at || record.created_at || null;
    default: return record.occurred_at || record.created_at || null;
  }
}

function extractContactId(record, sourceTable) {
  if (record.contact_id && Number.isFinite(Number(record.contact_id))) return Number(record.contact_id);
  if (record.primary_contact_id && Number.isFinite(Number(record.primary_contact_id))) return Number(record.primary_contact_id);
  return null;
}

function extractProjectId(record) {
  if (record.project_id && Number.isFinite(Number(record.project_id))) return Number(record.project_id);
  if (record.primary_project_id && Number.isFinite(Number(record.primary_project_id))) return Number(record.primary_project_id);
  return null;
}

function confidenceFor(signalType, record, sourceTable) {
  let confidence = 0.55;
  if (sourceTable === 'opportunities') confidence += 0.2;
  if (sourceTable === 'email' && (record.subject || record.content_snippet || record.body_text)) confidence += 0.1;
  if (signalType === 'risk' || signalType === 'need' || signalType === 'intent') confidence += 0.05;
  return Math.min(confidence, 0.9);
}

function strengthFor(signalType, text, sourceTable) {
  let strength = 45;
  if (text.length > 300) strength += 5;
  if (sourceTable === 'opportunities') strength += 15;
  if (signalType === 'risk' || signalType === 'need') strength += 5;
  return Math.min(strength, 85);
}

function claimSemantics(text, pattern) {
  const index = text.search(pattern)
  const window = text.slice(Math.max(0, index - 80), Math.max(0, index) + 180)
  const contradicted = /\b(?:no|not|never|without|cancel(?:led)?|resolved|fixed|completed|done|no longer|didn't|did not)\b/i.test(window)
  return {
    polarity: contradicted ? 'negative' : 'positive',
    lifecycle_state: contradicted ? 'resolved' : 'active',
    evidence_quote: compactText(window, 300),
  }
}

function isSkippableOpportunity(record) {
  if (record?.source_ref && /^(cross_channel_project|email_thread):/i.test(String(record.source_ref))) return true;
  if (record?.primary_contact_name && /\bprateek\s+sureka\b/i.test(String(record.primary_contact_name))) return true;
  return true; // Opportunities are outputs, not raw evidence. Never feed them back into weak-signal extraction.
}

async function extractSignals(records, sourceTable) {
  const signals = [];
  const seen = new Set();

  for (const record of records || []) {
    if (sourceTable === 'opportunities' && isSkippableOpportunity(record)) continue;
    const text = extractText(record, sourceTable);
    if (!text) continue;
    const id = sourceId(record, sourceTable);
    const at = occurredAt(record, sourceTable);

    for (const [signalType, patterns] of Object.entries(SIGNAL_PATTERNS)) {
      const matched = patterns.find(pattern => pattern.test(text));
      if (!matched) continue;

      const sourceIdHash = stableHash(`${sourceTable}:${id}:${signalType}`);
      if (seen.has(sourceIdHash)) continue;
      const semantics = claimSemantics(text, matched);

      signals.push({
        contact_id: extractContactId(record, sourceTable),
        project_id: extractProjectId(record),
        signal_type: signalType,
        title: `${signalType}: ${compactText(record.subject || record.title || record.name || text, 90)}`,
        content: compactText(text, 500),
        description: compactText(text, 500),
        metadata: {
          matched_pattern: matched.source,
          source_kind: sourceTable,
          direction: record.direction || null,
          author_jid: record.metadata?.author_jid || null,
          canonical_source_ref: record.canonical_table === 'relationships.communications' ? record.source_id || null : null,
          ...semantics,
        },
        ...semantics,
        source_table: record.canonical_table || sourceTable,
        source_id: id,
        source_ref: signalSourceRef(sourceTable, id, signalType),
        source_id_hash: sourceIdHash,
        occurred_at: at,
        confidence: confidenceFor(signalType, record, sourceTable),
        strength: strengthFor(signalType, text, sourceTable),
        created_at: new Date(),
      });
      seen.add(sourceIdHash);
    }
  }

  return signals;
}

module.exports = { extractSignals, extractText, occurredAt };
