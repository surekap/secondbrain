'use strict'

const https = require('https')

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const REQUEST_TIMEOUT_MS = 8000

// Providers this app already has native call code for (see CALL_FNS in
// packages/agents/shared/llm.js) under a different slug than OpenRouter uses.
// Without this, OpenRouter's raw 'google'/'moonshotai' slugs would break
// CALL_FNS[prov.provider_type] lookups for existing configured providers.
const PROVIDER_ALIASES = {
  google: { value: 'gemini', label: 'Gemini' },
  moonshotai: { value: 'kimi', label: 'Kimi' },
}

// Used only if OpenRouter has never been successfully fetched (e.g. first
// run with no network access). Kept intentionally tiny.
const FALLBACK_MODELS = [
  { label: 'Claude Sonnet 5', value: 'anthropic/claude-sonnet-5', provider_type: 'anthropic', capabilities: ['chat'] },
  { label: 'GPT-5.6 Luna', value: 'openai/gpt-5.6-luna', provider_type: 'openai', capabilities: ['chat'] },
  { label: 'Gemini 3.1 Flash Lite', value: 'google/gemini-3.1-flash-lite', provider_type: 'gemini', capabilities: ['chat'] },
]

let cache = { models: null, fetchedAt: 0 }

function titleCase(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function slugOf(modelId) {
  if (typeof modelId !== 'string') return null
  const idx = modelId.indexOf('/')
  return idx === -1 ? null : modelId.slice(0, idx)
}

function providerForSlug(slug) {
  return PROVIDER_ALIASES[slug] || { value: slug, label: titleCase(slug) }
}

function slugForProviderType(providerType) {
  const aliasEntry = Object.entries(PROVIDER_ALIASES).find(([, alias]) => alias.value === providerType)
  return aliasEntry ? aliasEntry[0] : providerType
}

function deriveProviders(rawModels) {
  const seen = new Map()
  for (const model of rawModels) {
    const slug = slugOf(model.id)
    if (!slug) continue
    const provider = providerForSlug(slug)
    if (!seen.has(provider.value)) {
      seen.set(provider.value, {
        value: provider.value,
        label: provider.label,
        capabilities: ['chat'],
        requires_api_key: true,
      })
    }
  }
  return Array.from(seen.values())
}

function deriveModels(rawModels, providerType) {
  const slug = slugForProviderType(providerType)
  return rawModels
    .filter(model => slugOf(model.id) === slug)
    .map(model => ({
      label: model.name || model.id,
      value: model.id,
      provider_type: providerType,
      capabilities: ['chat'],
    }))
}

function fetchOpenRouterModelsRaw() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/models',
      method: 'GET',
      headers: { Accept: 'application/json' },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`OpenRouter API returned ${res.statusCode}`)
          }
          const json = JSON.parse(data)
          const models = Array.isArray(json.data) ? json.data : []
          resolve(models)
        } catch (error) {
          reject(error)
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('OpenRouter API request timeout'))
    })
    req.end()
  })
}

async function getRawModels() {
  const isFresh = cache.models && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS
  if (isFresh) return cache.models

  try {
    const models = await fetchOpenRouterModelsRaw()
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error('OpenRouter API returned no models')
    }
    cache = { models, fetchedAt: Date.now() }
    return models
  } catch (error) {
    if (cache.models) {
      console.warn(`[openrouter-catalog] Fetch failed (${error.message}), serving stale cache`)
      return cache.models
    }
    console.warn(`[openrouter-catalog] Fetch failed (${error.message}), no cache available, using built-in fallback`)
    return null
  }
}

async function getOpenRouterProviders() {
  const rawModels = await getRawModels()
  if (!rawModels) return deriveProviders(FALLBACK_MODELS)
  return deriveProviders(rawModels)
}

async function getOpenRouterModels({ providerType }) {
  if (!providerType) return []
  const rawModels = await getRawModels()
  if (!rawModels) return FALLBACK_MODELS.filter(m => m.provider_type === providerType)
  return deriveModels(rawModels, providerType)
}

module.exports = {
  getOpenRouterProviders,
  getOpenRouterModels,
  // exported for unit tests
  slugOf,
  providerForSlug,
  titleCase,
  deriveProviders,
  deriveModels,
}
