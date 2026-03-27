'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getConfig } = require('../../agents/shared/config');

const DEFAULT_MODEL = 'gemini-embedding-2-preview';
const DIMS  = 3072;

async function getModel() {
  return await getConfig('system.EMBEDDING_MODEL') || process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
}

async function getClient() {
  const key = await getConfig('system.GEMINI_API_KEY') || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');
  return new GoogleGenerativeAI(key);
}

/**
 * Generate a single embedding.
 * taskType: 'RETRIEVAL_DOCUMENT' (indexing) | 'RETRIEVAL_QUERY' (searching)
 */
async function embed(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const client = await getClient();
  const model = client.getGenerativeModel({ model: await getModel() });
  const result = await model.embedContent({
    content:  { parts: [{ text: text.slice(0, 8000) }], role: 'user' },
    taskType,
  });
  return result.embedding.values;
}

/**
 * Embed multiple texts in batches of 100 (Gemini API limit per request).
 * Much faster than calling embed() in a loop — one round trip per 100 texts.
 */
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const client = await getClient();
  const model = client.getGenerativeModel({ model: await getModel() });
  const CHUNK   = 100;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const { embeddings } = await model.batchEmbedContents({
      requests: slice.map(text => ({
        content:  { parts: [{ text: text.slice(0, 8000) }], role: 'user' },
        taskType,
      })),
    });
    results.push(...embeddings.map(e => e.values));
  }
  return results;
}

/**
 * Format an embedding array as a pgvector literal: '[0.1,0.2,...]'
 */
function toSql(vec) {
  return '[' + vec.join(',') + ']';
}

module.exports = { embed, embedBatch, toSql, DIMS, DEFAULT_MODEL };
