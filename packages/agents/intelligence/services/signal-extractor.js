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
    /\b(risk|danger|concern|worried|anxious|issue|problem|bug|broken|fail|crash)\b/i,
    /\b(vulnerable|security|compliance|threat)\b/i,
  ],
  location: [
    /\b(visiting|traveling to|moving to|based in|located in|visiting|trip to)\b/i,
    /\b(city|country|region|office|headquarters|based at)\b/i,
  ],
  capability: [
    /\b(built|created|developed|designed|wrote|implemented|deployed|launched)\b/i,
    /\b(expert|specialist|master|proficient|skilled in)\b/i,
  ],
  interest: [
    /\b(interested in|passionate about|fascinated by|curious about|exploring)\b/i,
    /\b(love|enjoy|enthusiastic about)\b/i,
  ],
  intent: [
    /\b(planning to|going to|will|intend|want to|trying to|aiming to)\b/i,
    /\b(considering|thinking about|exploring the idea)\b/i,
  ],
};

async function extractSignals(records, sourceTable) {
  const signals = [];
  const seen = new Set();

  for (const record of records) {
    const text = extractText(record, sourceTable);
    if (!text) continue;

    for (const [signalType, patterns] of Object.entries(SIGNAL_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          const contentSnippet = text.substring(0, 500);
          const sourceIdHash = crypto
            .createHash('sha256')
            .update(`${sourceTable}:${record.id}:${signalType}`)
            .digest('hex');

          if (!seen.has(sourceIdHash)) {
            signals.push({
              contact_id: record.contact_id || extractContactId(record, sourceTable),
              signal_type: signalType,
              content: contentSnippet,
              metadata: { matched_pattern: pattern.source },
              source_table: sourceTable,
              source_id: record.id,
              source_id_hash: sourceIdHash,
              created_at: new Date(),
            });
            seen.add(sourceIdHash);
            break;
          }
        }
      }
    }
  }

  return signals;
}

function extractText(record, sourceTable) {
  switch (sourceTable) {
    case 'email':
      return `${record.subject || ''} ${record.body || ''}`;
    case 'whatsapp':
      return record.body || '';
    case 'limitless':
      return record.transcript || record.summary || '';
    case 'groups':
      return record.name || '';
    default:
      return '';
  }
}

function extractContactId(record, sourceTable) {
  switch (sourceTable) {
    case 'email':
      return record.from_addr;
    case 'whatsapp':
      return record.chat_id;
    case 'limitless':
      return record.contact_id;
    case 'groups':
      return null;
    default:
      return null;
  }
}

module.exports = { extractSignals };
