"use strict";

const { getOpenRouterProviders } = require("./openrouter-catalog");

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const PROVIDER_TYPE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function isValidProviderType(providerType) {
  return typeof providerType === "string" && PROVIDER_TYPE_PATTERN.test(providerType);
}

// Providers OpenRouter's catalog doesn't (and can't) describe: ollama and
// claude_cli are local execution paths, not hosted APIs; gemini and jina's
// embedding capability isn't part of OpenRouter's (chat-only) catalog.
// gemini's chat capability is merged in dynamically from OpenRouter below.
const FIXED_PROVIDERS = [
  {
    value: "claude_cli",
    label: "Claude CLI",
    capabilities: ["chat"],
    requires_api_key: false,
  },
  {
    value: "gemini",
    label: "Gemini",
    capabilities: ["embeddings"],
    requires_api_key: true,
  },
  {
    value: "ollama",
    label: "Ollama",
    capabilities: ["chat", "embeddings"],
    requires_api_key: false,
    requires_base_url: true,
  },
  {
    value: "jina",
    label: "Jina",
    capabilities: ["embeddings"],
    requires_api_key: true,
  },
];

const STATIC_MODELS = [
  {
    label: "Jina Embeddings v2 (base, en)",
    value: "jina-embeddings-v2-base-en",
    provider_type: "jina",
    capabilities: ["embeddings"],
  },
  {
    label: "Jina Embeddings v3",
    value: "jina-embeddings-v3",
    provider_type: "jina",
    capabilities: ["embeddings"],
  },
];

async function getProviderDefinitions(capability) {
  const byValue = new Map();

  function addProvider(provider) {
    const existing = byValue.get(provider.value);
    if (existing) {
      existing.capabilities = Array.from(
        new Set([...existing.capabilities, ...provider.capabilities]),
      );
    } else {
      byValue.set(provider.value, {
        ...provider,
        capabilities: [...provider.capabilities],
      });
    }
  }

  FIXED_PROVIDERS.forEach(addProvider);

  if (!capability || capability === "chat") {
    const openRouterProviders = await getOpenRouterProviders();
    openRouterProviders.forEach(addProvider);
  }

  return Array.from(byValue.values()).filter(
    (provider) => !capability || provider.capabilities.includes(capability),
  );
}

function getStaticModels({ providerType, capability } = {}) {
  return STATIC_MODELS.filter((model) => {
    if (providerType && model.provider_type !== providerType) return false;
    if (capability && !model.capabilities.includes(capability)) return false;
    return true;
  });
}

module.exports = {
  DEFAULT_OLLAMA_BASE_URL,
  FIXED_PROVIDERS,
  PROVIDER_TYPE_PATTERN,
  STATIC_MODELS,
  getProviderDefinitions,
  getStaticModels,
  isValidProviderType,
};
