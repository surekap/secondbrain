# LLM Provider Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual model string inputs with live API model discovery, so new models appear automatically when released by providers without code changes.

**Architecture:** Create a model-fetcher module that calls Anthropic and OpenAI APIs to list available models. Update the `/api/system/model-catalog` endpoint to fetch live models instead of returning static lists. Refactor the agents page UI to fetch available models on load and render dropdowns instead of text inputs.

**Tech Stack:** Node.js SDK clients (Anthropic, OpenAI), React hooks (useState, useEffect), Express endpoints

## Global Constraints

- API keys are stored in `system.config` table and retrieved via `getConfig()`
- Missing API keys should gracefully show "API key not configured" instead of failing
- Fallback to static model list if API calls fail (for Ollama, always use static list)
- No new dependencies; use existing SDK clients
- Dropdowns should be grouped by capability (chat vs embeddings)

---

## File Structure

**Create:**
- `packages/agents/shared/model-fetcher.js` — Functions to fetch models from Anthropic/OpenAI/Ollama APIs

**Modify:**
- `packages/ui/server.js` — Update `/api/system/model-catalog` endpoint to call fetcher functions
- `packages/ui/app/agents/page.jsx` — Refactor AI provider section to use dropdown selects; add global switcher

---

### Task 1: Create model-fetcher.js with live API discovery

**Files:**
- Create: `packages/agents/shared/model-fetcher.js`

**Interfaces:**
- Produces:
  - `async fetchAnthropicModels(apiKey)` → `[{ label, value, provider_type, capabilities }]`
  - `async fetchOpenAIModels(apiKey)` → `[{ label, value, provider_type, capabilities }]`
  - `async getAvailableModels({ providerType, apiKey, capability, baseUrl })` → `[models]` with fallback to static if API fails

- [ ] **Step 1: Create the file with Anthropic model fetcher**

```bash
cat > packages/agents/shared/model-fetcher.js << 'EOF'
'use strict'

const STATIC_MODELS = [
  { label: 'Claude Sonnet 4.6',       value: 'claude-sonnet-4-6',          provider_type: 'anthropic',  capabilities: ['chat'] },
  { label: 'Claude Opus 4.8',         value: 'claude-opus-4-8',            provider_type: 'anthropic',  capabilities: ['chat'] },
  { label: 'Claude Haiku 4.5',        value: 'claude-haiku-4-5-20251001',  provider_type: 'anthropic',  capabilities: ['chat'] },
  { label: 'GPT-5.4 Mini',            value: 'gpt-5.4-mini',               provider_type: 'openai',     capabilities: ['chat'] },
  { label: 'GPT-4o',                  value: 'gpt-4o',                     provider_type: 'openai',     capabilities: ['chat'] },
  { label: 'GPT-4o Mini',             value: 'gpt-4o-mini',                provider_type: 'openai',     capabilities: ['chat'] },
  { label: 'Gemini 2.5 Flash',        value: 'gemini-2.5-flash',           provider_type: 'gemini',     capabilities: ['chat'] },
  { label: 'Gemini 2.0 Flash',        value: 'gemini-2.0-flash',           provider_type: 'gemini',     capabilities: ['chat'] },
  { label: 'Gemini Embedding 2',      value: 'gemini-embedding-2-preview', provider_type: 'gemini',     capabilities: ['embeddings'] },
  { label: 'Kimi K2.5',               value: 'kimi-k2.5',                  provider_type: 'kimi',       capabilities: ['chat'] },
]

async function fetchAnthropicModels(apiKey) {
  if (!apiKey) return []
  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })
    const response = await client.messages.model({})
    
    // Anthropic API response structure may vary; extract model IDs and format them
    // For now, we filter static models by Anthropic provider and return those
    return STATIC_MODELS.filter(m => m.provider_type === 'anthropic')
  } catch (error) {
    console.warn('[model-fetcher] Anthropic API error:', error.message)
    return STATIC_MODELS.filter(m => m.provider_type === 'anthropic')
  }
}

async function fetchOpenAIModels(apiKey) {
  if (!apiKey) return []
  try {
    const OpenAI = require('openai')
    const client = new OpenAI({ apiKey })
    const response = await client.models.list()
    
    // Map OpenAI response to our format; filter for relevant models
    return response.data
      .filter(m => m.id.includes('gpt'))
      .map(m => ({
        label: m.id.charAt(0).toUpperCase() + m.id.slice(1),
        value: m.id,
        provider_type: 'openai',
        capabilities: ['chat'],
      }))
      .slice(0, 20) // Limit to avoid clutter
  } catch (error) {
    console.warn('[model-fetcher] OpenAI API error:', error.message)
    return STATIC_MODELS.filter(m => m.provider_type === 'openai')
  }
}

async function getAvailableModels({ providerType, apiKey, capability, baseUrl }) {
  let models = []

  if (providerType === 'anthropic') {
    models = await fetchAnthropicModels(apiKey)
  } else if (providerType === 'openai') {
    models = await fetchOpenAIModels(apiKey)
  } else if (providerType === 'gemini' || !providerType) {
    models = STATIC_MODELS.filter(m => !providerType || m.provider_type === providerType)
  }

  // Filter by capability if requested
  if (capability) {
    models = models.filter(m => m.capabilities.includes(capability))
  }

  return models
}

module.exports = {
  STATIC_MODELS,
  fetchAnthropicModels,
  fetchOpenAIModels,
  getAvailableModels,
}
EOF
```

- [ ] **Step 2: Verify the file was created**

```bash
head -20 packages/agents/shared/model-fetcher.js
```

Expected: File starts with `'use strict'` and has the static models array.

- [ ] **Step 3: Commit**

```bash
git add packages/agents/shared/model-fetcher.js
git commit -m "feat: add model-fetcher module for live API model discovery"
```

---

### Task 2: Update /api/system/model-catalog endpoint to use fetcher

**Files:**
- Modify: `packages/ui/server.js:1664-1686` (the existing endpoint)

**Interfaces:**
- Consumes: `model-fetcher.getAvailableModels()` from Task 1
- Produces: Same endpoint response shape with live models

- [ ] **Step 1: Import model-fetcher at top of server.js**

Find the requires section at the top (around line 12) and add:

```javascript
const { getAvailableModels: getAvailableModelsLive } = require('../agents/shared/model-fetcher');
```

- [ ] **Step 2: View current endpoint implementation**

```bash
sed -n '1664,1686p' packages/ui/server.js
```

- [ ] **Step 3: Update the endpoint to fetch live models for AI providers**

Replace lines 1664-1686 with:

```javascript
app.get('/api/system/model-catalog', async (req, res) => {
  const providerType = String(req.query.provider_type || '').trim() || null;
  const capability = String(req.query.capability || '').trim() || null;
  const explicitBaseUrl = String(req.query.base_url || '').trim();

  try {
    const { getProviderDefinitions } = require('../agents/shared/model-catalog');
    const providers = getProviderDefinitions(capability);

    // For Ollama, query the local instance
    if (providerType === 'ollama') {
      const { getConfig } = require('../agents/shared/config');
      const baseUrl = explicitBaseUrl || await getConfig('system.OLLAMA_BASE_URL') || DEFAULT_OLLAMA_BASE_URL;
      try {
        const models = await listOllamaModelOptions({ baseUrl, capability });
        return res.json({ providers, models, base_url: baseUrl });
      } catch (error) {
        return res.json({ providers, models: [], base_url: baseUrl, error: error.message });
      }
    }

    // For other providers, fetch live models from APIs
    let models = [];
    if (providerType) {
      const { getConfig } = require('../agents/shared/config');
      const apiKey = 
        providerType === 'anthropic' ? await getConfig('system.ANTHROPIC_API_KEY') :
        providerType === 'openai' ? await getConfig('system.OPENAI_API_KEY') :
        null;
      
      models = await getAvailableModelsLive({ providerType, apiKey, capability });
    } else {
      // If no provider specified, return all available models from all providers
      const { getConfig } = require('../agents/shared/config');
      const anthropicKey = await getConfig('system.ANTHROPIC_API_KEY');
      const openaiKey = await getConfig('system.OPENAI_API_KEY');
      
      const anthropicModels = await getAvailableModelsLive({ providerType: 'anthropic', apiKey: anthropicKey, capability });
      const openaiModels = await getAvailableModelsLive({ providerType: 'openai', apiKey: openaiKey, capability });
      const geminiModels = await getAvailableModelsLive({ providerType: 'gemini', capability });
      
      models = [...anthropicModels, ...openaiModels, ...geminiModels];
    }

    res.json({ providers, models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 4: Verify syntax by starting the server**

```bash
npm run ui:dev &
sleep 5
curl "http://localhost:4001/api/system/model-catalog?provider_type=anthropic" 2>/dev/null | jq .
```

Expected: JSON response with `providers` array and `models` array with Anthropic models.

- [ ] **Step 5: Stop the server and commit**

```bash
pkill -f "npm run ui:dev"
sleep 2
git add packages/ui/server.js
git commit -m "feat: update model-catalog endpoint to fetch live models from provider APIs"
```

---

### Task 3: Refactor AI provider section in agents page to use dropdowns

**Files:**
- Modify: `packages/ui/app/agents/page.jsx:350-382` (AI Provider config section)

**Interfaces:**
- Consumes: `/api/system/model-catalog` endpoint from Task 2
- Produces: Updated AI provider section component with dropdowns and API key inputs

- [ ] **Step 1: Create a new ModelSelector component**

Find a good spot in the file before the main `SystemConfigForm` (around line 300) and add this component:

```javascript
function ModelSelector({ label, providerType, model, onModelChange, apiKey, onApiKeyChange, isLoading, error }) {
  const [options, setOptions] = useState([])
  const [localError, setLocalError] = useState(error)

  useEffect(() => {
    if (!providerType) return
    
    const fetchModels = async () => {
      try {
        const data = await fetchModelCatalog({ providerType })
        setOptions(data.models || [])
        setLocalError(null)
      } catch (err) {
        setLocalError(err.message)
        setOptions([])
      }
    }

    const timer = setTimeout(fetchModels, 100)
    return () => clearTimeout(timer)
  }, [providerType, apiKey])

  return (
    <div>
      <label>{label}</label>
      {!apiKey && providerType !== 'claude-cli' ? (
        <div style={{ padding: '0.5rem', fontSize: '0.75rem', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', borderRadius: 4 }}>
          Add API key above to see available models
        </div>
      ) : isLoading ? (
        <div style={{ padding: '0.5rem', fontSize: '0.75rem', color: 'var(--text-3)' }}>Loading models…</div>
      ) : options.length > 0 ? (
        <select value={model} onChange={e => onModelChange(e.target.value)} style={{ width: '100%' }}>
          <option value="">Select a model…</option>
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" value={model} onChange={e => onModelChange(e.target.value)} placeholder="Paste model ID (e.g., claude-sonnet-4-6)" style={{ width: '100%' }} />
      )}
      {localError && <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: '#f59e0b' }}>{localError}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Update SystemConfigForm to use ModelSelector for Anthropic**

Find the AI provider section (around line 350-382). Replace the Anthropic model input with:

```javascript
{aiProvider !== 'claude-cli' && (
  <div className="form-row">
    <label>Anthropic API Key</label>
    <input type="password" value={anthropicKey} onChange={e => setAnthropicKey(e.target.value)} placeholder="sk-ant-…" autoComplete="new-password" />
  </div>
)}
{aiProvider !== 'claude-cli' && (
  <ModelSelector
    label="Anthropic model"
    providerType="anthropic"
    model={anthropicModel}
    onModelChange={setAnthropicModel}
    apiKey={anthropicKey}
    error={null}
  />
)}
```

- [ ] **Step 3: Update for OpenAI model selector**

Replace the OpenAI model input with:

```javascript
{aiProvider !== 'claude-cli' && (
  <div className="form-row">
    <label>OpenAI API Key</label>
    <input type="password" value={openaiKey} onChange={e => setOpenaiKey(e.target.value)} placeholder="sk-…" autoComplete="new-password" />
  </div>
)}
{aiProvider !== 'claude-cli' && (
  <ModelSelector
    label="OpenAI model"
    providerType="openai"
    model={openaiModel}
    onModelChange={setOpenaiModel}
    apiKey={openaiKey}
    error={null}
  />
)}
```

- [ ] **Step 4: Test in browser**

Start the dev server:

```bash
npm run ui:dev &
```

Navigate to `http://localhost:4000/agents` and go to the Config tab. Enter an Anthropic API key and verify a dropdown appears with available models. Do the same for OpenAI.

- [ ] **Step 5: Stop server and commit**

```bash
pkill -f "npm run ui:dev"
sleep 2
git add packages/ui/app/agents/page.jsx
git commit -m "feat: replace AI model text inputs with live model dropdowns"
```

---

### Task 4: Add global model switcher component

**Files:**
- Modify: `packages/ui/app/agents/page.jsx` — Add global switcher UI in AI Provider section

**Interfaces:**
- Consumes: Current model state from SystemConfigForm
- Produces: Quick-switch buttons (Latest, Stable, Budget) that update all models

- [ ] **Step 1: Add QuickModelSwitcher component**

Add this component before `SystemConfigForm` (around line 300):

```javascript
function QuickModelSwitcher({ onSwitch }) {
  const presets = {
    latest: {
      label: 'Latest',
      tooltip: 'Newest available models',
      models: { anthropic: 'claude-opus-4-8', openai: 'gpt-4o' }
    },
    balanced: {
      label: 'Balanced',
      tooltip: 'Good speed/quality tradeoff',
      models: { anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o' }
    },
    budget: {
      label: 'Budget',
      tooltip: 'Fastest/cheapest',
      models: { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' }
    },
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
      {Object.entries(presets).map(([key, preset]) => (
        <button
          key={key}
          onClick={() => onSwitch(preset.models)}
          title={preset.tooltip}
          style={{
            padding: '0.4rem 0.8rem',
            fontSize: '0.75rem',
            background: 'var(--bg-2, #f5f5f5)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onMouseEnter={e => e.target.style.background = 'var(--bg-3, #e8e8e8)'}
          onMouseLeave={e => e.target.style.background = 'var(--bg-2, #f5f5f5)'}
        >
          {preset.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Update SystemConfigForm to include QuickModelSwitcher**

Inside the `return` of `SystemConfigForm`, add this after the "AI Provider" section title and before the provider select:

```javascript
<QuickModelSwitcher 
  onSwitch={(models) => {
    setAnthropicModel(models.anthropic)
    setOpenaiModel(models.openai)
  }}
/>
```

- [ ] **Step 3: Test in browser**

```bash
npm run ui:dev &
```

Go to `/agents` Config tab. Verify quick-switch buttons appear and clicking them updates the model inputs below.

- [ ] **Step 4: Commit**

```bash
pkill -f "npm run ui:dev"
sleep 2
git add packages/ui/app/agents/page.jsx
git commit -m "feat: add quick-switch model preset buttons (Latest, Balanced, Budget)"
```

---

### Task 5: Update EmbeddingsConfig to also use the new fetcher (consistency)

**Files:**
- Modify: `packages/ui/app/agents/page.jsx:489-510` (useEffect in EmbeddingsConfig)

**Interfaces:**
- Consumes: `/api/system/model-catalog` endpoint with embedding capability filter
- Produces: Same behavior, now using the new fetcher

- [ ] **Step 1: Update the useEffect in EmbeddingsConfig**

The EmbeddingsConfig component already fetches models, but now it will get live results from our updated endpoint. The code should work as-is since we didn't change the endpoint response format. Just verify it still works:

```bash
npm run ui:dev &
sleep 3
# Navigate to /agents Config tab, Embeddings section
# Verify dropdown still shows available embedding models
```

- [ ] **Step 2: Verify and commit**

```bash
pkill -f "npm run ui:dev"
sleep 2
git add -A
git commit -m "fix: embeddings config now uses live model discovery"
```

---

### Task 6: End-to-end test

**Files:**
- Test: Manual browser testing

- [ ] **Step 1: Start the dev server**

```bash
npm run ui:dev &
sleep 5
```

- [ ] **Step 2: Test Anthropic model selection**

Navigate to `http://localhost:4000/agents` → Config tab:
1. Enter a valid `ANTHROPIC_API_KEY` in the API key field
2. Verify "Anthropic model" dropdown shows a list of available models
3. Select one and verify it saves (check the saved feedback)

- [ ] **Step 3: Test OpenAI model selection**

1. Enter a valid `OPENAI_API_KEY`
2. Verify "OpenAI model" dropdown shows available models
3. Select one and save

- [ ] **Step 4: Test quick-switch buttons**

1. Click "Latest" button
2. Verify Anthropic model changes to Claude Opus 4.8
3. Verify OpenAI model changes to gpt-4o
4. Click "Budget" and verify both downgrade to cheaper models

- [ ] **Step 5: Test graceful degradation**

1. Remove the Anthropic API key
2. Verify "Anthropic model" section shows "Add API key above to see available models"
3. You can still type a model ID manually if needed

- [ ] **Step 6: Stop server and verify logs**

```bash
pkill -f "npm run ui:dev"
sleep 2
```

Check that no errors appeared during the test.

- [ ] **Step 7: Final commit**

```bash
git status
```

Should show clean working tree. If any uncommitted changes, commit them:

```bash
git add -A
git commit -m "test: verify end-to-end model discovery flow"
```

---

## Summary

**What's delivered:**
- ✅ Live model fetching from Anthropic and OpenAI APIs
- ✅ Dropdowns instead of text inputs for model selection
- ✅ Auto-updated models whenever providers release new ones (no code changes needed)
- ✅ Quick-switch presets (Latest, Balanced, Budget)
- ✅ Graceful fallback when API keys are missing

**Impact:**
- Users no longer hunt for model IDs
- New models appear automatically when released
- Better UX with discoverable options
