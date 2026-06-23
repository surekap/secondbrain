'use strict'

const http = require('http')
const https = require('https')
const { DEFAULT_OLLAMA_BASE_URL } = require('./model-catalog')

function normalizeOllamaBaseUrl(baseUrl) {
  const raw = String(baseUrl || DEFAULT_OLLAMA_BASE_URL).trim()
  const withoutTrailingSlash = raw.replace(/\/+$/, '')
  return withoutTrailingSlash.endsWith('/api')
    ? withoutTrailingSlash.slice(0, -4)
    : withoutTrailingSlash
}

function guessCapabilities(modelName) {
  const lower = String(modelName || '').toLowerCase()
  if (
    lower.includes('embed') ||
    lower.includes('embedding') ||
    lower.includes('all-minilm') ||
    lower.includes('bge') ||
    lower.includes('e5')
  ) return ['embeddings']
  return ['completion']
}

function matchesCapability(requestedCapability, capabilities) {
  if (!requestedCapability) return true
  const normalized = new Set((capabilities || []).map(capability => String(capability).toLowerCase()))
  if (requestedCapability === 'chat') return normalized.has('chat') || normalized.has('completion')
  if (requestedCapability === 'embeddings') return normalized.has('embedding') || normalized.has('embeddings')
  return normalized.has(requestedCapability)
}

async function ollamaRequest({ baseUrl, path, method = 'POST', body, apiKey }) {
  const normalizedBaseUrl = normalizeOllamaBaseUrl(baseUrl)
  const apiPath = path.startsWith('/api/') ? path : `/api/${path.replace(/^\/+/, '')}`
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const payload = body != null ? JSON.stringify(body) : null
  if (payload != null) headers['Content-Length'] = Buffer.byteLength(payload)

  const url = new URL(`${normalizedBaseUrl}${apiPath}`)
  const transport = url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
    }, response => {
      response.setEncoding('utf8')
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        try {
          const data = text ? JSON.parse(text) : {}
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const message = data?.error || data?.message || `Ollama request failed (${response.statusCode})`
            return reject(Object.assign(new Error(message), { status: response.statusCode, response: data }))
          }
          resolve(data)
        } catch (error) {
          reject(new Error(`Failed to parse Ollama response: ${error.message}`))
        }
      })
    })

    // Ollama local models can take longer than Node's default 5 minute client timeout.
    req.setTimeout(0)
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

async function listOllamaModels(baseUrl, apiKey) {
  const data = await ollamaRequest({ baseUrl, path: '/api/tags', method: 'GET', apiKey })
  return Array.isArray(data.models) ? data.models : []
}

async function showOllamaModel(baseUrl, model, apiKey) {
  return ollamaRequest({ baseUrl, path: '/api/show', body: { model }, apiKey })
}

async function listOllamaModelOptions({ baseUrl, capability, apiKey }) {
  const models = await listOllamaModels(baseUrl, apiKey)

  const detailed = await Promise.all(models.map(async model => {
    const modelName = model.model || model.name
    try {
      const details = await showOllamaModel(baseUrl, modelName, apiKey)
      return {
        label: model.name || modelName,
        value: modelName,
        provider_type: 'ollama',
        capabilities: Array.isArray(details.capabilities) && details.capabilities.length
          ? details.capabilities
          : guessCapabilities(modelName),
        embedding_length: Object.entries(details.model_info || {})
          .find(([key]) => key.endsWith('.embedding_length'))?.[1] || null,
        details: details.details || model.details || {},
      }
    } catch (error) {
      return {
        label: model.name || modelName,
        value: modelName,
        provider_type: 'ollama',
        capabilities: guessCapabilities(modelName),
        embedding_length: null,
        details: model.details || {},
        error: error.message,
      }
    }
  }))

  return detailed
    .filter(model => matchesCapability(capability, model.capabilities))
    .sort((a, b) => a.label.localeCompare(b.label))
}

module.exports = {
  normalizeOllamaBaseUrl,
  ollamaRequest,
  listOllamaModels,
  showOllamaModel,
  listOllamaModelOptions,
}
