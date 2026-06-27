const test = require('node:test')
const assert = require('node:assert/strict')
const { embeddingAttemptConfig } = require('../embedder')

test('embedding fallback uses provider default model when configured model belongs to failed provider', () => {
  const config = {
    providerType: 'jina',
    model: 'jina-embeddings-v2-base-en',
  }

  assert.equal(embeddingAttemptConfig(config, 'jina').model, 'jina-embeddings-v2-base-en')
  assert.equal(embeddingAttemptConfig(config, 'openai').model, 'text-embedding-3-small')
  assert.equal(embeddingAttemptConfig(config, 'gemini').model, 'gemini-embedding-2-preview')
})

test('embedding fallback preserves custom model when it is not the configured provider default', () => {
  const config = {
    providerType: 'jina',
    model: 'custom-shared-embedding-model',
  }

  assert.equal(embeddingAttemptConfig(config, 'openai').model, 'custom-shared-embedding-model')
})
