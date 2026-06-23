'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import styles from './observe.module.css'

// ── Helpers ───────────────────────────────────────────────────────────────────

function ago(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function mw(val) {
  if (val == null) return '—'
  return val >= 1000 ? `${(val / 1000).toFixed(1)}W` : `${val}mW`
}

// Maps a status string to a CSS module pill class
const PILL_CLASS = {
  running:  'pillRunning',
  success:  'pillSuccess',
  ok:       'pillSuccess',
  failed:   'pillFailed',
  error:    'pillFailed',
  critical: 'pillCritical',
  warning:  'pillWarning',
  info:     'pillInfo',
}

function Pill({ status }) {
  const cls = PILL_CLASS[status] ? styles[PILL_CLASS[status]] : ''
  return <span className={`${styles.pill} ${cls}`}>{status}</span>
}

function MetricPct({ val, warn = 70, crit = 90 }) {
  if (val == null) return <span className={styles.dim}>—</span>
  const cls = val >= crit ? styles.metricCrit : val >= warn ? styles.metricWarn : styles.metricOk
  return <span className={`${styles.bigMetric} ${cls}`}>{parseFloat(val).toFixed(1)}%</span>
}

function ProgressBar({ completed, total }) {
  const pct = total ? Math.min(100, Math.round((completed / total) * 100)) : 0
  return (
    <div>
      {completed}{total ? `/${total}` : ''}
      {total ? (
        <div className={styles.bar}>
          <div className={styles.barFill} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  )
}

async function apiFetch(path) {
  try {
    const r = await fetch(path)
    if (!r.ok) return { _error: `${r.status} ${r.statusText || 'request failed'}` }
    return r.json()
  } catch (err) { return { _error: err?.message || 'request failed' } }
}

// ── View: Overview ────────────────────────────────────────────────────────────

function Overview({ sys, agents, alerts }) {
  const s = sys?.sample || {}
  const activeRuns = (agents?.runs || []).filter(r => !r.ended_at)
  const activeAlerts = (alerts?.alerts || []).filter(a => !a.resolved_at).slice(0, 5)

  return (
    <>
      <div className={styles.grid2}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>GPU</div>
          <MetricPct val={s.gpu_active_residency_pct} />
          <div className={styles.sub}>Power: {mw(s.gpu_power_mw)} &nbsp; ANE: {mw(s.ane_power_mw)}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>CPU</div>
          <MetricPct val={s.cpu_util_pct} />
          <div className={styles.sub}>Power: {mw(s.cpu_power_mw)}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Memory</div>
          <span className={styles.bigMetric}>
            {s.mem_used_mb ? `${Math.round(s.mem_used_mb / 1024)}GB` : '—'}
          </span>
          <div className={styles.sub}>
            Swap: {s.swap_used_mb != null ? `${Math.round(s.swap_used_mb / 1024)}GB` : '—'}&nbsp;
            Thermal: {s.thermal_state || '—'}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Loaded Models</div>
          <span className={styles.bigMetric}>{(sys?.models || []).length}</span>
          <div className={styles.sub}>
            {(sys?.models || []).map(m => m.model_name).join(', ') || 'none'}
          </div>
        </div>
      </div>
      <div className={styles.grid2}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Active Agents</div>
          {activeRuns.length === 0 ? (
            <div className={styles.empty}>No active agents</div>
          ) : (
            <table className={styles.table}>
              <thead><tr><th>Agent</th><th>Status</th><th>Since</th></tr></thead>
              <tbody>
                {activeRuns.map(r => (
                  <tr key={r.run_id}>
                    <td>{r.agent_name}</td>
                    <td><Pill status="running" /></td>
                    <td>{ago(r.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>Active Alerts</div>
          {activeAlerts.length === 0 ? (
            <div className={styles.noAlerts}>No active alerts</div>
          ) : activeAlerts.map((a) => (
            <div key={`${a.fired_at}-${a.message}`} className={styles.alertItem}>
              <Pill status={a.severity} />
              {a.message}
              <span className={styles.dim}>{ago(a.fired_at)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ── View: Agents ──────────────────────────────────────────────────────────────

function Agents({ data }) {
  const runs = data?.runs || []
  const byRun = {}
  for (const p of (data?.progress || [])) {
    if (!byRun[p.run_id]) byRun[p.run_id] = []
    byRun[p.run_id].push(p)
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr><th>Agent</th><th>Status</th><th>Stage</th><th>Progress</th><th>Errors</th><th>Started</th></tr>
        </thead>
        <tbody>
          {runs.length === 0 ? (
            <tr><td colSpan={6} className={styles.empty}>No runs yet</td></tr>
          ) : runs.map(r => {
            const stages = byRun[r.run_id] || []
            const latest = stages[stages.length - 1]
            const status = r.ended_at ? (r.status || 'done') : 'running'
            return (
              <tr key={r.run_id}>
                <td>{r.agent_name}</td>
                <td><Pill status={status} /></td>
                <td>{latest?.stage_name || '—'}</td>
                <td>
                  {latest
                    ? <ProgressBar completed={latest.units_completed} total={latest.units_total} />
                    : '—'}
                  {latest?.eta_seconds
                    ? <div className={styles.dim}>ETA ~{Math.round(latest.eta_seconds / 60)}m</div>
                    : null}
                </td>
                <td>{r.error_count || 0}</td>
                <td>{ago(r.started_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── View: Models ──────────────────────────────────────────────────────────────

function Models({ data }) {
  const stats = data?.stats || []
  const sessions = (data?.sessions || []).slice(0, 20)
  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>7-Day Stats</div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Model</th><th>Requests</th><th>Tokens In</th><th>Tokens Out</th><th>Avg Latency</th><th>Errors</th><th>Last Used</th></tr>
            </thead>
            <tbody>
              {stats.length === 0 ? (
                <tr><td colSpan={7} className={styles.empty}>No model data yet</td></tr>
              ) : stats.map((s) => (
                <tr key={s.model}>
                  <td>{s.model}</td>
                  <td>{s.total_requests}</td>
                  <td>{Number(s.total_prompt_tokens || 0).toLocaleString()}</td>
                  <td>{Number(s.total_completion_tokens || 0).toLocaleString()}</td>
                  <td>{s.avg_latency_ms ? `${s.avg_latency_ms}ms` : '—'}</td>
                  <td>{s.error_count || 0}</td>
                  <td>{ago(s.last_used_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Loaded Sessions</div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Model</th><th>Loaded</th><th>Last Used</th><th>Unloaded</th></tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr><td colSpan={4} className={styles.empty}>No sessions</td></tr>
              ) : sessions.map((s) => (
                <tr key={`${s.model_name}-${s.loaded_at}`}>
                  <td>{s.model_name}</td>
                  <td>{ago(s.loaded_at)}</td>
                  <td>{ago(s.last_used_at)}</td>
                  <td>{s.unloaded_at ? ago(s.unloaded_at) : <Pill status="running" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ── View: Traces ──────────────────────────────────────────────────────────────

function Traces({ data, filters, onFilterChange }) {
  const requests = data?.requests || []
  return (
    <>
      <div className={styles.filterRow}>
        <input
          className={styles.filterInput}
          placeholder="Agent"
          value={filters.agent}
          onChange={e => onFilterChange({ ...filters, agent: e.target.value })}
        />
        <input
          className={styles.filterInput}
          placeholder="Model"
          value={filters.model}
          onChange={e => onFilterChange({ ...filters, model: e.target.value })}
        />
        <select
          className={styles.filterSelect}
          value={filters.success}
          onChange={e => onFilterChange({ ...filters, success: e.target.value })}
        >
          <option value="">All</option>
          <option value="true">Success</option>
          <option value="false">Failures</option>
        </select>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr><th>Agent</th><th>Model</th><th>Task</th><th>Status</th><th>Tokens</th><th>Latency</th><th>Preview</th><th>When</th></tr>
          </thead>
          <tbody>
            {requests.length === 0 ? (
              <tr><td colSpan={8} className={styles.empty}>No traces yet</td></tr>
            ) : requests.map((r, i) => (
              <tr key={i}>
                <td>{r.agent_name || '—'}</td>
                <td>{r.model || '—'}</td>
                <td>{r.task_type || '—'}</td>
                <td><Pill status={r.success ? 'success' : 'failed'} /></td>
                <td>{(r.prompt_tokens || 0) + (r.completion_tokens || 0)}</td>
                <td>{r.duration_ms ? `${r.duration_ms}ms` : '—'}</td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.output_preview || r.prompt_preview || '—'}
                </td>
                <td>{ago(r.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ── View: Quality ─────────────────────────────────────────────────────────────

function Quality({ data, onRate }) {
  const comparison = data?.comparison || []
  const recentTraces = data?.recentTraces || []
  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>7-Day Model Comparison</div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Model</th><th>Agent</th><th>Task</th><th>Total</th><th>Errors</th><th>Avg Retries</th><th>Structural</th><th>Human</th></tr>
            </thead>
            <tbody>
              {comparison.length === 0 ? (
                <tr><td colSpan={8} className={styles.empty}>No quality data yet</td></tr>
              ) : comparison.map((r, i) => (
                <tr key={i}>
                  <td>{r.model || '—'}</td>
                  <td>{r.agent_name || '—'}</td>
                  <td>{r.task_type || '—'}</td>
                  <td>{r.total}</td>
                  <td>{r.errors || 0}</td>
                  <td>{r.avg_retries ? parseFloat(r.avg_retries).toFixed(2) : '0'}</td>
                  <td>{r.avg_structural ? parseFloat(r.avg_structural).toFixed(2) : '—'}</td>
                  <td>{r.avg_human ? parseFloat(r.avg_human).toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Rate Recent Traces</div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>Agent</th><th>Model</th><th>Preview</th><th>Rate</th></tr>
            </thead>
            <tbody>
              {recentTraces.length === 0 ? (
                <tr><td colSpan={4} className={styles.empty}>No traces</td></tr>
              ) : recentTraces.map((r, i) => (
                <tr key={i}>
                  <td>{r.agent_name || '—'}</td>
                  <td>{r.model || '—'}</td>
                  <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.output_preview || '—'}
                  </td>
                  <td>
                    <button className={`${styles.rateBtn} ${styles.rateGood}`} onClick={() => onRate(r.request_id, 'good')}>Good</button>
                    <button className={`${styles.rateBtn} ${styles.rateOk}`}   onClick={() => onRate(r.request_id, 'acceptable')}>OK</button>
                    <button className={`${styles.rateBtn} ${styles.ratePoor}`} onClick={() => onRate(r.request_id, 'poor')}>Poor</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const VIEWS = ['overview', 'agents', 'models', 'traces', 'quality']

export default function ObservePage() {
  const [view, setView]             = useState('overview')
  const [sysData, setSysData]       = useState(null)
  const [agentsData, setAgentsData] = useState(null)
  const [alertsData, setAlertsData] = useState(null)
  const [modelsData, setModelsData] = useState(null)
  const [tracesData, setTracesData] = useState(null)
  const [qualityData, setQualityData] = useState(null)
  const [traceFilters, setTraceFilters] = useState({ agent: '', model: '', success: '' })
  const viewRef = useRef(view)
  viewRef.current = view

  const fetchOverview = useCallback(async () => {
    const [sys, agents, alerts] = await Promise.all([
      apiFetch('/api/observe/system'),
      apiFetch('/api/observe/agents'),
      apiFetch('/api/observe/alerts'),
    ])
    setSysData(sys)
    setAgentsData(agents)
    setAlertsData(alerts)
  }, [])

  const fetchTraces = useCallback(async (filters) => {
    const params = new URLSearchParams({ limit: '50' })
    if (filters.agent)          params.set('agent',   filters.agent)
    if (filters.model)          params.set('model',   filters.model)
    if (filters.success !== '') params.set('success', filters.success)
    setTracesData(await apiFetch(`/api/observe/requests?${params}`))
  }, [])

  const fetchQuality = useCallback(async () => {
    const [q, t] = await Promise.all([
      apiFetch('/api/observe/quality'),
      apiFetch('/api/observe/requests?limit=20'),
    ])
    setQualityData({ comparison: q.comparison || [], recentTraces: t.requests || [] })
  }, [])

  useEffect(() => {
    if (view === 'overview') fetchOverview()
    else if (view === 'agents')  apiFetch('/api/observe/agents').then(setAgentsData)
    else if (view === 'models')  apiFetch('/api/observe/models').then(setModelsData)
    else if (view === 'traces')  fetchTraces(traceFilters)
    else if (view === 'quality') fetchQuality()
  }, [view, fetchOverview, fetchTraces, fetchQuality])

  // SSE uses the same API process as the rest of the dashboard.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const es = new EventSource('/api/observe/stream')
    es.onmessage = () => { if (viewRef.current === 'overview') fetchOverview() }
    es.onerror   = () => es.close()
    return () => es.close()
  }, [fetchOverview])

  function handleFilterChange(filters) {
    setTraceFilters(filters)
    fetchTraces(filters)
  }

  async function handleRate(requestId, scoreLabel) {
    await fetch('/api/observe/quality/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, scoreLabel }),
    })
    fetchQuality()
  }

  const observeError = [sysData, agentsData, alertsData, modelsData, tracesData, qualityData]
    .find(d => d?._error)?._error

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>Observe</h1>
      <p className={styles.desc}>Live telemetry — agents, models, traces, quality</p>
      {observeError && (
        <div className={styles.errorBanner}>
          Observe API unavailable: <code>{observeError}</code>. Restart <code>npm run ui:dev</code> so the integrated API is serving <code>/api/observe</code>.
        </div>
      )}
      <div className={styles.tabs}>
        {VIEWS.map(v => (
          <button
            key={v}
            className={`${styles.tab} ${view === v ? styles.tabActive : ''}`}
            onClick={() => setView(v)}
          >
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      {view === 'overview' && <Overview sys={sysData}    agents={agentsData} alerts={alertsData} />}
      {view === 'agents'   && <Agents   data={agentsData} />}
      {view === 'models'   && <Models   data={modelsData} />}
      {view === 'traces'   && <Traces   data={tracesData} filters={traceFilters} onFilterChange={handleFilterChange} />}
      {view === 'quality'  && <Quality  data={qualityData} onRate={handleRate} />}
    </div>
  )
}
