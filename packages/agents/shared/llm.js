// packages/agents/shared/llm.js
'use strict'

const db = require('@secondbrain/db')

// ── Cost rate table (per 1k tokens, USD) ─────────────────────────────────────

const RATES = {
  anthropic: {
    'claude-sonnet-4-6': { in: 0.003,   out: 0.015   },
    'claude-opus-4-6':   { in: 0.015,   out: 0.075   },
    'claude-haiku-4-5':  { in: 0.00025, out: 0.00125 },
  },
  openai: {
    'gpt-4o':      { in: 0.0025,  out: 0.010  },
    'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  },
  gemini: {
    'gemini-2.0-flash': { in: 0.00035, out: 0.00105 },
  },
}

function calcCost(providerType, model, tokensIn, tokensOut) {
  const r = RATES[providerType]?.[model]
  if (!r || tokensIn == null || tokensOut == null) return null
  return (tokensIn / 1000) * r.in + (tokensOut / 1000) * r.out
}

// ── Priority list cache ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 1000
const _priorityCache = new Map()  // agentId → { providers, expiresAt }

async function getPriorityList(agentId) {
  const now = Date.now()
  const cached = _priorityCache.get(agentId)
  if (cached && cached.expiresAt > now) return cached.providers

  const { rows } = await db.query(`
    SELECT p.id, p.name, p.provider_type, p.api_key, p.model,
           p.is_enabled, p.has_credits
    FROM system.agent_llm_priority alp
    JOIN system.llm_providers p ON p.id = alp.provider_id
    WHERE alp.agent_id = $1
      AND p.is_enabled = true
      AND p.has_credits = true
    ORDER BY alp.priority ASC
  `, [agentId])

  _priorityCache.set(agentId, { providers: rows, expiresAt: now + CACHE_TTL_MS })
  return rows
}

function invalidatePriorityCache(agentId) {
  if (agentId) _priorityCache.delete(agentId)
  else _priorityCache.clear()
}

// ── Credit error detection ────────────────────────────────────────────────────

function isCreditError(err) {
  const status = err.status || err.statusCode || (err.response && err.response.status)
  if (status === 402) return true
  if (err.error?.type === 'credit_balance_too_low') return true
  if (status === 429 && err.error?.code === 'insufficient_quota') return true
  if (err.status === 'RESOURCE_EXHAUSTED') return true
  const msg = (err.message || '').toLowerCase()
  if (msg.includes('credit') && msg.includes('balance')) return true
  if (msg.includes('insufficient_quota')) return true
  return false
}

// ── Usage logging ─────────────────────────────────────────────────────────────

async function logUsage({ providerId, agentId, tokensIn, tokensOut, costUsd, error }) {
  try {
    await db.query(
      `INSERT INTO system.llm_usage (provider_id, agent_id, tokens_in, tokens_out, cost_usd, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [providerId || null, agentId, tokensIn || null, tokensOut || null,
       costUsd != null ? costUsd.toFixed(6) : null, error || null]
    )
  } catch (e) {
    console.warn('[llm] usage log failed:', e.message)
  }
}

async function markCreditsFailed(providerId, errorMsg) {
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

async function callOpenAI(provider, { system, messages, tools, max_tokens }) {
  const OpenAI = require('openai')
  if (!provider.api_key) throw Object.assign(new Error('OpenAI API key not configured'), { status: 402 })
  const openai = new OpenAI.default({ apiKey: provider.api_key })
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
  const params = { model: provider.model || 'gpt-4o', max_tokens: max_tokens || 4096, messages: oaiMessages }
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
  const textParts = messages.filter(m => m.role !== 'system').map(m => {
    const content = Array.isArray(m.content)
      ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      : (m.content || '')
    return content
  })
  const systemMsg = messages.find(m => m.role === 'system')
  const prompt = (systemMsg ? systemMsg.content + '\n\n' : (system ? system + '\n\n' : '')) + textParts.join('\n')
  const result = await model.generateContent(prompt)
  const text = result.response.text()
  const usage = result.response.usageMetadata
  return { text, tool_calls: [], stop_reason: 'end_turn', tokensIn: usage?.promptTokenCount, tokensOut: usage?.candidatesTokenCount }
}

// ── Provider dispatch table ───────────────────────────────────────────────────

const CALL_FNS = {
  anthropic:  callAnthropic,
  openai:     callOpenAI,
  claude_cli: callClaudeCLI,
  gemini:     callGemini,
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
async function create(agentId, { system, messages, tools, max_tokens }) {
  const providers = await getPriorityList(agentId)

  if (providers.length === 0) {
    // Fallback: env-var credentials for backward compat during transition
    if (process.env.ANTHROPIC_API_KEY) {
      console.warn(`[llm] no DB providers for ${agentId}, falling back to env ANTHROPIC_API_KEY`)
      const result = await callAnthropic(
        { api_key: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-4-6' },
        { system, messages, tools, max_tokens }
      )
      return { ...result, provider: 'anthropic-env' }
    }
    throw new Error(`[llm] no providers configured for agent: ${agentId}`)
  }

  const errors = []
  for (const prov of providers) {
    const fn = CALL_FNS[prov.provider_type]
    if (!fn) continue

    console.log(`[llm:${agentId}] trying ${prov.name} (${prov.provider_type})`)
    try {
      const result = await fn(prov, { system, messages, tools, max_tokens })
      const cost = calcCost(prov.provider_type, prov.model, result.tokensIn, result.tokensOut)
      await logUsage({ providerId: prov.id, agentId, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: cost })
      return { text: result.text, tool_calls: result.tool_calls, stop_reason: result.stop_reason, provider: prov.name }
    } catch (err) {
      console.warn(`[llm:${agentId}] ${prov.name} failed: ${err.message}`)
      if (isCreditError(err)) {
        await markCreditsFailed(prov.id, err.message)
        console.warn(`[llm:${agentId}] marked ${prov.name} credits exhausted, trying next`)
      }
      await logUsage({ providerId: prov.id, agentId, error: err.message })
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
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-2-preview' })
  const result = await model.embedContent({
    content: { parts: [{ text: text.slice(0, 8000) }], role: 'user' },
    taskType: 'RETRIEVAL_DOCUMENT',
  })
  return result.embedding.values
}

module.exports = { create, embed, invalidatePriorityCache }
