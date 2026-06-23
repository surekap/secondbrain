'use strict'

function esc(s) {
  if (s == null) return '—'
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Navigation ──────────────────────────────────────────────────────────────
const views = ['overview','agents','models','traces','quality']
let currentView = 'overview'

document.querySelectorAll('nav button').forEach(btn => {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.view
    document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'))
    document.getElementById(currentView).classList.add('active')
    renderView(currentView)
  })
})

async function api(path) {
  try {
    const r = await fetch(path)
    if (!r.ok) {
      console.warn('[observe] API error:', path, r.status)
      return {}
    }
    return r.json()
  } catch (err) {
    console.warn('[observe] fetch failed:', path, err.message)
    return {}
  }
}

// ── Rendering helpers ────────────────────────────────────────────────────────
function pct(val, warn=70, crit=90) {
  if (val == null) return '<span style="color:var(--dim)">—</span>'
  const cls = val >= crit ? 'crit' : val >= warn ? 'warn' : 'ok'
  return `<span class="metric ${cls}">${parseFloat(val).toFixed(1)}%</span>`
}
function mw(val) {
  if (val == null) return '—'
  return val >= 1000 ? `${(val/1000).toFixed(1)}W` : `${val}mW`
}
function pill(status) {
  return `<span class="pill ${status}">${status}</span>`
}
function bar(val, max=100) {
  const p = Math.min(100, Math.round((val||0)/max*100))
  return `<div class="bar"><div class="bar-fill" style="width:${p}%"></div></div>`
}
function ago(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso))/1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  return `${Math.floor(s/3600)}h ago`
}

// ── Overview ─────────────────────────────────────────────────────────────────
async function renderOverview() {
  const el = document.getElementById('overview')
  const [sys, agents, alertsData] = await Promise.all([
    api('/api/system'), api('/api/agents'), api('/api/alerts')
  ])
  const s = sys.sample || {}
  const recent = (alertsData.alerts||[]).filter(a => !a.resolved_at).slice(0,5)
  el.innerHTML = `
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <h3>GPU</h3>
        ${pct(s.gpu_active_residency_pct, 70, 90)}
        <div class="subtext">Power: ${mw(s.gpu_power_mw)} &nbsp; ANE: ${mw(s.ane_power_mw)}</div>
      </div>
      <div class="card">
        <h3>CPU</h3>
        ${pct(s.cpu_util_pct, 70, 90)}
        <div class="subtext">Power: ${mw(s.cpu_power_mw)}</div>
      </div>
      <div class="card">
        <h3>Memory</h3>
        <span class="metric">${s.mem_used_mb ? Math.round(s.mem_used_mb/1024)+'GB' : '—'}</span>
        <div class="subtext">Swap: ${s.swap_used_mb ? Math.round(s.swap_used_mb/1024)+'GB' : '0'} &nbsp; Thermal: ${esc(s.thermal_state)}</div>
      </div>
      <div class="card">
        <h3>Loaded Models</h3>
        <span class="metric">${sys.models.length}</span>
        <div class="subtext">${sys.models.map(m=>esc(m.model_name)).join(', ')||'none'}</div>
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card">
        <h3>Active Agents</h3>
        <table>
          <tr><th>Agent</th><th>Status</th><th>Since</th></tr>
          ${(agents.runs||[]).filter(r=>!r.ended_at).map(r=>`
            <tr><td>${esc(r.agent_name)}</td><td>${pill('running')}</td><td>${ago(r.started_at)}</td></tr>
          `).join('')||'<tr><td colspan="3" style="color:var(--dim)">No active agents</td></tr>'}
        </table>
      </div>
      <div class="card">
        <h3>Recent Alerts</h3>
        ${recent.length === 0 ? '<div style="color:var(--green)">No active alerts</div>' :
          recent.map(a=>`<div style="margin-bottom:8px">${pill(a.severity)} ${esc(a.message)} <span class="subtext">${ago(a.fired_at)}</span></div>`).join('')}
      </div>
    </div>
  `
}

// ── Agents ───────────────────────────────────────────────────────────────────
async function renderAgents() {
  const el = document.getElementById('agents')
  const { runs, progress } = await api('/api/agents')
  const progressByRun = {}
  for (const p of (progress||[])) {
    if (!progressByRun[p.run_id]) progressByRun[p.run_id] = []
    progressByRun[p.run_id].push(p)
  }
  el.innerHTML = `
    <table>
      <tr><th>Agent</th><th>Status</th><th>Stage</th><th>Progress</th><th>Errors</th><th>Started</th></tr>
      ${(runs||[]).map(r => {
        const stages = progressByRun[r.run_id] || []
        const latest = stages[stages.length-1]
        const pctDone = latest?.units_total ? Math.round(latest.units_completed/latest.units_total*100) : null
        const status = r.ended_at ? r.status : 'running'
        return `<tr>
          <td>${esc(r.agent_name)}</td>
          <td>${pill(status)}</td>
          <td>${esc(latest?.stage_name)}</td>
          <td>
            ${latest ? `${esc(latest.units_completed)}${latest.units_total ? '/'+esc(latest.units_total) : ''}` : '—'}
            ${pctDone != null ? bar(pctDone) : ''}
            ${latest?.eta_seconds ? `<div class="subtext">ETA ~${Math.round(latest.eta_seconds/60)}m</div>` : ''}
          </td>
          <td>${r.error_count||0}</td>
          <td>${ago(r.started_at)}</td>
        </tr>`
      }).join('')||'<tr><td colspan="6" style="color:var(--dim)">No runs yet</td></tr>'}
    </table>
  `
}

// ── Models ───────────────────────────────────────────────────────────────────
async function renderModels() {
  const el = document.getElementById('models')
  const { stats, sessions } = await api('/api/models')
  el.innerHTML = `
    <div style="margin-bottom:16px">
      <h3 style="margin-bottom:10px;color:var(--dim);font-size:11px;text-transform:uppercase">Session Stats</h3>
      <table>
        <tr><th>Model</th><th>Requests</th><th>Tokens In</th><th>Tokens Out</th><th>Avg Latency</th><th>Errors</th><th>Last Used</th></tr>
        ${(stats||[]).map(s=>`<tr>
          <td>${esc(s.model)}</td>
          <td>${s.total_requests}</td>
          <td>${(s.total_prompt_tokens||0).toLocaleString()}</td>
          <td>${(s.total_completion_tokens||0).toLocaleString()}</td>
          <td>${s.avg_latency_ms ? s.avg_latency_ms+'ms' : '—'}</td>
          <td>${s.error_count||0}</td>
          <td>${ago(s.last_used_at)}</td>
        </tr>`).join('')||'<tr><td colspan="7" style="color:var(--dim)">No model data yet</td></tr>'}
      </table>
    </div>
    <div>
      <h3 style="margin-bottom:10px;color:var(--dim);font-size:11px;text-transform:uppercase">Loaded Sessions</h3>
      <table>
        <tr><th>Model</th><th>Loaded</th><th>Last Used</th><th>Unloaded</th></tr>
        ${(sessions||[]).slice(0,20).map(s=>`<tr>
          <td>${esc(s.model_name)}</td>
          <td>${ago(s.loaded_at)}</td>
          <td>${ago(s.last_used_at)}</td>
          <td>${s.unloaded_at ? ago(s.unloaded_at) : '<span class="pill running">loaded</span>'}</td>
        </tr>`).join('')||'<tr><td colspan="4" style="color:var(--dim)">No sessions</td></tr>'}
      </table>
    </div>
  `
}

// ── Traces ───────────────────────────────────────────────────────────────────
let traceFilters = { agent: '', model: '', success: '' }

async function renderTraces() {
  const el = document.getElementById('traces')
  const params = new URLSearchParams()
  if (traceFilters.agent)   params.set('agent', traceFilters.agent)
  if (traceFilters.model)   params.set('model', traceFilters.model)
  if (traceFilters.success !== '') params.set('success', traceFilters.success)
  params.set('limit', '50')
  const { requests } = await api('/api/requests?' + params)
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input placeholder="Agent" value="${traceFilters.agent}" oninput="traceFilters.agent=this.value;renderView('traces')" style="width:140px">
      <input placeholder="Model" value="${traceFilters.model}" oninput="traceFilters.model=this.value;renderView('traces')" style="width:160px">
      <select onchange="traceFilters.success=this.value;renderView('traces')">
        <option value="">All</option>
        <option value="true" ${traceFilters.success==='true'?'selected':''}>Success</option>
        <option value="false" ${traceFilters.success==='false'?'selected':''}>Failures</option>
      </select>
    </div>
    <table>
      <tr><th>Agent</th><th>Model</th><th>Task</th><th>Status</th><th>Tokens</th><th>Latency</th><th>Preview</th><th>When</th></tr>
      ${(requests||[]).map(r=>`<tr>
        <td>${esc(r.agent_name)}</td>
        <td>${esc(r.model)}</td>
        <td>${esc(r.task_type)}</td>
        <td>${r.success ? '<span class="pill running">ok</span>' : '<span class="pill failed">failed</span>'}</td>
        <td>${(r.prompt_tokens||0)+(r.completion_tokens||0)}</td>
        <td>${r.duration_ms ? r.duration_ms+'ms' : '—'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.output_preview||r.prompt_preview)}</td>
        <td>${ago(r.started_at)}</td>
      </tr>`).join('')||'<tr><td colspan="8" style="color:var(--dim)">No traces yet</td></tr>'}
    </table>
  `
}

// ── Quality ──────────────────────────────────────────────────────────────────
async function renderQuality() {
  const el = document.getElementById('quality')
  const { comparison } = await api('/api/quality')
  el.innerHTML = `
    <table>
      <tr><th>Model</th><th>Agent</th><th>Task</th><th>Total</th><th>Errors</th><th>Avg Retries</th><th>Structural</th><th>Human</th></tr>
      ${(comparison||[]).map(r=>`<tr>
        <td>${esc(r.model)}</td>
        <td>${esc(r.agent_name)}</td>
        <td>${esc(r.task_type)}</td>
        <td>${r.total}</td>
        <td>${r.errors||0}</td>
        <td>${r.avg_retries ? parseFloat(r.avg_retries).toFixed(2) : '0'}</td>
        <td>${r.avg_structural ? parseFloat(r.avg_structural).toFixed(2) : '—'}</td>
        <td>${r.avg_human ? parseFloat(r.avg_human).toFixed(2) : '—'}</td>
      </tr>`).join('')||'<tr><td colspan="8" style="color:var(--dim)">No quality data yet</td></tr>'}
    </table>
    <div style="margin-top:20px">
      <h3 style="color:var(--dim);font-size:11px;text-transform:uppercase;margin-bottom:10px">Rate Recent Traces</h3>
      <div id="rate-panel">Loading traces for rating...</div>
    </div>
  `
  const ratePanel = document.getElementById('rate-panel')
  const { requests } = await api('/api/requests?limit=20')
  ratePanel.innerHTML = `
    <table>
      <tr><th>Agent</th><th>Model</th><th>Preview</th><th>Rate</th></tr>
      ${(requests||[]).map(r=>`<tr>
        <td>${esc(r.agent_name)}</td>
        <td>${esc(r.model)}</td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.output_preview)}</td>
        <td>
          <button class="rate-btn good-btn" data-id="${esc(r.request_id)}" data-label="good">Good</button>
          <button class="rate-btn ok-btn"   data-id="${esc(r.request_id)}" data-label="acceptable">OK</button>
          <button class="rate-btn poor-btn" data-id="${esc(r.request_id)}" data-label="poor">Poor</button>
        </td>
      </tr>`).join('')||'<tr><td colspan="4" style="color:var(--dim)">No traces</td></tr>'}
    </table>
  `
  ratePanel.querySelectorAll('.rate-btn').forEach(btn => {
    btn.addEventListener('click', () => rate(btn.dataset.id, btn.dataset.label))
  })
}

async function rate(requestId, label) {
  await fetch('/api/quality/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, scoreLabel: label })
  })
  renderView('quality')
}

// ── View dispatcher ──────────────────────────────────────────────────────────
function renderView(view) {
  switch(view) {
    case 'overview': return renderOverview()
    case 'agents':   return renderAgents()
    case 'models':   return renderModels()
    case 'traces':   return renderTraces()
    case 'quality':  return renderQuality()
  }
}

// ── Auto-refresh overview with SSE ───────────────────────────────────────────
const sse = new EventSource('/api/stream')
sse.onmessage = () => { if (currentView === 'overview') renderOverview() }

// Initial render
renderView('overview')
