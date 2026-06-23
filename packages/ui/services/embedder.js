'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getConfig } = require('../../agents/shared/config');
const { DEFAULT_OLLAMA_BASE_URL } = require('../../agents/shared/model-catalog');
const { ollamaRequest } = require('../../agents/shared/ollama');

const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_MODEL = 'gemini-embedding-2-preview';

async function getEmbeddingConfig() {
  return {
    providerType: await getConfig('system.EMBEDDING_PROVIDER') || process.env.EMBEDDING_PROVIDER || DEFAULT_PROVIDER,
    model: await getConfig('system.EMBEDDING_MODEL') || process.env.EMBEDDING_MODEL || DEFAULT_MODEL,
    geminiApiKey: await getConfig('system.GEMINI_API_KEY') || process.env.GEMINI_API_KEY || '',
    ollamaBaseUrl: await getConfig('system.OLLAMA_BASE_URL') || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  };
}

async function embedWithGemini(modelName, apiKey, texts, taskType) {
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });

  if (texts.length === 1) {
    const result = await model.embedContent({
      content: { parts: [{ text: texts[0].slice(0, 8000) }], role: 'user' },
      taskType,
    });
    return [result.embedding.values];
  }

  const CHUNK = 100;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const { embeddings } = await model.batchEmbedContents({
      requests: slice.map(text => ({
        content: { parts: [{ text: text.slice(0, 8000) }], role: 'user' },
        taskType,
      })),
    });
    results.push(...embeddings.map(embedding => embedding.values));
  }
  return results;
}

async function embedWithOllama(modelName, baseUrl, texts) {
  const response = await ollamaRequest({
    baseUrl,
    path: '/api/embed',
    body: {
      model: modelName,
      input: texts.map(text => text.slice(0, 8000)),
      truncate: true,
    },
  });
  return Array.isArray(response.embeddings) ? response.embeddings : [];
}

/**
 * Generate a single embedding.
 * taskType: 'RETRIEVAL_DOCUMENT' (indexing) | 'RETRIEVAL_QUERY' (searching)
 */
async function embed(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const [embedding] = await embedBatch([text], taskType);
  return embedding;
}

/**
 * Embed multiple texts with the configured provider.
 */
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const config = await getEmbeddingConfig();
  if (config.providerType === 'ollama') {
    return embedWithOllama(config.model, config.ollamaBaseUrl, texts);
  }
  return embedWithGemini(config.model, config.geminiApiKey, texts, taskType);
}

/**
 * Format an embedding array as a pgvector literal: '[0.1,0.2,...]'
 */
function toSql(vec) {
  return '[' + vec.join(',') + ']';
}

module.exports = { embed, embedBatch, toSql, DEFAULT_MODEL, DEFAULT_PROVIDER, getEmbeddingConfig };
