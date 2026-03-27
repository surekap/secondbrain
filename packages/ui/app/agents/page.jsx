'use client'
import { useState, useEffect, useRef, useCallback } from 'react'

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(path, opts)
  const data = await r.json()
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

function relativeTime(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function formatNum(n) {
  if (n == null) return '—'
  const num = Number(n)
  if (isNaN(num)) return '—'
  return num.toLocaleString()
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Toast({ message, visible }) {
  return (
    <div style={{
      position: 'fixed', bottom: '1.5rem', right: '1.5rem',
      background: 'var(--text)', color: 'var(--bg)',
      fontSize: '0.8125rem', fontWeight: 500,
      padding: '0.6rem 1rem', borderRadius: '6px',
      zIndex: 100, pointerEvents: 'none',
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(6px)',
      transition: 'opacity 0.2s, transform 0.2s',
    }}>
      {message}
    </div>
  )
}

function StatusPill({ status }) {
  const labels = { running: 'Running', stopped: 'Stopped', error: 'Error', idle: 'Idle' }
  const label = labels[status] || status
  return (
    <span className={`status-pill ${status}`}>
      <span className="status-dot" />
      {label}
    </span>
  )
}

function AgentStats({ id, stats }) {
  if (!stats) return null
  if (id === 'email') {
    return (
      <div className="agent-stats">
        <div className="stat"><span className="stat-val">{formatNum(stats.total)}</span><span className="stat-label">Total emails</span></div>
        <div className="stat"><span className="stat-val">{formatNum(stats.today)}</span><span className="stat-label">Today</span></div>
        <div className="stat"><span className="stat-val dim">{relativeTime(stats.last_sync)}</span><span className="stat-label">Last sync</span></div>
      </div>
    )
  }
  if (id === 'limitless') {
    return (
      <div className="agent-stats">
        <div className="stat"><span className="stat-val">{formatNum(stats.total)}</span><span className="stat-label">Total lifelogs</span></div>
        <div className="stat"><span className="stat-val">{formatNum(stats.today)}</span><span className="stat-label">Today</span></div>
        <div className="stat"><span className="stat-val">{formatNum(stats.pending)}</span><span className="stat-label">Unprocessed</span></div>
        <div className="stat"><span className="stat-val dim">{relativeTime(stats.last_fetch)}</span><span className="stat-label">Last fetch</span></div>
      </div>
    )
  }
  if (id === 'research') {
    return (
      <div className="agent-stats">
        <div className="stat"><span className="stat-val">{formatNum(stats?.enriched_contacts)}</span><span className="stat-label">Enriched</span></div>
        <div className="stat"><span className="stat-val">{formatNum(stats?.researched_today)}</span><span className="stat-label">Today</span></div>
        <div className="stat"><span className="stat-val dim">{relativeTime(stats?.last_research_at)}</span><span className="stat-label">Last run</span></div>
      </div>
    )
  }
  if (id === 'openai' || id === 'gemini') {
    return (
      <div className="agent-stats">
        <div className="stat"><span className="stat-val">{formatNum(stats.total_conversations)}</span><span className="stat-label">Conversations</span></div>
        <div className="stat"><span className="stat-val">{formatNum(stats.total_messages)}</span><span className="stat-label">Messages</span></div>
        <div className="stat"><span className="stat-val dim">{relativeTime(stats.last_import)}</span><span className="stat-label">Last import</span></div>
      </div>
    )
  }
  return null
}


function LogViewer({ agentId, expanded }) {
  const [logs, setLogs] = useState([])
  const [cursor, setCursor] = useState(null)
  const containerRef = useRef(null)
  const pollerRef = useRef(null)

  const pollLogs = useCallback(async () => {
    const url = `/api/agents/${agentId}/logs` + (cursor ? `?since=${encodeURIComponent(cursor)}` : '')
    try {
      const { logs: newLines } = await apiFetch('GET', url)
      if (!newLines?.length) return
      setCursor(newLines[newLines.length - 1].ts)
      setLogs(prev => {
        const combined = [...prev, ...newLines]
        return combined.slice(-300)
      })
    } catch { /* ignore */ }
  }, [agentId, cursor])

  useEffect(() => {
    if (expanded) {
      pollLogs()
      pollerRef.current = setInterval(pollLogs, 2000)
    } else {
      clearInterval(pollerRef.current)
    }
    return () => clearInterval(pollerRef.current)
  }, [expanded]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (containerRef.current) {
      const el = containerRef.current
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (atBottom) el.scrollTop = el.scrollHeight
    }
  }, [logs])

  function clearLogs() {
    setLogs([])
    setCursor(null)
  }

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <span>Output</span>
        <button className="log-clear" onClick={clearLogs}>Clear</button>
      </div>
      <div className="log-lines" ref={containerRef}>
        {logs.length === 0 ? (
          <div className="log-empty">No output yet — start the agent to see logs.</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className="log-line">
              <span className="log-ts">{fmtTime(line.ts)}</span>
              <span className={`log-stream ${line.stream}`}>{line.stream}</span>
              <span className="log-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function EmailConfigForm({ config, onSave }) {
  const [accounts, setAccounts] = useState(config.gmail_accounts || [{ email: '', app_password: '' }])
  const [batchSize, setBatchSize] = useState(config.BATCH_SIZE || '50')
  const [mailbox, setMailbox] = useState(config.MAILBOX || 'INBOX')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    const updates = { gmail_accounts: accounts, BATCH_SIZE: batchSize, MAILBOX: mailbox }
    try {
      const r = await apiFetch('POST', '/api/config', { agent: 'email', updates })
      if (r.error) {
        setFeedback('Save failed: ' + r.error)
      } else {
        setFeedback(r.needsRestart ? '⚠ Restart agent to apply' : 'Saved')
        setTimeout(() => setFeedback(''), 3500)
        onSave()
      }
    } catch { setFeedback('Save failed') }
    setSaving(false)
  }

  function addAccount() {
    setAccounts(prev => [...prev, { email: '', app_password: '' }])
  }

  function removeAccount(idx) {
    if (accounts.length <= 1) return
    setAccounts(prev => prev.filter((_, i) => i !== idx))
  }

  function updateAccount(idx, field, value) {
    setAccounts(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a))
  }

  return (
    <form className="config-form" onSubmit={handleSubmit}>
      <div className="form-section-title">Gmail Accounts</div>
      <div className="gmail-accounts">
        {accounts.map((a, i) => (
          <div className="gmail-account" key={i} data-index={i}>
            <span className="acct-num">Account {i + 1}</span>
            <input type="email" placeholder="user@gmail.com" value={a.email}
              onChange={e => updateAccount(i, 'email', e.target.value)} autoComplete="off" />
            <input type="password" placeholder="xxxx xxxx xxxx xxxx" value={a.app_password}
              onChange={e => updateAccount(i, 'app_password', e.target.value)} autoComplete="new-password" />
            {accounts.length > 1
              ? <button type="button" className="btn-remove" onClick={() => removeAccount(i)}>✕</button>
              : <span />}
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.6rem' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={addAccount}>+ Add Account</button>
      </div>
      <div className="divider" />
      <div className="form-section-title">Sync Options</div>
      <div className="form-row">
        <label>Batch Size</label>
        <input type="number" value={batchSize} onChange={e => setBatchSize(e.target.value)} placeholder="50" min="1" max="500" />
      </div>
      <div className="form-row">
        <label>Mailbox</label>
        <input type="text" value={mailbox} onChange={e => setMailbox(e.target.value)} placeholder="INBOX" />
      </div>
      <div className="form-actions">
        <div>
          <span className={`save-feedback${feedback ? ' visible' : ''}`}>{feedback}</span>
        </div>
        <button type="submit" className="btn btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

function LimitlessConfigForm({ config, onSave }) {
  const [limitlessApiKey, setLimitlessApiKey] = useState(config.LIMITLESS_API_KEY || '')
  const [fetchCron, setFetchCron] = useState(config.FETCH_INTERVAL_CRON || '*/5 * * * *')
  const [processCron, setProcessCron] = useState(config.PROCESS_INTERVAL_CRON || '*/1 * * * *')
  const [fetchDays, setFetchDays] = useState(config.FETCH_DAYS || '1')
  const [batchSize, setBatchSize] = useState(config.PROCESSING_BATCH_SIZE || '15')
  const [aiProvider, setAiProvider] = useState(config.AI_PROVIDER || 'anthropic')
  const [anthropicKey, setAnthropicKey] = useState(config.ANTHROPIC_API_KEY || '')
  const [openaiKey, setOpenaiKey] = useState(config.OPENAI_API_KEY || '')
  const [anthropicModel, setAnthropicModel] = useState(config.AI_ANTHROPIC_MODEL || '')
  const [openaiModel, setOpenaiModel] = useState(config.AI_OPENAI_MODEL || '')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    const updates = {
      LIMITLESS_API_KEY: limitlessApiKey,
      FETCH_INTERVAL_CRON: fetchCron,
      PROCESS_INTERVAL_CRON: processCron,
      FETCH_DAYS: fetchDays,
      PROCESSING_BATCH_SIZE: batchSize,
      AI_PROVIDER: aiProvider,
      ANTHROPIC_API_KEY: anthropicKey,
      OPENAI_API_KEY: openaiKey,
      AI_ANTHROPIC_MODEL: aiProvider === 'claude-cli' ? '' : anthropicModel,
      AI_OPENAI_MODEL: openaiModel,
      AI_CLAUDE_CLI_MODEL: aiProvider === 'claude-cli' ? anthropicModel : '',
    }
    try {
      const r = await apiFetch('POST', '/api/config', { agent: 'limitless', updates })
      if (r.error) {
        setFeedback('Save failed: ' + r.error)
      } else {
        setFeedback(r.needsRestart ? '⚠ Restart agent to apply' : 'Saved')
        setTimeout(() => setFeedback(''), 3500)
        onSave()
      }
    } catch { setFeedback('Save failed') }
    setSaving(false)
  }

  return (
    <form className="config-form" onSubmit={handleSubmit}>
      <div className="form-section-title">Limitless API</div>
      <div className="form-row">
        <label>API Key</label>
        <input type="password" value={limitlessApiKey} onChange={e => setLimitlessApiKey(e.target.value)} placeholder="sk-…" autoComplete="new-password" />
      </div>
      <div className="divider" />
      <div className="form-section-title">AI Provider <span style={{ fontWeight: 400, fontSize: '.7rem', color: 'var(--text-3)', textTransform: 'none', letterSpacing: 0 }}>(applies to all agents — fallback is automatic)</span></div>
      <div className="form-row">
        <label>Preferred provider</label>
        <select value={aiProvider} onChange={e => setAiProvider(e.target.value)}>
          <option value="claude-cli">Claude CLI / OAuth (uses Claude.ai subscription)</option>
          <option value="anthropic">Anthropic API key</option>
          <option value="openai">OpenAI API key</option>
        </select>
      </div>
      {aiProvider === 'claude-cli' && (
        <div className="form-row">
          <label>Model alias</label>
          <input type="text" value={anthropicModel} onChange={e => setAnthropicModel(e.target.value)} placeholder="sonnet (default)" />
        </div>
      )}
      {aiProvider !== 'claude-cli' && (<>
        <div className="form-row">
          <label>Anthropic API Key</label>
          <input type="password" value={anthropicKey} onChange={e => setAnthropicKey(e.target.value)} placeholder="sk-ant-…" autoComplete="new-password" />
        </div>
        <div className="form-row">
          <label>Anthropic model</label>
          <input type="text" value={anthropicModel} onChange={e => setAnthropicModel(e.target.value)} placeholder="claude-sonnet-4-6 (default)" />
        </div>
        <div className="form-row">
          <label>OpenAI API Key</label>
          <input type="password" value={openaiKey} onChange={e => setOpenaiKey(e.target.value)} placeholder="sk-…" autoComplete="new-password" />
        </div>
        <div className="form-row">
          <label>OpenAI model</label>
          <input type="text" value={openaiModel} onChange={e => setOpenaiModel(e.target.value)} placeholder="gpt-4o (default)" />
        </div>
      </>)}
      <div className="divider" />
      <div className="form-section-title">Schedule</div>
      <div className="form-row">
        <label>Fetch interval</label>
        <input type="text" value={fetchCron} onChange={e => setFetchCron(e.target.value)} placeholder="*/5 * * * *" />
      </div>
      <div className="form-row">
        <label>Process interval</label>
        <input type="text" value={processCron} onChange={e => setProcessCron(e.target.value)} placeholder="*/1 * * * *" />
      </div>
      <div className="divider" />
      <div className="form-section-title">Processing</div>
      <div className="form-row">
        <label>Days to fetch</label>
        <input type="number" value={fetchDays} onChange={e => setFetchDays(e.target.value)} placeholder="1" min="1" />
      </div>
      <div className="form-row">
        <label>Batch size</label>
        <input type="number" value={batchSize} onChange={e => setBatchSize(e.target.value)} placeholder="15" min="1" />
      </div>
      <div className="form-actions">
        <div>
          <span className={`save-feedback${feedback ? ' visible' : ''}`}>{feedback}</span>
        </div>
        <button type="submit" className="btn btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

function AiImporterConfigForm({ agentId, config, onSave }) {
  const key         = agentId === 'openai' ? 'OPENAI_EXPORT_PATH' : 'GEMINI_EXPORT_PATH'
  const placeholder = agentId === 'openai'
    ? '~/Downloads/openai-export/conversations.json'
    : '~/Downloads/gemini-export/Gemini Apps Activity.json'
  const hint = agentId === 'openai'
    ? 'chatgpt.com → Settings → Data controls → Export data → unzip → conversations.json'
    : 'takeout.google.com → select "Gemini Apps" → download → unzip → Gemini Apps Activity.json'

  const [exportPath, setExportPath]   = useState(config[key] || '')
  const [watchMins, setWatchMins]     = useState(config.AI_WATCH_INTERVAL_MINUTES || '')
  const [saving, setSaving]           = useState(false)
  const [feedback, setFeedback]       = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    const updates = { [key]: exportPath }
    if (watchMins) updates.AI_WATCH_INTERVAL_MINUTES = watchMins
    try {
      const r = await apiFetch('POST', '/api/config', { agent: agentId, updates })
      if (r.error) {
        setFeedback('Save failed: ' + r.error)
      } else {
        setFeedback(r.needsRestart ? '⚠ Restart agent to apply' : 'Saved')
        setTimeout(() => setFeedback(''), 3500)
        onSave()
      }
    } catch { setFeedback('Save failed') }
    setSaving(false)
  }

  return (
    <form className="config-form" onSubmit={handleSubmit}>
      <div className="form-section-title">Export File</div>
      <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: '.75rem', lineHeight: 1.5 }}>
        {hint}
      </div>
      <div className="form-row">
        <label>File path</label>
        <input type="text" value={exportPath} onChange={e => setExportPath(e.target.value)} placeholder={placeholder} />
      </div>
      <div className="divider" />
      <div className="form-section-title">Auto-reimport (optional)</div>
      <div className="form-row">
        <label>Watch interval (minutes)</label>
        <input type="number" value={watchMins} onChange={e => setWatchMins(e.target.value)}
          placeholder="Leave empty to run once" min="1" />
      </div>
      <div className="form-actions">
        <div><span className={`save-feedback${feedback ? ' visible' : ''}`}>{feedback}</span></div>
        <button type="submit" className="btn btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

function EmbeddingsConfig({ config, onSave }) {
  const [geminiKey, setGeminiKey]   = useState(config.GEMINI_API_KEY || '')
  const [model, setModel]           = useState(config.EMBEDDING_MODEL || '')
  const [saving, setSaving]         = useState(false)
  const [feedback, setFeedback]     = useState('')

  useEffect(() => {
    setGeminiKey(config.GEMINI_API_KEY || '')
    setModel(config.EMBEDDING_MODEL || '')
  }, [config])

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave({ GEMINI_API_KEY: geminiKey, EMBEDDING_MODEL: model || null })
      setFeedback('Saved')
      setTimeout(() => setFeedback(''), 3500)
    } catch { setFeedback('Save failed') }
    setSaving(false)
  }

  return (
    <div style={{ marginBottom: '1.5rem', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
      <div style={{ padding: '0.6rem 1rem', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <strong style={{ fontSize: '0.875rem' }}>Embeddings</strong>
        <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--muted, #888)' }}>semantic search · used by indexer</span>
      </div>
      <form onSubmit={handleSubmit} style={{ padding: '0.75rem 1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 2, minWidth: '200px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted,#888)', marginBottom: '0.25rem' }}>Gemini API Key</div>
          <input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)}
            placeholder="AIza…" autoComplete="new-password" style={{ width: '100%' }} />
        </div>
        <div style={{ flex: 1, minWidth: '180px' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted,#888)', marginBottom: '0.25rem' }}>Embedding model</div>
          <input type="text" value={model} onChange={e => setModel(e.target.value)}
            placeholder="gemini-embedding-2-preview" style={{ width: '100%' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {feedback && <span style={{ fontSize: '0.8rem', color: '#22c55e' }}>{feedback}</span>}
          <button type="submit" className="btn btn-save" disabled={saving} style={{ fontSize: '0.8rem', padding: '0.35rem 0.8rem' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

function ResearchConfigForm({ config, onSave }) {
  const [tavily, setTavily]     = useState(config.TAVILY_API_KEY || '')
  const [pdl, setPdl]           = useState(config.PEOPLEDATALABS_API_KEY || '')
  const [serp, setSerp]         = useState(config.SERPAPI_API_KEY || '')
  const [perplexity, setPerp]   = useState(config.PERPLEXITY_API_KEY || '')
  const [saving, setSaving]     = useState(false)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    setTavily(config.TAVILY_API_KEY || '')
    setPdl(config.PEOPLEDATALABS_API_KEY || '')
    setSerp(config.SERPAPI_API_KEY || '')
    setPerp(config.PERPLEXITY_API_KEY || '')
  }, [config])

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave({
        TAVILY_API_KEY: tavily,
        PEOPLEDATALABS_API_KEY: pdl,
        SERPAPI_API_KEY: serp,
        PERPLEXITY_API_KEY: perplexity,
      })
      setFeedback('Saved')
      setTimeout(() => setFeedback(''), 3500)
    } catch { setFeedback('Save failed') }
    setSaving(false)
  }

  return (
    <form className="config-form" onSubmit={handleSubmit}>
      <div className="form-section-title">Research API Keys</div>
      {[
        ['Tavily API Key', tavily, setTavily, 'tvly-…'],
        ['PeopleDataLabs API Key', pdl, setPdl, 'API key for contact enrichment'],
        ['SerpAPI Key', serp, setSerp, 'SerpAPI key for web search'],
        ['Perplexity API Key', perplexity, setPerp, 'pplx-…'],
      ].map(([label, val, setter, placeholder]) => (
        <div className="form-row" key={label}>
          <label>{label}</label>
          <input type="password" value={val} onChange={e => setter(e.target.value)}
            placeholder={placeholder} autoComplete="new-password" />
        </div>
      ))}
      <div className="form-actions">
        <div><span className={`save-feedback${feedback ? ' visible' : ''}`}>{feedback}</span></div>
        <button type="submit" className="btn btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

function AgentLlmTab({ agentId, llmList, allProviders, onSave, usageRow }) {
  const [list, setList] = useState(llmList || [])
  useEffect(() => setList(llmList || []), [llmList])

  const available = allProviders.filter(p => p.is_enabled && !list.find(l => l.id === p.id))
  const hasExhausted = list.some(p => !p.has_credits)
  const allExhausted = list.length > 0 && list.every(p => !p.has_credits)

  function moveUp(idx) {
    if (idx === 0) return
    const next = [...list]
    ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
    setList(next.map((p, i) => ({ ...p, priority: i + 1 })))
  }

  function removeItem(idx) {
    setList(list.filter((_, i) => i !== idx).map((p, i) => ({ ...p, priority: i + 1 })))
  }

  function addItem(provId) {
    const prov = allProviders.find(p => p.id === Number(provId))
    if (!prov) return
    setList([...list, { ...prov, priority: list.length + 1 }])
  }

  return (
    <div>
      {allExhausted && (
        <div style={{ padding: '0.4rem 0.75rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '5px', marginBottom: '0.5rem', fontSize: '0.8rem', color: '#ef4444' }}>
          ⚠ No working providers — this agent will fail to run
        </div>
      )}
      {hasExhausted && !allExhausted && (
        <div style={{ padding: '0.4rem 0.75rem', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '5px', marginBottom: '0.5rem', fontSize: '0.8rem', color: '#f59e0b' }}>
          ⚠ Some providers have exhausted credits — fallback will be used
        </div>
      )}
      {list.length === 0 ? (
        <div style={{ color: 'var(--muted, #888)', fontSize: '0.8125rem', marginBottom: '0.5rem' }}>No providers assigned to this agent.</div>
      ) : (
        <div style={{ marginBottom: '0.5rem' }}>
          {list.map((p, idx) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0', borderBottom: '1px solid var(--border)', background: !p.has_credits ? 'rgba(245,158,11,0.03)' : 'transparent' }}>
              <span style={{ color: 'var(--muted, #888)', minWidth: '1.2rem', fontSize: '0.8rem' }}>{idx + 1}.</span>
              <span style={{ flex: 1, fontSize: '0.8125rem' }}>{p.name}</span>
              <span style={{ fontSize: '0.7rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.1rem 0.35rem' }}>{p.provider_type}</span>
              <span style={{ color: 'var(--muted, #888)', fontSize: '0.75rem', minWidth: '8rem' }}>{p.model || '—'}</span>
              {!p.has_credits && <span style={{ color: '#f59e0b', fontSize: '0.7rem' }}>⚠ credits</span>}
              <button onClick={() => moveUp(idx)} disabled={idx === 0} title="Move up" style={{ padding: '0 0.3rem', fontSize: '0.85rem', opacity: idx === 0 ? 0.3 : 1, cursor: idx === 0 ? 'default' : 'pointer' }}>↑</button>
              <button onClick={() => removeItem(idx)} title="Remove" style={{ padding: '0 0.3rem', fontSize: '0.85rem', color: 'var(--muted, #888)', cursor: 'pointer' }}>×</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {available.length > 0 && (
          <select defaultValue="" onChange={e => { if (e.target.value) addItem(e.target.value); e.target.value = '' }}
            style={{ fontSize: '0.8rem' }}>
            <option value="">+ Add provider…</option>
            {available.map(p => <option key={p.id} value={p.id}>{p.name} ({p.provider_type})</option>)}
          </select>
        )}
        <button onClick={() => onSave(agentId, list.map((p, i) => ({ provider_id: p.id, priority: i + 1 })))}
          style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}>
          Save priority
        </button>
      </div>
      {usageRow?.cost_usd > 0 && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--muted, #888)', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
          MTD: {Number((usageRow.tokens_in || 0)) + Number((usageRow.tokens_out || 0))} tokens · ${Number(usageRow.cost_usd).toFixed(4)}
        </div>
      )}
    </div>
  )
}

export default function AgentsPage() {
  const [agents, setAgents] = useState({})
  const [toast, setToast] = useState({ message: '', visible: false })
  const toastTimer = useRef(null)

  // LLM provider state
  const [providers, setProviders] = useState([])
  const [showAddProvider, setShowAddProvider] = useState(false)
  const [providerForm, setProviderForm] = useState({ name: '', provider_type: 'anthropic', api_key: '', model: '' })

  // Per-agent LLM priority + config state
  const [agentLlm, setAgentLlm] = useState({})      // { agentId: [rows] }
  const [agentConfig, setAgentConfig] = useState({}) // { agentId: { key: val } }
  const [agentTab, setAgentTab] = useState({})       // { agentId: 'logs'|'config'|'llm' }
  const [usageMtd, setUsageMtd] = useState([])
  const [systemConfig, setSystemConfig] = useState({}) // system.config keys

  function showToast(msg) {
    setToast({ message: msg, visible: true })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(t => ({ ...t, visible: false })), 2500)
  }

  async function loadProviders() {
    try {
      const data = await apiFetch('GET', '/api/system/providers')
      if (Array.isArray(data)) setProviders(data)
    } catch {}
  }

  async function loadAgentLlm(id) {
    try {
      const data = await apiFetch('GET', `/api/system/agents/${id}/llm`)
      if (Array.isArray(data)) setAgentLlm(prev => ({ ...prev, [id]: data }))
    } catch {}
  }

  async function loadAgentConfig(id) {
    if (id === 'research') {
      await loadSystemConfig()
      return
    }
    try {
      const data = await apiFetch('GET', '/api/config')
      if (data && data[id]) {
        setAgentConfig(prev => ({ ...prev, [id]: data[id] }))
      }
    } catch {}
  }

  async function loadUsageMtd() {
    try {
      const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
      const data = await apiFetch('GET', `/api/system/usage?group_by=agent&since=${since}`)
      if (Array.isArray(data)) setUsageMtd(data)
    } catch {}
  }

  async function loadSystemConfig() {
    try {
      const data = await apiFetch('GET', '/api/system/config')
      if (data && !data.error) setSystemConfig(data)
    } catch {}
  }

  async function saveSystemConfig(updates) {
    try {
      await apiFetch('PUT', '/api/system/config', updates)
      await loadSystemConfig()
      showToast('Saved')
    } catch (err) { showToast(err.message || 'Save failed') }
  }

  async function refresh() {
    try {
      const data = await apiFetch('GET', '/api/agents')
      setAgents(data)
    } catch {}
  }

  useEffect(() => {
    refresh()
    loadProviders()
    loadUsageMtd()
    loadSystemConfig()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [])


  async function handleStart(id) {
    try {
      await apiFetch('POST', `/api/agents/${id}/start`)
      showToast(`${agents[id]?.name} started`)
    } catch (err) { showToast(err.message || 'Request failed') }
    refresh()
  }

  async function handleStop(id) {
    try {
      await apiFetch('POST', `/api/agents/${id}/stop`)
      showToast(`${agents[id]?.name} stopping…`)
    } catch (err) { showToast(err.message || 'Request failed') }
    refresh()
  }

  const [importing, setImporting] = useState({}) // { agentId: true|false }
  const importInputRef = useRef({})

  async function handleImport(id, file) {
    if (!file) return
    setImporting(prev => ({ ...prev, [id]: true }))
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const result = await apiFetch('POST', `/api/agents/${id}/import`, data)
      showToast(`Imported ${result.convsImported} conversations, ${result.msgsImported} messages`)
    } catch (err) {
      showToast(err.message || 'Import failed')
    }
    setImporting(prev => ({ ...prev, [id]: false }))
  }

  async function addProvider() {
    if (!providerForm.name.trim()) { showToast('Name is required'); return }
    try {
      await apiFetch('POST', '/api/system/providers', providerForm)
      setShowAddProvider(false)
      setProviderForm({ name: '', provider_type: 'anthropic', api_key: '', model: '' })
      await loadProviders()
      showToast('Provider added')
    } catch (err) { showToast(err.message || 'Failed to add provider') }
  }

  async function resetProviderCredits(id) {
    try {
      await apiFetch('POST', `/api/system/providers/${id}/reset-credits`)
      await loadProviders()
    } catch {}
  }

  async function deleteProvider(id) {
    if (!confirm('Delete this provider?')) return
    try {
      await apiFetch('DELETE', `/api/system/providers/${id}`)
      await loadProviders()
    } catch {}
  }

  async function saveLlmPriority(agentId, list) {
    try {
      await apiFetch('PUT', `/api/system/agents/${agentId}/llm`, list)
      await loadAgentLlm(agentId)
      showToast('LLM priority saved')
    } catch { showToast('Save failed') }
  }


  function getTab(agentId) {
    return agentTab[agentId] || 'logs'
  }

  function setTab(agentId, tab) {
    setAgentTab(prev => ({ ...prev, [agentId]: tab }))
    if (tab === 'llm' && !agentLlm[agentId]) loadAgentLlm(agentId)
    if (tab === 'config') loadAgentConfig(agentId)
  }

  const agentIds = Object.keys(agents)

  return (
    <>
      <div className="main">
        <h1 className="page-heading">Configure <em>your agents</em></h1>
        <p className="page-desc">Start, stop, and configure each background agent from one place.</p>

        {/* ── Global LLM Providers Panel ── */}
        <div style={{ marginBottom: '1.5rem', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
          <div style={{ padding: '0.6rem 1rem', background: 'var(--surface)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.875rem' }}>LLM Providers</strong>
            <button onClick={() => setShowAddProvider(s => !s)} style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}>+ Add</button>
          </div>

          {showAddProvider && (
            <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <input placeholder="Name" value={providerForm.name}
                onChange={e => setProviderForm(f => ({ ...f, name: e.target.value }))}
                style={{ flex: 1, minWidth: '120px' }} />
              <select value={providerForm.provider_type}
                onChange={e => setProviderForm(f => ({ ...f, provider_type: e.target.value }))}>
                <option value="anthropic">Anthropic</option>
                <option value="claude_cli">Claude CLI</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
              </select>
              {providerForm.provider_type !== 'claude_cli' && (
                <input placeholder="API Key" type="password" value={providerForm.api_key}
                  onChange={e => setProviderForm(f => ({ ...f, api_key: e.target.value }))}
                  style={{ flex: 2, minWidth: '200px' }} />
              )}
              <input placeholder="Model (e.g. claude-sonnet-4-6)" value={providerForm.model}
                onChange={e => setProviderForm(f => ({ ...f, model: e.target.value }))}
                style={{ flex: 2, minWidth: '180px' }} />
              <button onClick={addProvider} style={{ fontSize: '0.8rem', padding: '0.3rem 0.8rem' }}>Save</button>
            </div>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Name', 'Type', 'Model', 'Status', 'Cost MTD', ''].map(h => (
                  <th key={h} style={{ textAlign: h === 'Cost MTD' ? 'right' : 'left', padding: '0.5rem 1rem', fontWeight: 500, color: 'var(--muted, #888)', fontSize: '0.75rem' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {providers.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '1rem', textAlign: 'center', color: 'var(--muted, #888)', fontSize: '0.8125rem' }}>No providers configured — add one above.</td></tr>
              ) : providers.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border)', background: !p.has_credits ? 'rgba(245,158,11,0.04)' : 'transparent' }}>
                  <td style={{ padding: '0.5rem 1rem' }}>{p.name}</td>
                  <td style={{ padding: '0.5rem 1rem' }}>
                    <span style={{ fontSize: '0.7rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.1rem 0.4rem' }}>{p.provider_type}</span>
                  </td>
                  <td style={{ padding: '0.5rem 1rem', color: 'var(--muted, #888)' }}>{p.model || '—'}</td>
                  <td style={{ padding: '0.5rem 1rem' }}>
                    {!p.is_enabled ? (
                      <span style={{ color: '#888', fontSize: '0.75rem' }}>Disabled</span>
                    ) : !p.has_credits ? (
                      <span style={{ color: '#f59e0b', fontSize: '0.75rem' }}>
                        ⚠ Credits exhausted
                        <button onClick={() => resetProviderCredits(p.id)} style={{ marginLeft: '0.5rem', fontSize: '0.7rem', padding: '0.1rem 0.3rem', cursor: 'pointer' }}>Reset</button>
                      </span>
                    ) : (
                      <span style={{ color: '#22c55e', fontSize: '0.75rem' }}>✓ OK</span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 1rem', textAlign: 'right', color: 'var(--muted, #888)' }}>
                    {p.cost_mtd > 0 ? `$${Number(p.cost_mtd).toFixed(4)}` : '—'}
                  </td>
                  <td style={{ padding: '0.5rem 1rem', textAlign: 'right' }}>
                    <button onClick={() => deleteProvider(p.id)} title="Delete" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted, #888)', fontSize: '0.875rem' }}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Embeddings Config ── */}
        <EmbeddingsConfig config={systemConfig} onSave={saveSystemConfig} />

        {/* ── Agent List ── */}
        {agentIds.length === 0 ? (
          <p style={{ color: 'var(--text-3, #888)', fontSize: '.85rem' }}>Loading…</p>
        ) : (
          agentIds.map(id => {
            const agent = agents[id]
            const s = agent.status
            const tab = getTab(id)
            const usageRow = usageMtd.find(u => u.agent_id === id)

            return (
              <section key={id} className="agent-section" data-id={id} data-status={s}>
                <div className="agent-header">
                  <div className="agent-accent" />
                  <div className="agent-meta">
                    <div className="agent-name">{agent.name}</div>
                    <div className="agent-description">{agent.description}</div>
                  </div>
                  <div className="agent-controls">
                    {usageRow?.cost_usd > 0 && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-3, #888)' }}>
                        MTD: ${Number(usageRow.cost_usd).toFixed(4)}
                      </span>
                    )}
                    {s === 'running' && agent.startTime && (
                      <span style={{ fontSize: '.75rem', color: 'var(--text-3, #888)' }}>started {relativeTime(agent.startTime)}</span>
                    )}
                    {(id === 'openai' || id === 'gemini') ? (
                      <>
                        <input
                          type="file" accept=".json"
                          style={{ display: 'none' }}
                          ref={el => { importInputRef.current[id] = el }}
                          onChange={e => { handleImport(id, e.target.files[0]); e.target.value = '' }}
                        />
                        <button className="btn btn-primary"
                          disabled={importing[id]}
                          onClick={() => importInputRef.current[id]?.click()}>
                          {importing[id] ? 'Importing…' : '↑ Import JSON'}
                        </button>
                      </>
                    ) : (
                      <>
                        <StatusPill status={s} />
                        {s === 'running'
                          ? <button className="btn btn-stop" onClick={() => handleStop(id)}>&#9632; Stop</button>
                          : <button className="btn btn-primary" onClick={() => handleStart(id)}>&#9654; Start</button>}
                      </>
                    )}
                  </div>
                </div>

                <AgentStats id={id} stats={agent.stats} />

                {/* Tab buttons */}
                <div style={{ display: 'flex', gap: '0.25rem', padding: '0.5rem 0 0 0', borderTop: '1px solid var(--border)', marginTop: '0.5rem' }}>
                  {['logs', 'config', 'llm'].map(t => (
                    <button key={t}
                      onClick={() => setTab(id, t)}
                      style={{
                        fontSize: '0.8rem', padding: '0.3rem 0.75rem', borderRadius: '5px',
                        background: tab === t ? 'var(--text)' : 'transparent',
                        color: tab === t ? 'var(--bg)' : 'var(--text)',
                        border: `1px solid ${tab === t ? 'var(--text)' : 'var(--border)'}`,
                        cursor: 'pointer',
                      }}>
                      {t === 'llm' ? 'LLM' : t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div style={{ padding: '0.75rem 0' }}>
                  {/* Logs tab */}
                  {tab === 'logs' && (
                    <LogViewer agentId={id} expanded={true} />
                  )}

                  {/* Config tab */}
                  {tab === 'config' && (
                    <div>
                      {id === 'email' && agentConfig[id] && (
                        <EmailConfigForm config={agentConfig[id]} onSave={() => loadAgentConfig(id)} />
                      )}
                      {id === 'limitless' && agentConfig[id] && (
                        <LimitlessConfigForm config={agentConfig[id]} onSave={() => loadAgentConfig(id)} />
                      )}
                      {id === 'research' && (
                        <ResearchConfigForm config={systemConfig} onSave={saveSystemConfig} />
                      )}
                      {!['email', 'limitless', 'research', 'openai', 'gemini'].includes(id) && (
                        <div style={{ color: 'var(--text-3, #888)', fontSize: '.825rem' }}>No configurable options for this agent.</div>
                      )}
                    </div>
                  )}

                  {/* LLM tab */}
                  {tab === 'llm' && (
                    <AgentLlmTab
                      agentId={id}
                      llmList={agentLlm[id] || []}
                      allProviders={providers}
                      onSave={saveLlmPriority}
                      usageRow={usageRow}
                    />
                  )}
                </div>
              </section>
            )
          })
        )}
      </div>
      <Toast message={toast.message} visible={toast.visible} />
    </>
  )
}
