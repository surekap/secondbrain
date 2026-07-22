// packages/agents/shared/llm.js
'use strict'

const db = require('@secondbrain/db')
const { ollamaRequest } = require('./ollama')
const { getProfilePolicy, credentialFromEnv } = require('./model-profiles')

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const NATIVE_CHAT_PROVIDER_TYPES = new Set([
  'anthropic', 'openai', 'claude_cli', 'gemini', 'kimi', 'groq', 'ollama', 'x-ai',
])

let telemetry = null
function getTelemetry() {
  if (!telemetry) {
    try { telemetry = require('@secondbrain/telemetry') } catch (_) {}
  }
  return telemetry
}

// ── Cost rate table (per 1k tokens, USD) ─────────────────────────────────────

const RATES = {
  anthropic: {
    'claude-sonnet-4-6': { in: 0.003,   out: 0.015  },
    'claude-opus-4-6':   { in: 0.005,   out: 0.025  },
    'claude-haiku-4-5':  { in: 0.001,   out: 0.005  },
    'claude-sonnet-5':   { in: 0.003,   out: 0.015  },
    'claude-opus-4-8':   { in: 0.005,   out: 0.025  },
    'claude-fable-5':    { in: 0.010,   out: 0.050  },
  },
  openai: {
    'gpt-4o':       { in: 0.0025,   out: 0.010  },
    'gpt-4o-mini':  { in: 0.00015,  out: 0.0006 },
    'gpt-5.4-mini': { in: 0.00075,  out: 0.0045 },
    'gpt-5.6-luna': { in: 0.001,    out: 0.006  },
    'gpt-5.6-sol':  { in: 0.005,    out: 0.030  },
  },
  gemini: {
    'gemini-2.0-flash':   { in: 0.0001,  out: 0.0004 },
    'gemini-2.5-flash':   { in: 0.0003,  out: 0.0025 },
    'gemini-3.1-flash-lite': { in: 0.00025, out: 0.0015 },
    'gemini-3.5-flash':      { in: 0.0015,  out: 0.009  },
  },
  kimi: {
    'kimi-k2.5': { in: 0.00042, out: 0.0022 },
  },
  groq: {
    // Approximate public pricing; update when changing models.
    'llama-3.3-70b-versatile': { in: 0.00059, out: 0.00079 },
    'openai/gpt-oss-120b':      { in: 0.00015, out: 0.00060 },
  },
}

function calcCost(providerType, model, tokensIn, tokensOut) {
  const r = RATES[providerType]?.[model]
  if (!r || tokensIn == null || tokensOut == null) return null
  return (tokensIn / 1000) * r.in + (tokensOut / 1000) * r.out
}

// ── Dead-provider circuit breaker (in-process, non-persistent) ───────────────
// Skips providers that returned ECONNREFUSED for a TTL period.

const _deadProviders = new Map()   // providerId → deadUntilMs
const DEAD_TTL_MS = 5 * 60 * 1000 // 5 minutes

function _isProviderDead(providerId) {
  const until = _deadProviders.get(providerId)
  if (!until) return false
  if (Date.now() > until) { _deadProviders.delete(providerId); return false }
  return true
}

function _markProviderDead(providerId, ttlMs = DEAD_TTL_MS) {
  _deadProviders.set(providerId, Date.now() + ttlMs)
}

// ── Priority list cache ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 1000
const _priorityCache = new Map()  // agentId → { providers, expiresAt }

function providerEligible(provider) {
  return Boolean(provider?.is_enabled && provider?.has_credits)
}

function isOpenRouterProvider(provider) {
  if (String(provider?.base_url || '').includes('openrouter.ai')) return true
  return typeof provider?.model === 'string' &&
    provider.model.includes('/') &&
    !NATIVE_CHAT_PROVIDER_TYPES.has(provider.provider_type)
}

function providerMatchesProfileRoute(provider, route) {
  if (!provider?.model || !route?.model) return false
  if (provider.provider_type === route.provider_type && provider.model === route.model) return true
  if (!provider.model.includes('/')) return false
  const separator = provider.model.indexOf('/')
  const author = provider.model.slice(0, separator)
  const model = provider.model.slice(separator + 1)
  return author === route.provider_type && model === route.model
}

function selectConfiguredProfileProviders(rows, policy) {
  const assigned = rows.filter(provider => provider.priority != null)
  if (assigned.length === 0) return null

  // Explicit agent priority is authoritative. Profiles provide defaults only
  // when an agent has no assignments; an assigned provider may intentionally
  // override the profile's default model (for example XAI → OpenAI fallback).
  return assigned.filter(providerEligible).map(provider => {
    const matchingRoute = policy.find(route => providerMatchesProfileRoute(provider, route))
    return {
      ...provider,
      // Preserve profile effort only when this is the profiled model. Other
      // providers may not accept the same provider-specific request option.
      reasoning_effort: matchingRoute?.reasoning_effort,
      policy_model: matchingRoute?.model || null,
    }
  })
}

async function getPriorityList(agentId, profile) {
  const now = Date.now()
  const cacheKey = `${agentId}:${profile || 'legacy'}`
  const cached = _priorityCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.providers

  const policy = getProfilePolicy(profile)
  if (policy) {
    const { rows } = await db.query(`
      SELECT p.id, p.name, p.provider_type, p.api_key, p.base_url, p.model,
             p.is_enabled, p.has_credits, p.last_error_at, alp.priority
      FROM system.llm_providers p
      LEFT JOIN system.agent_llm_priority alp
        ON alp.provider_id = p.id AND alp.agent_id = $1
      ORDER BY alp.priority ASC NULLS LAST, p.has_credits DESC, p.id ASC
    `, [agentId])
    const configuredProviders = selectConfiguredProfileProviders(rows, policy)
    if (configuredProviders !== null) {
      _priorityCache.set(cacheKey, { providers: configuredProviders, expiresAt: now + CACHE_TTL_MS })
      return configuredProviders
    }

    const providers = []
    for (const route of policy) {
      const matching = rows.filter(provider => providerMatchesProfileRoute(provider, route))
      const configured = matching.find(providerEligible)
      if (configured) {
        providers.push({
          ...configured,
          reasoning_effort: route.reasoning_effort,
          policy_model: route.model,
        })
      } else if (matching.length === 0 && credentialFromEnv(route.provider_type)) {
        providers.push({
          id: null,
          name: `${route.provider_type}-env`,
          provider_type: route.provider_type,
          api_key: credentialFromEnv(route.provider_type),
          base_url: null,
          ...route,
        })
      }
    }
    _priorityCache.set(cacheKey, { providers, expiresAt: now + CACHE_TTL_MS })
    return providers
  }

  const { rows } = await db.query(`
    SELECT p.id, p.name, p.provider_type, p.api_key, p.base_url, p.model,
           p.is_enabled, p.has_credits
    FROM system.agent_llm_priority alp
    JOIN system.llm_providers p ON p.id = alp.provider_id
    WHERE alp.agent_id = $1
      AND p.is_enabled = true
      AND p.has_credits = true
    ORDER BY alp.priority ASC
  `, [agentId])

  _priorityCache.set(cacheKey, { providers: rows, expiresAt: now + CACHE_TTL_MS })
  return rows
}

async function hasEligibleProvider(agentId, profile, requiredCapability = null) {
  const providers = await getPriorityList(agentId, profile)
  for (const provider of providers) {
    const callable = isOpenRouterProvider(provider) || NATIVE_CHAT_PROVIDER_TYPES.has(provider.provider_type)
    if (callable && await providerSupportsCapability(provider, requiredCapability)) return true
  }
  return false
}

function invalidatePriorityCache(agentId) {
  if (!agentId) {
    _priorityCache.clear()
    return
  }
  for (const key of _priorityCache.keys()) {
    if (key === agentId || key.startsWith(`${agentId}:`)) _priorityCache.delete(key)
  }
}

// ── Credit error detection ────────────────────────────────────────────────────

function isCreditError(err) {
  const status = err.status || err.statusCode || (err.response && err.response.status)
  if (status === 402) return true
  if (err.error?.type === 'credit_balance_too_low') return true
  if (status === 429 && err.error?.code === 'insufficient_quota') return true
  if (err.status === 'RESOURCE_EXHAUSTED') return true
  const msg = (err.message || '').toLowerCase()
  if (status === 429 && (
    msg.includes('quota') ||
    msg.includes('spending cap') ||
    msg.includes('resource exhausted')
  )) return true
  if (msg.includes('credit') && msg.includes('balance')) return true
  if (msg.includes('insufficient_quota')) return true
  return false
}

function isTransientRateLimitError(err) {
  const status = err.status || err.statusCode || (err.response && err.response.status)
  return status === 429 && !isCreditError(err)
}

// ── Usage logging ─────────────────────────────────────────────────────────────

async function logUsage({ providerId, agentId, model, profile, taskType, tokensIn, tokensOut, costUsd, error }) {
  try {
    await db.query(
      `INSERT INTO system.llm_usage
         (provider_id, agent_id, model, profile, task_type, tokens_in, tokens_out, cost_usd, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [providerId || null, agentId, model || null, profile || null, taskType || null,
       tokensIn || null, tokensOut || null, costUsd != null ? costUsd.toFixed(6) : null, error || null]
    )
  } catch (e) {
    console.warn('[llm] usage log failed:', e.message)
  }
}

async function markCreditsFailed(providerId, errorMsg) {
  if (!providerId) return
  try {
    await db.query(
      `UPDATE system.llm_providers
       SET has_credits = false, last_error = $2, last_error_at = NOW()
       WHERE id = $1`,
      [providerId, errorMsg]
    )
    invalidatePriorityCache()
  } catch (e) {
    console.warn('[llm] markCreditsFailed error:', e.message)
  }
}

async function markProviderHealthy(providerId) {
  if (!providerId) return
  try {
    await db.query(
      `UPDATE system.llm_providers
       SET has_credits = true, last_error = NULL, last_error_at = NULL
       WHERE id = $1 AND (has_credits = false OR last_error IS NOT NULL)`,
      [providerId]
    )
  } catch (e) {
    console.warn('[llm] provider health reset failed:', e.message)
  }
}

// ── Provider call implementations ─────────────────────────────────────────────

function toAnthropicMessages(messages) {
  const systemMsg = messages.find(m => m.role === 'system')
  const nonSystem = messages.filter(m => m.role !== 'system')
  const converted = nonSystem.map(m => {
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] }
    }
    if (m.role === 'assistant' && m.tool_calls?.length > 0) {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      return { role: 'assistant', content: blocks }
    }
    return { role: m.role, content: Array.isArray(m.content) ? m.content : (m.content || '') }
  })
  return { systemMsg: systemMsg ? systemMsg.content : undefined, converted }
}

function parseAnthropicResponse(response) {
  let text = null
  const tool_calls = []
  for (const block of (response.content || [])) {
    if (block.type === 'text') text = block.text
    else if (block.type === 'tool_use') tool_calls.push({ id: block.id, name: block.name, input: block.input })
  }
  let stop_reason = 'end_turn'
  if (response.stop_reason === 'tool_use') stop_reason = 'tool_use'
  else if (response.stop_reason === 'max_tokens') stop_reason = 'max_tokens'
  return { text, tool_calls, stop_reason, tokensIn: response.usage?.input_tokens, tokensOut: response.usage?.output_tokens }
}

async function callAnthropic(provider, { system, messages, tools, max_tokens }) {
  const Anthropic = require('@anthropic-ai/sdk')
  if (!provider.api_key) throw Object.assign(new Error('Anthropic API key not configured'), { status: 402 })
  const anthropic = new Anthropic.default({ apiKey: provider.api_key })
  const { systemMsg, converted } = toAnthropicMessages(messages)
  const params = {
    model: provider.model || 'claude-sonnet-4-6',
    max_tokens: max_tokens || 4096,
    messages: converted,
  }
  const effectiveSystem = system || systemMsg
  if (effectiveSystem) params.system = effectiveSystem
  if (tools?.length) {
    params.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  }
  const response = await anthropic.messages.create(params)
  return parseAnthropicResponse(response)
}

function toResponsesInput(messages) {
  const input = []
  for (const message of messages) {
    if (Array.isArray(message.provider_items) && message.provider_items.length) {
      input.push(...message.provider_items)
      continue
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content || '' })
      continue
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      if (message.content) input.push({ role: 'assistant', content: message.content })
      for (const tc of message.tool_calls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input || {}) })
      }
      continue
    }
    if (message.role === 'system') continue
    if (Array.isArray(message.content)) {
      const content = message.content.map(block => block.type === 'text'
        ? { type: 'input_text', text: block.text }
        : { type: 'input_image', image_url: `data:${block.source?.media_type};base64,${block.source?.data}`, detail: 'low' })
      input.push({ role: message.role, content })
    } else {
      input.push({ role: message.role, content: message.content || '' })
    }
  }
  return input
}

function parseResponsesResponse(response) {
  const tool_calls = (response.output || [])
    .filter(item => item.type === 'function_call')
    .map(item => {
      let parsed = {}
      try { parsed = JSON.parse(item.arguments || '{}') } catch (_) {}
      return { id: item.call_id, name: item.name, input: parsed }
    })
  let stop_reason = tool_calls.length ? 'tool_use' : 'end_turn'
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') stop_reason = 'max_tokens'
  return {
    text: response.output_text || null,
    tool_calls,
    stop_reason,
    tokensIn: response.usage?.input_tokens,
    tokensOut: response.usage?.output_tokens,
    provider_items: response.output || [],
    provider_response_id: response.id,
    model: response.model,
  }
}

async function callOpenAI(provider, { system, messages, tools, max_tokens }) {
  const OpenAI = require('openai')
  if (!provider.api_key) throw Object.assign(new Error('OpenAI API key not configured'), { status: 402 })
  const openai = new OpenAI.default({ apiKey: provider.api_key })
  if (String(provider.model || '').startsWith('gpt-5.6')) {
    const systemMessage = messages.find(message => message.role === 'system')
    const params = {
      model: provider.model,
      input: toResponsesInput(messages),
      max_output_tokens: max_tokens || 4096,
      reasoning: { effort: provider.reasoning_effort || 'none' },
      store: false,
      include: ['reasoning.encrypted_content'],
    }
    if (system || systemMessage?.content) params.instructions = system || systemMessage.content
    if (tools?.length) {
      params.tools = tools.map(t => ({
        type: 'function', name: t.name, description: t.description, parameters: t.input_schema,
      }))
    }
    return parseResponsesResponse(await openai.responses.create(params))
  }
  const oaiMessages = messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
    if (m.role === 'assistant' && m.tool_calls?.length > 0) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
      }
    }
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content.map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image_url', image_url: { url: `data:${b.source?.media_type};base64,${b.source?.data}` } }) }
    }
    return { role: m.role, content: m.content || '' }
  })
  const hasSystem = oaiMessages.some(m => m.role === 'system')
  if (system && !hasSystem) oaiMessages.unshift({ role: 'system', content: system })
  const params = { model: provider.model || 'gpt-4o', max_completion_tokens: max_tokens || 4096, messages: oaiMessages }
  if (tools?.length) {
    params.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  }
  const response = await openai.chat.completions.create(params)
  const choice = response.choices[0]
  const msg = choice.message
  const tool_calls = (msg.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }))
  let stop_reason = 'end_turn'
  if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use'
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens'
  return { text: msg.content || null, tool_calls, stop_reason, tokensIn: response.usage?.prompt_tokens, tokensOut: response.usage?.completion_tokens }
}

async function callClaudeCLI(provider, { system, messages, max_tokens }) {
  const { spawn } = require('child_process')
  const claudePath = 'claude'
  const modelAlias = (provider.model || 'claude-sonnet-4-6').replace('claude-', '').split('-')[0]
  const lines = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const role = m.role === 'assistant' ? 'Assistant' : 'User'
    const content = Array.isArray(m.content)
      ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (m.content || '')
    if (content) lines.push(`${role}: ${content}`)
  }
  const prompt = lines.join('\n\n')
  if (!prompt.trim()) throw new Error('[claude-cli] empty prompt')
  const args = ['--print', '--output-format', 'json', '--model', modelAlias, '--no-session-persistence', '--max-turns', '1']
  if (system) args.push('--system-prompt', system)

  return new Promise((resolve, reject) => {
    const { ANTHROPIC_API_KEY: _1, OPENAI_API_KEY: _2, ...cliEnv } = process.env
    const child = spawn(claudePath, args, { env: cliEnv })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`[claude-cli] exited ${code}: ${stderr.slice(0, 300)}`))
      try {
        const json = JSON.parse(stdout.trim())
        if (json.is_error || json.subtype !== 'success') return reject(new Error(`[claude-cli] error: ${json.result || JSON.stringify(json).slice(0, 200)}`))
        resolve({ text: json.result || null, tool_calls: [], stop_reason: json.stop_reason || 'end_turn', tokensIn: null, tokensOut: null })
      } catch (e) {
        reject(new Error(`[claude-cli] JSON parse failed: ${e.message}`))
      }
    })
    child.stdin.write(prompt)
    child.stdin.end()
    setTimeout(() => { child.kill(); reject(new Error('[claude-cli] timeout after 300s')) }, 300000)
  })
}

async function callGemini(provider, { system, messages, max_tokens }) {
  const { GoogleGenerativeAI } = require('@google/generative-ai')
  if (!provider.api_key) throw Object.assign(new Error('Gemini API key not configured'), { status: 402 })
  const genAI = new GoogleGenerativeAI(provider.api_key)
  const model = genAI.getGenerativeModel({ model: provider.model || 'gemini-2.0-flash' })
  const parts = []
  const systemMsg = messages.find(m => m.role === 'system')
  const instruction = systemMsg?.content || system
  if (instruction) parts.push({ text: instruction })
  for (const message of messages.filter(m => m.role !== 'system')) {
    if (!Array.isArray(message.content)) {
      if (message.content) parts.push({ text: message.content })
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text' && block.text) parts.push({ text: block.text })
      else if (block.source?.data) {
        parts.push({ inlineData: { data: block.source.data, mimeType: block.source.media_type } })
      }
    }
  }
  const result = await model.generateContent(parts)
  const text = result.response.text()
  const usage = result.response.usageMetadata
  return { text, tool_calls: [], stop_reason: 'end_turn', tokensIn: usage?.promptTokenCount, tokensOut: usage?.candidatesTokenCount }
}

function toOllamaMessages(messages, system) {
  const toolNamesById = new Map()
  const ollamaMessages = []
  const hasSystem = messages.some(m => m.role === 'system')

  if (system && !hasSystem) {
    ollamaMessages.push({ role: 'system', content: system })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) ollamaMessages.push({ role: 'system', content: message.content })
      continue
    }

    if (message.role === 'tool') {
      ollamaMessages.push({
        role: 'tool',
        tool_name: toolNamesById.get(message.tool_call_id) || 'tool',
        content: message.content || '',
      })
      continue
    }

    if (message.role === 'assistant' && message.tool_calls?.length > 0) {
      const tool_calls = message.tool_calls.map((toolCall, index) => {
        toolNamesById.set(toolCall.id, toolCall.name)
        return {
          type: 'function',
          function: {
            index,
            name: toolCall.name,
            arguments: toolCall.input || {},
          },
        }
      })

      const assistantText = Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        : (message.content || '')
      const assistantMessage = { role: 'assistant', tool_calls }
      if (assistantText) assistantMessage.content = assistantText
      ollamaMessages.push(assistantMessage)
      continue
    }

    const content = Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      : (message.content || '')
    const images = Array.isArray(message.content)
      ? message.content
        .filter(block => block.type !== 'text' && block.source?.data)
        .map(block => block.source.data)
      : []
    const ollamaMessage = { role: message.role === 'assistant' ? 'assistant' : 'user', content }
    if (images.length) ollamaMessage.images = images
    ollamaMessages.push(ollamaMessage)
  }

  return ollamaMessages
}

function buildOllamaParams(provider, { system, messages, tools, max_tokens, expectJson }) {
  const params = {
    model: provider.model || 'qwen3',
    messages: toOllamaMessages(messages, system),
    stream: false,
  }

  if (max_tokens) params.options = { num_predict: max_tokens }
  if (expectJson) {
    params.format = 'json'
    params.think = false
  }
  if (tools?.length) {
    params.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
  }
  return params
}

async function callOllama(provider, options) {
  const params = buildOllamaParams(provider, options)

  const response = await ollamaRequest({
    baseUrl: provider.base_url,
    path: '/api/chat',
    body: params,
    apiKey: provider.api_key || null,
  })

  const tool_calls = (response.message?.tool_calls || []).map((toolCall, index) => ({
    id: `ollama-tool-${index + 1}`,
    name: toolCall.function?.name,
    input: toolCall.function?.arguments || {},
  })).filter(toolCall => toolCall.name)

  let stop_reason = 'end_turn'
  if (tool_calls.length > 0) stop_reason = 'tool_use'
  else if (response.done_reason === 'length') stop_reason = 'max_tokens'

  return {
    text: response.message?.content || null,
    tool_calls,
    stop_reason,
    tokensIn: response.prompt_eval_count,
    tokensOut: response.eval_count,
  }
}

function toOpenAICompatibleMessages(messages) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
    if (m.role === 'assistant' && m.tool_calls?.length > 0) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })),
      }
    }
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content.map(b => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'image_url', image_url: { url: `data:${b.source?.media_type};base64,${b.source?.data}` } }) }
    }
    return { role: m.role, content: m.content || '' }
  })
}

function parseOpenAICompatibleResponse(response) {
  const choice = response.choices[0]
  const msg = choice.message
  const tool_calls = (msg.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) }))
  let stop_reason = 'end_turn'
  if (choice.finish_reason === 'tool_calls') stop_reason = 'tool_use'
  else if (choice.finish_reason === 'length') stop_reason = 'max_tokens'
  return { text: msg.content || null, tool_calls, stop_reason, tokensIn: response.usage?.prompt_tokens, tokensOut: response.usage?.completion_tokens }
}

async function callKimi(provider, { system, messages, tools, max_tokens }) {
  const OpenAI = require('openai')
  if (!provider.api_key) throw Object.assign(new Error('Kimi API key not configured'), { status: 402 })
  const kimi = new OpenAI.default({ apiKey: provider.api_key, baseURL: 'https://api.moonshot.ai/v1' })
  const oaiMessages = toOpenAICompatibleMessages(messages)
  const hasSystem = oaiMessages.some(m => m.role === 'system')
  if (system && !hasSystem) oaiMessages.unshift({ role: 'system', content: system })
  const params = { model: provider.model || 'kimi-k2.5', max_tokens: max_tokens || 4096, messages: oaiMessages }
  if (tools?.length) {
    params.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  }
  return parseOpenAICompatibleResponse(await kimi.chat.completions.create(params))
}

async function callGroq(provider, { system, messages, tools, max_tokens }) {
  const OpenAI = require('openai')
  if (!provider.api_key) throw Object.assign(new Error('Groq API key not configured'), { status: 402 })
  const groq = new OpenAI.default({ apiKey: provider.api_key, baseURL: provider.base_url || 'https://api.groq.com/openai/v1' })
  const oaiMessages = toOpenAICompatibleMessages(messages)
  const hasSystem = oaiMessages.some(m => m.role === 'system')
  if (system && !hasSystem) oaiMessages.unshift({ role: 'system', content: system })
  const params = { model: provider.model || 'llama-3.3-70b-versatile', max_tokens: max_tokens || 4096, messages: oaiMessages }
  if (tools?.length) {
    params.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  }
  return parseOpenAICompatibleResponse(await groq.chat.completions.create(params))
}

function buildOpenRouterParams(provider, { system, messages, tools, max_tokens }) {
  const oaiMessages = toOpenAICompatibleMessages(messages)
  const hasSystem = oaiMessages.some(message => message.role === 'system')
  if (system && !hasSystem) oaiMessages.unshift({ role: 'system', content: system })
  const params = {
    model: provider.model,
    max_tokens: max_tokens || 4096,
    messages: oaiMessages,
  }
  if (provider.reasoning_effort) params.reasoning = { effort: provider.reasoning_effort }
  if (tools?.length) {
    params.tools = tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }))
  }
  return params
}

async function callOpenRouter(provider, options) {
  const OpenAI = require('openai')
  if (!provider.api_key) throw Object.assign(new Error('OpenRouter API key not configured'), { status: 402 })
  const client = new OpenAI.default({
    apiKey: provider.api_key,
    baseURL: String(provider.base_url || '').includes('openrouter.ai')
      ? provider.base_url
      : OPENROUTER_BASE_URL,
  })
  return parseOpenAICompatibleResponse(
    await client.chat.completions.create(buildOpenRouterParams(provider, options))
  )
}

function xaiModelId(model) {
  return String(model || 'grok-4.5').replace(/^x-ai\//, '')
}

async function callXAI(provider, options) {
  const OpenAI = require('openai')
  if (!provider.api_key) throw Object.assign(new Error('xAI API key not configured'), { status: 402 })
  const client = new OpenAI.default({
    apiKey: provider.api_key,
    baseURL: String(provider.base_url || '').includes('api.x.ai')
      ? provider.base_url
      : 'https://api.x.ai/v1',
  })
  return parseOpenAICompatibleResponse(
    await client.chat.completions.create(
      buildOpenRouterParams({ ...provider, model: xaiModelId(provider.model) }, options)
    )
  )
}

// ── Provider dispatch table ───────────────────────────────────────────────────

const CALL_FNS = {
  anthropic:  callAnthropic,
  openai:     callOpenAI,
  claude_cli: callClaudeCLI,
  gemini:     callGemini,
  kimi:       callKimi,
  groq:       callGroq,
  ollama:     callOllama,
  'x-ai':     callXAI,
}

async function providerSupportsCapability(provider, capability) {
  if (!capability) return true
  if (capability !== 'vision') return false
  if (isOpenRouterProvider(provider)) return true
  if (['anthropic', 'openai', 'gemini', 'x-ai'].includes(provider.provider_type)) return true
  if (provider.provider_type !== 'ollama') return false
  try {
    const details = await ollamaRequest({
      baseUrl: provider.base_url,
      path: '/api/show',
      body: { model: provider.model },
      apiKey: provider.api_key || null,
    })
    return Array.isArray(details.capabilities) && details.capabilities.includes('vision')
  } catch (error) {
    console.warn(`[llm] could not verify Ollama capabilities for ${provider.model}: ${error.message}`)
    return false
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an LLM response using the agent's DB-configured priority list.
 * Automatically falls back on credit/quota errors.
 *
 * @param {string} agentId   e.g. 'relationships', 'projects', 'limitless', 'research'
 * @param {object} opts      { messages, system?, tools?, max_tokens? }
 * @returns {{ text, tool_calls, stop_reason, provider }}
 */
async function create(agentId, { system, messages, tools, max_tokens, profile, required_capability, task_type, workflow_name, run_id, _taskType, _workflowName, _runId } = {}) {
  const effectiveTaskType = task_type || _taskType || null
  const effectiveWorkflow = workflow_name || _workflowName || null
  const effectiveRunId = run_id || _runId || null
  const providers = await getPriorityList(agentId, profile)
  const expectJson = ['extract', 'classify', 'json'].some(token => String(effectiveTaskType || '').toLowerCase().includes(token))

  if (providers.length === 0) {
    if (profile) {
      throw new Error(`[llm] no eligible providers configured for profile: ${profile}`)
    }
    // Fallback: env-var credentials for backward compat during transition
    if (process.env.ANTHROPIC_API_KEY) {
      console.warn(`[llm] no DB providers for ${agentId}, falling back to env ANTHROPIC_API_KEY`)
      const result = await callAnthropic(
        { api_key: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-5' },
        { system, messages, tools, max_tokens }
      )
      return { ...result, provider: 'anthropic-env' }
    }
    throw new Error(`[llm] no providers configured for agent: ${agentId}`)
  }

  const errors = []
  for (const prov of providers) {
    if (_isProviderDead(prov.id)) continue

    const fn = isOpenRouterProvider(prov) ? callOpenRouter : CALL_FNS[prov.provider_type]
    if (!fn) continue
    if (!(await providerSupportsCapability(prov, required_capability))) {
      errors.push(`${prov.name}: does not support required capability ${required_capability}`)
      continue
    }

    const effectiveProv = { ...prov, api_key: credentialFromEnv(prov.provider_type) || prov.api_key }
    console.log(`[llm:${agentId}] trying ${prov.name} (${prov.provider_type}/${prov.model}${profile ? ` profile=${profile}` : ''})`)
    const t   = getTelemetry()
    const req = t ? t.startRequest({
      agentId,
      runId:        effectiveRunId,
      taskType:     effectiveTaskType,
      model:        prov.model,
      providerType: prov.provider_type,
      prompt:       messages,
      workflowName: effectiveWorkflow,
    }) : null

    try {
      const result = await fn(effectiveProv, { system, messages, tools, max_tokens, expectJson })
      const cost   = calcCost(prov.provider_type, prov.model, result.tokensIn, result.tokensOut)
      await logUsage({ providerId: prov.id, agentId, model: result.model || prov.model, profile, taskType: effectiveTaskType, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: cost })
      await markProviderHealthy(prov.id)
      if (req) req.finish({
        tokensIn:   result.tokensIn,
        tokensOut:  result.tokensOut,
        success:    true,
        output:     result.text,
        retryCount: 0,
      })
      // Automatic structural quality check for JSON-expecting task types
      const t2 = getTelemetry()
      if (t2 && req && result.text) {
        const expectJson = (effectiveTaskType || '').toLowerCase().includes('extract') ||
                           (effectiveTaskType || '').toLowerCase().includes('classify') ||
                           (effectiveTaskType || '').toLowerCase().includes('json')
        if (expectJson) {
          let qModule = null
          try { qModule = require('@secondbrain/telemetry/quality') } catch (_) {}
          if (qModule) {
            const { score, issues } = qModule.scoreStructural(result.text, { expectJson: true })
            t2.recordQuality({
              requestId: req.requestId,
              evaluationType: 'structural',
              scoreNumeric: score,
              scoreLabel: score === 1 ? 'valid' : (issues[0] || 'invalid'),
              evaluator: 'auto',
              notes: issues.length ? issues.join('; ') : null,
            })
          }
        }
      }
      return { ...result, provider: prov.name, profile: profile || null }
    } catch (err) {
      if (req) req.finish({ success: false, errorType: err.constructor?.name || 'Error' })
      const isConnRefused = err.code === 'ECONNREFUSED' || (err.message || '').includes('ECONNREFUSED')
      if (isConnRefused) {
        _markProviderDead(prov.id)
        console.warn(`[llm:${agentId}] ${prov.name} unreachable (ECONNREFUSED) — skipping for 5 min`)
      } else if (isTransientRateLimitError(err)) {
        _markProviderDead(prov.id, 60 * 1000)
        console.warn(`[llm:${agentId}] ${prov.name} rate-limited — cooling down for 1 min`)
      } else {
        console.warn(`[llm:${agentId}] ${prov.name} failed: ${err.message}`)
      }
      if (isCreditError(err)) {
        await markCreditsFailed(prov.id, err.message)
        console.warn(`[llm:${agentId}] marked ${prov.name} credits exhausted, trying next`)
      }
      await logUsage({ providerId: prov.id, agentId, model: prov.model, profile, taskType: effectiveTaskType, error: err.message })
      errors.push(`${prov.name}: ${err.message}`)
    }
  }

  throw new AggregateError(errors.map(e => new Error(e)), `[llm:${agentId}] all providers failed: ${errors.join('; ')}`)
}

/**
 * Embedding call using a Gemini provider from the agent's priority list.
 * Falls back to GEMINI_API_KEY env var if no DB provider configured.
 */
async function embed(agentId, text) {
  const providers = await getPriorityList(agentId)
  const geminiProv = providers.find(p => p.provider_type === 'gemini')

  const apiKey = geminiProv?.api_key || process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('[llm] no Gemini API key available for embedding')

  const { GoogleGenerativeAI } = require('@google/generative-ai')
  const genAI = new GoogleGenerativeAI(apiKey)
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-2' })
  const result = await model.embedContent({
    content: { parts: [{ text: text.slice(0, 8000) }], role: 'user' },
    taskType: 'RETRIEVAL_DOCUMENT',
  })
  return result.embedding.values
}

module.exports = {
  create,
  embed,
  hasEligibleProvider,
  invalidatePriorityCache,
  _internals: {
    toResponsesInput,
    toOllamaMessages,
    buildOllamaParams,
    buildOpenRouterParams,
    isOpenRouterProvider,
    xaiModelId,
    providerEligible,
    providerMatchesProfileRoute,
    selectConfiguredProfileProviders,
    providerSupportsCapability,
    parseResponsesResponse,
    calcCost,
    isCreditError,
    isTransientRateLimitError,
  },
}
