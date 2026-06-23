'use strict'

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

const PROVIDER_DEFINITIONS = [
  { value: 'anthropic',  label: 'Anthropic',  capabilities: ['chat'], requires_api_key: true },
  { value: 'claude_cli', label: 'Claude CLI', capabilities: ['chat'], requires_api_key: false },
  { value: 'openai',     label: 'OpenAI',     capabilities: ['chat'], requires_api_key: true },
  { value: 'gemini',     label: 'Gemini',     capabilities: ['chat', 'embeddings'], requires_api_key: true },
  { value: 'kimi',       label: 'Kimi',       capabilities: ['chat'], requires_api_key: true },
  { value: 'ollama',     label: 'Ollama',     capabilities: ['chat', 'embeddings'], requires_api_key: false, requires_base_url: true },
]

const STATIC_MODELS = [
  { label: 'Claude Sonnet 4.6',       value: 'claude-sonnet-4-6',          provider_type: 'anthropic',  capabilities: ['chat'] },
  { label: 'Claude Opus 4.6',         value: 'claude-opus-4-6',            provider_type: 'anthropic',  capabilities: ['chat'] },
  { label: 'Claude Haiku 4.5',        value: 'claude-haiku-4-5',           provider_type: 'anthropic',  capabilities: ['chat'] },
  { label: 'Claude CLI (Sonnet 4.6)', value: 'claude-sonnet-4-6',          provider_type: 'claude_cli', capabilities: ['chat'] },
  { label: 'GPT-5.4 Mini',            value: 'gpt-5.4-mini',               provider_type: 'openai',     capabilities: ['chat'] },
  { label: 'GPT-4o',                  value: 'gpt-4o',                     provider_type: 'openai',     capabilities: ['chat'] },
  { label: 'GPT-4o Mini',             value: 'gpt-4o-mini',                provider_type: 'openai',     capabilities: ['chat'] },
  { label: 'Gemini 2.5 Flash',        value: 'gemini-2.5-flash',           provider_type: 'gemini',     capabilities: ['chat'] },
  { label: 'Gemini 2.0 Flash',        value: 'gemini-2.0-flash',           provider_type: 'gemini',     capabilities: ['chat'] },
  { label: 'Gemini Embedding 2',      value: 'gemini-embedding-2-preview', provider_type: 'gemini',     capabilities: ['embeddings'] },
  { label: 'Kimi K2.5',               value: 'kimi-k2.5',                  provider_type: 'kimi',       capabilities: ['chat'] },
]

function getProviderDefinitions(capability) {
  return PROVIDER_DEFINITIONS.filter(provider => !capability || provider.capabilities.includes(capability))
}

function getStaticModels({ providerType, capability } = {}) {
  return STATIC_MODELS.filter(model => {
    if (providerType && model.provider_type !== providerType) return false
    if (capability && !model.capabilities.includes(capability)) return false
    return true
  })
}

module.exports = {
  DEFAULT_OLLAMA_BASE_URL,
  PROVIDER_DEFINITIONS,
  STATIC_MODELS,
  getProviderDefinitions,
  getStaticModels,
}
