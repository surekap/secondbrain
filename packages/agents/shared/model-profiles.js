'use strict'

/**
 * Workload-level model policy. Credentials and enable/disable controls remain
 * in system.llm_providers; profiles own provider order, model, and effort.
 */
const MODEL_PROFILES = Object.freeze({
  bulk_structured: Object.freeze([
    { provider_type: 'openai', model: 'gpt-5.6-luna', reasoning_effort: 'low' },
  ]),
  reasoning_synthesis: Object.freeze([
    { provider_type: 'openai', model: 'gpt-5.6-terra', reasoning_effort: 'high' },
  ]),
  autonomous_tools: Object.freeze([
    { provider_type: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'medium' },
    { provider_type: 'anthropic', model: 'claude-sonnet-5' },
    { provider_type: 'groq', model: null },
  ]),
  frontier_manual: Object.freeze([
    { provider_type: 'anthropic', model: 'claude-fable-5' },
    { provider_type: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'max' },
  ]),
})

const AGENT_PROFILE_REQUIREMENTS = Object.freeze({
  relationships: Object.freeze(['bulk_structured', 'reasoning_synthesis']),
  projects: Object.freeze(['bulk_structured', 'reasoning_synthesis']),
  intelligence: Object.freeze(['reasoning_synthesis']),
  research: Object.freeze(['reasoning_synthesis']),
})

function getProfilePolicy(profile) {
  if (!profile) return null
  const policy = MODEL_PROFILES[profile]
  if (!policy) throw new Error(`[llm] unknown model profile: ${profile}`)
  return policy
}

function getAgentProfileRequirements(agentId) {
  return AGENT_PROFILE_REQUIREMENTS[agentId] || []
}

function credentialFromEnv(providerType) {
  const keys = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : 'GOOGLE_API_KEY',
    kimi: 'KIMI_API_KEY',
    groq: 'GROQ_API_KEY',
    'x-ai': 'XAI_API_KEY',
  }
  const key = keys[providerType]
  return key ? process.env[key] || null : null
}

module.exports = {
  AGENT_PROFILE_REQUIREMENTS,
  MODEL_PROFILES,
  getAgentProfileRequirements,
  getProfilePolicy,
  credentialFromEnv,
}
