'use strict'

const https = require('https')
const { getConfig } = require('./config')
const { getStaticModels } = require('./model-catalog')
const { getOpenRouterModels } = require('./openrouter-catalog')

/**
 * Fetch available models from the Anthropic API.
 * Anthropic API endpoint: GET https://api.anthropic.com/v1/models
 *
 * @param {string} apiKey - The Anthropic API key
 * @returns {Promise<Array>} Array of model objects with { label, value, provider_type, capabilities }
 */
async function fetchAnthropicModels(apiKey) {
  if (!apiKey) {
    console.warn('[model-fetcher] Anthropic API key not configured, using static models')
    return getStaticModels({ providerType: 'anthropic' })
  }

  try {
    return await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/models',
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              throw new Error(`Anthropic API returned ${res.statusCode}`)
            }
            const json = JSON.parse(data)
            const models = Array.isArray(json.data) ? json.data : []
            const formatted = models.map(model => ({
              label: model.display_name || model.id,
              value: model.id,
              provider_type: 'anthropic',
              capabilities: ['chat'],
            }))
            resolve(formatted)
          } catch (error) {
            reject(error)
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(5000, () => {
        req.destroy()
        reject(new Error('Anthropic API request timeout'))
      })
      req.end()
    })
  } catch (error) {
    console.warn(`[model-fetcher] Failed to fetch Anthropic models: ${error.message}, using static models`)
    return getStaticModels({ providerType: 'anthropic' })
  }
}

/**
 * Fetch available models from the OpenAI API.
 * Uses the OpenAI SDK client.
 *
 * @param {string} apiKey - The OpenAI API key
 * @returns {Promise<Array>} Array of model objects with { label, value, provider_type, capabilities }
 */
async function fetchOpenAIModels(apiKey) {
  if (!apiKey) {
    console.warn('[model-fetcher] OpenAI API key not configured, using static models')
    return getStaticModels({ providerType: 'openai' })
  }

  try {
    const OpenAI = require('openai')
    const client = new OpenAI({ apiKey })
    const response = await client.models.list()

    const models = []
    for await (const model of response) {
      // Filter for only chat and text models that are commonly used
      if (!model.id) continue

      // Skip models that are not suitable for chat (e.g., training models, embeddings)
      if (model.id.includes('embed') || model.id.includes('embedding') || model.id === 'text-embedding') {
        continue
      }

      // Determine capabilities
      const capabilities = []
      if (model.id.includes('gpt') || model.id.includes('davinci') || model.id.includes('turbo')) {
        capabilities.push('chat')
      }

      models.push({
        label: model.id,
        value: model.id,
        provider_type: 'openai',
        capabilities: capabilities.length > 0 ? capabilities : ['chat'],
      })
    }

    // Sort alphabetically
    return models.sort((a, b) => a.value.localeCompare(b.value))
  } catch (error) {
    console.warn(`[model-fetcher] Failed to fetch OpenAI models: ${error.message}, using static models`)
    return getStaticModels({ providerType: 'openai' })
  }
}

const FALLBACK_GEMINI_EMBEDDING_MODEL = {
  label: 'Gemini Embedding 2',
  value: 'gemini-embedding-2',
  provider_type: 'gemini',
  capabilities: ['embeddings'],
}

/**
 * Fetch available embedding models from the Gemini API.
 * Gemini API endpoint: GET https://generativelanguage.googleapis.com/v1beta/models
 *
 * @param {string} apiKey - The Gemini API key
 * @returns {Promise<Array>} Array of model objects with { label, value, provider_type, capabilities }
 */
async function fetchGeminiModels(apiKey) {
  if (!apiKey) {
    console.warn('[model-fetcher] Gemini API key not configured, using fallback model')
    return [FALLBACK_GEMINI_EMBEDDING_MODEL]
  }

  try {
    return await new Promise((resolve, reject) => {
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        method: 'GET',
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              throw new Error(`Gemini API returned ${res.statusCode}`)
            }
            const json = JSON.parse(data)
            const models = Array.isArray(json.models) ? json.models : []
            const embeddingModels = models.filter(model =>
              Array.isArray(model.supportedGenerationMethods) &&
              model.supportedGenerationMethods.includes('embedContent')
            )
            const formatted = embeddingModels.map(model => ({
              label: model.displayName || model.name,
              value: String(model.name || '').replace(/^models\//, ''),
              provider_type: 'gemini',
              capabilities: ['embeddings'],
            }))
            resolve(formatted.length > 0 ? formatted : [FALLBACK_GEMINI_EMBEDDING_MODEL])
          } catch (error) {
            reject(error)
          }
        })
      })

      req.on('error', reject)
      req.setTimeout(5000, () => {
        req.destroy()
        reject(new Error('Gemini API request timeout'))
      })
      req.end()
    })
  } catch (error) {
    console.warn(`[model-fetcher] Failed to fetch Gemini models: ${error.message}, using fallback model`)
    return [FALLBACK_GEMINI_EMBEDDING_MODEL]
  }
}

/**
 * Match a requested capability against a list of model capabilities.
 * Normalizes common variations (e.g., 'completion' matches 'chat').
 *
 * @param {string} requestedCapability - The capability to filter by (e.g., 'chat', 'embeddings')
 * @param {Array} capabilities - The model's capabilities
 * @returns {boolean}
 */
function matchesCapability(requestedCapability, capabilities) {
  if (!requestedCapability) return true
  const normalized = new Set((capabilities || []).map(c => String(c).toLowerCase()))
  if (requestedCapability === 'chat') return normalized.has('chat') || normalized.has('completion')
  if (requestedCapability === 'embeddings') return normalized.has('embeddings') || normalized.has('embedding')
  return normalized.has(requestedCapability)
}

/**
 * Get available models for a given provider, with automatic fallback to static models.
 * This is the main entry point for retrieving models.
 *
 * @param {object} opts
 * @param {string} opts.providerType - The provider type (e.g., 'anthropic', 'openai', 'ollama')
 * @param {string} [opts.apiKey] - The API key for the provider (optional)
 * @param {string} [opts.capability] - Filter by capability (e.g., 'chat', 'embeddings')
 * @param {string} [opts.baseUrl] - Base URL for the provider (used by Ollama)
 * @returns {Promise<Array>} Array of model objects
 */
async function getAvailableModels({ providerType, apiKey, capability, baseUrl } = {}) {
  let models = []

  try {
    if (providerType === 'anthropic') {
      models = await fetchAnthropicModels(apiKey)
    } else if (providerType === 'openai') {
      models = await fetchOpenAIModels(apiKey)
    } else if (providerType === 'gemini' && capability === 'embeddings') {
      models = await fetchGeminiModels(apiKey)
    } else if (providerType === 'jina') {
      models = getStaticModels({ providerType: 'jina' })
    } else if (providerType) {
      // Chat models for gemini, kimi, and any other OpenRouter-listed provider.
      console.log(`[model-fetcher] Fetching OpenRouter catalog for provider: ${providerType}`)
      models = await getOpenRouterModels({ providerType })
    }
  } catch (error) {
    console.error(`[model-fetcher] Unexpected error fetching models for ${providerType}: ${error.message}`)
    models = []
  }

  // Filter by capability if requested
  if (capability) {
    models = models.filter(model => matchesCapability(capability, model.capabilities))
  }

  return models
}

module.exports = {
  fetchAnthropicModels,
  fetchOpenAIModels,
  fetchGeminiModels,
  getAvailableModels,
  matchesCapability,
}
