'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getConfig } = require('../../agents/shared/config');
const { DEFAULT_OLLAMA_BASE_URL } = require('../../agents/shared/model-catalog');
const { ollamaRequest } = require('../../agents/shared/ollama');

const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_MODEL = 'gemini-embedding-2-preview';

// ── Provider configs ──────────────────────────────────────────────────────────

const PROVIDER_DEFAULTS = {
  gemini:  { model: 'gemini-embedding-2-preview', dims: 3072 },
  ollama:  { model: 'nomic-embed-text',           dims: 768  },
  openai:  { model: 'text-embedding-3-small',     dims: 1536 },
  jina:    { model: 'jina-embeddings-v2-base-en', dims: 768  },
};

async function getEmbeddingConfig() {
  const providerType = await getConfig('system.EMBEDDING_PROVIDER')
    || process.env.EMBEDDING_PROVIDER
    || DEFAULT_PROVIDER;

  const defaults = PROVIDER_DEFAULTS[providerType] || PROVIDER_DEFAULTS[DEFAULT_PROVIDER];

  return {
    providerType,
    model: await getConfig('system.EMBEDDING_MODEL')
      || process.env.EMBEDDING_MODEL
      || defaults.model,
    geminiApiKey: await getConfig('system.GEMINI_API_KEY')
      || process.env.GEMINI_API_KEY
      || '',
    openaiApiKey: await getConfig('system.OPENAI_API_KEY')
      || process.env.OPENAI_API_KEY
      || '',
    jinaApiKey: await getConfig('system.JINA_API_KEY')
      || process.env.JINA_API_KEY
      || '',
    ollamaBaseUrl: await getConfig('system.OLLAMA_BASE_URL')
      || process.env.OLLAMA_BASE_URL
      || DEFAULT_OLLAMA_BASE_URL,
  };
}

// ── Gemini ────────────────────────────────────────────────────────────────────

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

// ── Ollama ────────────────────────────────────────────────────────────────────

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

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function embedWithOpenAI(modelName, apiKey, texts) {
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const CHUNK = 2048; // OpenAI batch limit
  const results = [];

  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        input: slice.map(t => t.slice(0, 8000)),
        encoding_format: 'float',
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI embedding error ${resp.status}: ${err.slice(0, 300)}`);
    }

    const data = await resp.json();
    const embeddings = data.data.map(d => d.embedding);
    results.push(...embeddings);
  }

  return results;
}

// ── Jina AI ───────────────────────────────────────────────────────────────────

async function embedWithJina(modelName, apiKey, texts) {
  // Jina has a generous free tier (1M tokens/day); key is optional for low usage
  const CHUNK = 2048;
  const results = [];
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const resp = await fetch('https://api.jina.ai/v1/embeddings', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        input: slice.map(t => t.slice(0, 8000)),
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Jina embedding error ${resp.status}: ${err.slice(0, 300)}`);
    }

    const data = await resp.json();
    const embeddings = data.data.map(d => d.embedding);
    results.push(...embeddings);
  }

  return results;
}

// ── Fallback dispatcher ───────────────────────────────────────────────────────

async function embedWithProvider(config, texts, taskType) {
  switch (config.providerType) {
    case 'ollama':
      return embedWithOllama(config.model, config.ollamaBaseUrl, texts);
    case 'openai':
      return embedWithOpenAI(config.model, config.openaiApiKey, texts);
    case 'jina':
      return embedWithJina(config.model, config.jinaApiKey, texts);
    case 'gemini':
    default:
      return embedWithGemini(config.model, config.geminiApiKey, texts, taskType);
  }
}

/**
 * Try the configured provider; on failure, fall back through a priority list.
 * Priority: openai → jina → gemini → ollama
 */
async function embedBatchWithFallback(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const config = await getEmbeddingConfig();
  const providersToTry = [];

  // Always try the configured provider first
  providersToTry.push(config.providerType);

  // Then try cloud providers in priority order. Do not use Ollama here: local embeddings
  // make Prateek's Mac unusable during large indexing jobs.
  const fallbackOrder = ['jina', 'openai', 'gemini'];
  for (const p of fallbackOrder) {
    if (!providersToTry.includes(p)) providersToTry.push(p);
  }

  const errors = [];
  for (const providerType of providersToTry) {
    try {
      const attemptConfig = { ...config, providerType };
      const embeddings = await embedWithProvider(attemptConfig, texts, taskType);
      if (embeddings.length !== texts.length) {
        throw new Error(`Embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`);
      }
      // Return which provider succeeded so the caller can log it
      return { embeddings, providerUsed: providerType, modelUsed: PROVIDER_DEFAULTS[providerType]?.model || config.model };
    } catch (err) {
      const msg = `[embed:${providerType}] ${err.message}`;
      console.warn(msg);
      errors.push(msg);
    }
  }

  throw new Error(`All embedding providers failed:\n${errors.join('\n')}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a single embedding.
 * taskType: 'RETRIEVAL_DOCUMENT' (indexing) | 'RETRIEVAL_QUERY' (searching)
 */
async function embed(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const { embeddings } = await embedBatchWithFallback([text], taskType);
  return embeddings[0];
}

/**
 * Embed multiple texts with fallback across providers.
 * Returns { embeddings: number[][], providerUsed: string, modelUsed: string }
 */
async function embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  return embedBatchWithFallback(texts, taskType);
}

/**
 * Format an embedding array as a pgvector literal: '[0.1,0.2,...]'
 */
function toSql(vec) {
  return '[' + vec.join(',') + ']';
}

module.exports = { embed, embedBatch, toSql, DEFAULT_MODEL, DEFAULT_PROVIDER, getEmbeddingConfig };
