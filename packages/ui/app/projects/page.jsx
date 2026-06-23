'use client'
import { Suspense, useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import ResizablePanes from '../../components/ResizablePanes'

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(path, opts)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

function relTime(iso) {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function sourceIcon(source) {
  return { email: '📧', whatsapp: '💬', limitless: '🎙️' }[source] || '📌'
}

function insightTypeIcon(type) {
  return { status: '📊', next_action: '⚡', risk: '⚠️', opportunity: '✨', blocker: '🚧', decision: '🎯' }[type] || '💡'
}

function healthLabel(h) {
  return { on_track: 'On Track', at_risk: 'At Risk', blocked: 'Blocked', unknown: 'Unknown' }[h] || h || 'Unknown'
}

function TagEditor({ tags, onChange }) {
  const [inputVal, setInputVal] = useState('')

  function handleKeyDown(e) {
    if ((e.key === 'Enter' || e.key === ',') && inputVal.trim()) {
      e.preventDefault()
      const tag = inputVal.trim().replace(/,$/, '')
      if (tag && !tags.includes(tag)) onChange([...tags, tag])
      setInputVal('')
    } else if (e.key === 'Backspace' && !inputVal && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="tag-editor" onClick={() => document.getElementById('tag-input-proj')?.focus()}>
      {tags.map((t, i) => (
        <span className="tag-chip" key={i}>
          {t}
          <button className="tag-remove-btn" type="button" onClick={() => onChange(tags.filter((_, idx) => idx !== i))}>✕</button>
        </span>
      ))}
      <input className="tag-input" id="tag-input-proj" type="text"
        placeholder="Add tag, press Enter…" value={inputVal}
        onChange={e => setInputVal(e.target.value)} onKeyDown={handleKeyDown} />
    </div>
  )
}

function ProjectsPageContent() {
  const searchParams = useSearchParams()
  const autoSelectedRef = useRef(false)

  const [projects, setProjects] = useState([])
  const [filteredProjects, setFilteredProjects] = useState([])
  const [selectedProjectId, setSelectedProjectId] = useState(null)
  const [selectedProject, setSelectedProject] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [stats, setStats] = useState(null)
  const [activeDetailTab, setActiveDetailTab] = useState('comms')
  const [activeRightPanel, setActiveRightPanel] = useState('activity')
  const [rightContent, setRightContent] = useState(null)
  const [rightLoading, setRightLoading] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStatus, setEditStatus] = useState('active')
  const [editHealth, setEditHealth] = useState('unknown')
  const [editPriority, setEditPriority] = useState('medium')
  const [editNextAction, setEditNextAction] = useState('')
  const [editTags, setEditTags] = useState([])
  const [savingProject, setSavingProject] = useState(false)
  const [toast, setToast] = useState({ msg: '', visible: false })
  const toastTimer = useRef(null)

  function showToast(msg) {
    setToast({ msg, visible: true })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(t => ({ ...t, visible: false })), 2500)
  }

  function applyFilters(proj, q, status) {
    const filtered = proj.filter(p => {
      if (status && p.status !== status) return false
      if (q && !p.name.toLowerCase().includes(q.toLowerCase()) && !(p.description || '').toLowerCase().includes(q.toLowerCase())) return false
      return true
    })
    setFilteredProjects(filtered)
  }

  async function loadProjects() {
    try {
      const data = await apiFetch('GET', '/api/projects')
      setProjects(data)
      applyFilters(data, searchQuery, statusFilter)
    } catch { /* ignore */ }
  }

  async function loadStats() {
    try {
      const s = await apiFetch('GET', '/api/projects/stats')
      setStats(s)
    } catch { /* ignore */ }
  }

  async function loadRecentActivity() {
    setRightLoading(true)
    try {
      const items = await apiFetch('GET', '/api/projects/activity/recent')
      setRightContent({ type: 'activity', items })
    } catch { setRightContent({ type: 'activity', items: [] }) }
    setRightLoading(false)
  }

  async function loadOpenInsights() {
    setRightLoading(true)
    try {
      const items = await apiFetch('GET', '/api/projects/insights/open')
      setRightContent({ type: 'insights', items })
    } catch { setRightContent({ type: 'insights', items: [] }) }
    setRightLoading(false)
  }

  useEffect(() => {
    loadProjects()
    loadStats()
    loadRecentActivity()
    const interval = setInterval(() => {
      loadStats()
      if (activeRightPanel === 'activity') loadRecentActivity()
      else loadOpenInsights()
    }, 60000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select project from URL param ?project=<id>
  useEffect(() => {
    if (autoSelectedRef.current || !projects.length) return
    const id = parseInt(searchParams.get('project'), 10)
    if (!id) return
    autoSelectedRef.current = true
    selectProject(id)
  }, [projects]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyFilters(projects, searchQuery, statusFilter)
  }, [searchQuery, statusFilter, projects]) // eslint-disable-line react-hooks/exhaustive-deps

  async function selectProject(id) {
    setSelectedProjectId(id)
    setSelectedProject(null)
    setActiveDetailTab('comms')
    try {
      const p = await apiFetch('GET', `/api/projects/${id}`)
      setSelectedProject(p)
    } catch { showToast('Failed to load project') }
  }

  function backToGrid() {
    setSelectedProjectId(null)
    setSelectedProject(null)
  }

  function openEditModal() {
    if (!selectedProject) return
    const p = selectedProject
    setEditName(p.name || '')
    setEditDesc(p.description || '')
    setEditStatus(p.status || 'active')
    setEditHealth(p.health || 'unknown')
    setEditPriority(p.priority || 'medium')
    setEditNextAction(p.next_action || '')
    setEditTags([...(p.tags || [])])
    setEditOpen(true)
  }

  async function saveProject() {
    if (!selectedProject) return
    setSavingProject(true)
    const payload = {
      name: editName.trim(),
      description: editDesc.trim() || null,
      status: editStatus,
      health: editHealth,
      priority: editPriority,
      next_action: editNextAction.trim() || null,
      tags: editTags,
    }
    try {
      const updated = await apiFetch('PATCH', `/api/projects/${selectedProject.id}`, payload)
      setSelectedProject(prev => ({ ...prev, ...updated }))
      setProjects(prev => prev.map(p => p.id === selectedProject.id ? { ...p, ...updated } : p))
      setEditOpen(false)
      showToast('Project updated')
    } catch { showToast('Failed to save project') }
    setSavingProject(false)
  }

  async function archiveProject() {
    if (!selectedProject) return
    if (!window.confirm(`Archive "${selectedProject.name}"? It will be hidden from the dashboard.`)) return
    try {
      await apiFetch('PATCH', `/api/projects/${selectedProject.id}`, { is_archived: true })
      setProjects(prev => prev.filter(p => p.id !== selectedProject.id))
      setSelectedProject(null)
      setSelectedProjectId(null)
      setEditOpen(false)
      showToast('Project archived')
    } catch { showToast('Failed to archive project') }
  }

  async function resolveInsight(id) {
    try {
      await apiFetch('POST', `/api/projects/insights/${id}/resolve`)
      setSelectedProject(prev => prev ? {
        ...prev,
        insights: prev.insights?.map(i => i.id === id ? { ...i, is_resolved: true } : i)
      } : prev)
      showToast('Insight resolved')
      if (activeRightPanel === 'insights') loadOpenInsights()
    } catch { showToast('Failed to resolve insight') }
  }

  async function runAnalysis() {
    try {
      const r = await apiFetch('GET', '/api/projects/run')
      showToast(r.message || r.error || 'Analysis status unavailable')
    } catch { showToast('Agent not running — start it first') }
  }

  function switchRightPanel(panel) {
    setActiveRightPanel(panel)
    if (panel === 'activity') loadRecentActivity()
    else loadOpenInsights()
  }

  function groupByDate(comms) {
    const groups = {}
    for (const c of comms) {
      const key = c.occurred_at ? fmtDate(c.occurred_at) : 'Unknown date'
      if (!groups[key]) groups[key] = []
      groups[key].push(c)
    }
    return groups
  }

  const totalComms = projects.reduce((sum, p) => sum + (p.comm_count || 0), 0)

  return (
    <>
      <style>{`
        .panel-left { background:var(--surface);display:flex;flex-direction:column;overflow:hidden;height:100%; }
        .panel-left-header { padding:.875rem 1rem .75rem;border-bottom:1px solid var(--border);flex-shrink:0; }
        .panel-left-title { font-family:'Fraunces',serif;font-weight:400;font-size:.9rem;color:var(--text);margin-bottom:.625rem; }
        .search-input { width:100%;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:.4rem .6rem;outline:none;transition:border-color .15s;margin-bottom:.5rem; }
        .search-input:focus { border-color:var(--accent-border); }
        .search-input::placeholder { color:var(--text-3); }
        .status-tabs { display:flex;gap:0;overflow-x:auto;scrollbar-width:none; }
        .status-tabs::-webkit-scrollbar { display:none; }
        .status-tab { font-size:.72rem;font-weight:500;color:var(--text-3);padding:.35rem .6rem;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s;background:none;border-top:none;border-left:none;border-right:none; }
        .status-tab:hover { color:var(--text-2); }
        .status-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
        .project-list { flex:1;overflow-y:auto;padding:.375rem 0; }
        .project-list::-webkit-scrollbar { width:4px; }
        .project-row { display:flex;align-items:center;gap:.625rem;padding:.6rem .875rem;cursor:pointer;transition:background .1s;border-left:2px solid transparent; }
        .project-row:hover { background:var(--surface-2); }
        .project-row.active { background:var(--accent-subtle);border-left-color:var(--accent); }
        .health-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0; }
        .health-dot.on_track { background:var(--green); }
        .health-dot.at_risk { background:var(--amber); }
        .health-dot.blocked { background:var(--red); }
        .health-dot.unknown { background:var(--border-strong); }
        .project-row-meta { flex:1;min-width:0; }
        .project-row-name { font-size:.8125rem;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3; }
        .project-row-sub { font-size:.7rem;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.1rem; }
        .project-row-right { display:flex;flex-direction:column;align-items:flex-end;gap:.2rem;flex-shrink:0; }
        .status-badge { font-size:.6rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:.15rem .4rem;border-radius:100px;white-space:nowrap; }
        .status-badge.active { background:var(--green-bg);color:var(--green);border:1px solid var(--green-border); }
        .status-badge.stalled { background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border); }
        .status-badge.completed { background:var(--surface-2);color:var(--text-3);border:1px solid var(--border); }
        .status-badge.on_hold { background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border); }
        .status-badge.unknown { background:var(--surface-2);color:var(--text-3);border:1px solid var(--border); }
        .priority-badge { font-size:.6rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:.15rem .4rem;border-radius:100px; }
        .priority-badge.high { background:var(--red-bg);color:var(--red);border:1px solid var(--red-border); }
        .priority-badge.medium { background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border); }
        .priority-badge.low { background:var(--surface-2);color:var(--text-3);border:1px solid var(--border); }
        .panel-main { display:flex;flex-direction:column;overflow:hidden;background:var(--bg);height:100%; }
        .grid-view { flex:1;overflow-y:auto;padding:1.25rem 1.5rem; }
        .grid-view::-webkit-scrollbar { width:4px; }
        .grid-header { display:flex;align-items:center;gap:1rem;margin-bottom:1rem; }
        .grid-heading { font-family:'Fraunces',serif;font-weight:400;font-size:1.5rem;letter-spacing:-.03em;color:var(--text); }
        .grid-header-actions { margin-left:auto;display:flex;align-items:center;gap:.5rem; }
        .stats-bar { display:flex;gap:1.5rem;margin-bottom:1.25rem;padding:.875rem 1rem;background:var(--surface);border:1px solid var(--border);border-radius:8px; }
        .stat-item { display:flex;flex-direction:column;gap:.15rem; }
        .stat-val { font-family:'Fraunces',serif;font-weight:500;font-size:1.3rem;letter-spacing:-.03em;color:var(--text);line-height:1; }
        .stat-label { font-size:.65rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3); }
        .stat-sep { width:1px;background:var(--border);margin:.1rem 0; }
        .project-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:.875rem; }
        @media (max-width:1200px) { .project-grid { grid-template-columns:repeat(2,1fr); } }
        @media (max-width:900px) { .project-grid { grid-template-columns:1fr; } }
        .project-card { background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;transition:border-color .15s,box-shadow .15s;display:flex;flex-direction:column; }
        .project-card:hover { border-color:var(--border-strong);box-shadow:0 2px 12px oklch(17% .013 75/.06); }
        .card-health-bar { height:3px;flex-shrink:0; }
        .card-health-bar.on_track { background:var(--green); }
        .card-health-bar.at_risk { background:var(--amber); }
        .card-health-bar.blocked { background:var(--red); }
        .card-health-bar.unknown { background:var(--border); }
        .card-body { padding:.875rem 1rem;flex:1;display:flex;flex-direction:column; }
        .card-name { font-family:'Fraunces',serif;font-weight:400;font-size:.95rem;letter-spacing:-.02em;color:var(--text);margin-bottom:.3rem;line-height:1.25; }
        .card-description { font-size:.775rem;color:var(--text-2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:.625rem; }
        .card-badges { display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin-bottom:.625rem; }
        .card-tags { display:flex;flex-wrap:wrap;gap:.3rem;margin-bottom:.5rem; }
        .tag-pill { font-size:.65rem;font-weight:500;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);padding:.15rem .45rem;border-radius:100px; }
        .card-next-action { font-size:.75rem;color:var(--accent);background:var(--accent-subtle);border:1px solid var(--accent-border);border-radius:5px;padding:.35rem .5rem;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin-bottom:.5rem; }
        .card-footer { display:flex;align-items:center;gap:.5rem;font-size:.7rem;color:var(--text-3);border-top:1px solid var(--border);padding:.5rem 1rem; }
        .card-footer-sep { flex:1; }
        .detail-view { flex:1;display:flex;flex-direction:column;overflow:hidden; }
        .detail-header { padding:1.125rem 1.5rem 1rem;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0; }
        .detail-health-stripe { height:4px;border-radius:2px;margin-bottom:.875rem;width:48px; }
        .detail-health-stripe.on_track { background:var(--green); }
        .detail-health-stripe.at_risk { background:var(--amber); }
        .detail-health-stripe.blocked { background:var(--red); }
        .detail-health-stripe.unknown { background:var(--border-strong); }
        .detail-name-row { display:flex;align-items:flex-start;gap:.75rem;margin-bottom:.5rem; }
        .detail-name-meta { flex:1;min-width:0; }
        .detail-name { font-family:'Fraunces',serif;font-weight:400;font-size:1.3rem;letter-spacing:-.03em;color:var(--text);line-height:1.2; }
        .detail-description { font-size:.8rem;color:var(--text-2);margin-top:.2rem;line-height:1.55; }
        .detail-badges { display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin-top:.5rem; }
        .detail-header-actions { display:flex;align-items:flex-start;gap:.5rem;margin-left:auto;flex-shrink:0; }
        .ai-summary-box { font-size:.8125rem;color:var(--text-2);line-height:1.6;margin-top:.75rem;padding:.625rem .75rem;background:var(--bg);border-radius:6px;border:1px solid var(--border); }
        .next-action-box { display:flex;align-items:flex-start;gap:.5rem;margin-top:.625rem;padding:.6rem .75rem;background:var(--accent-subtle);border:1px solid var(--accent-border);border-radius:6px;font-size:.8rem;color:var(--text);line-height:1.45; }
        .next-action-arrow { color:var(--accent);font-weight:600;flex-shrink:0;margin-top:1px; }
        .detail-tabs { display:flex;border-bottom:1px solid var(--border);background:var(--surface);padding:0 1.5rem;flex-shrink:0; }
        .detail-tab { font-size:.8rem;font-weight:500;color:var(--text-3);padding:.6rem 0;margin-right:1.5rem;border-bottom:2px solid transparent;cursor:pointer;transition:color .15s,border-color .15s;background:none;border-top:none;border-left:none;border-right:none; }
        .detail-tab:hover { color:var(--text-2); }
        .detail-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
        .comms-area { flex:1;overflow-y:auto;padding:1rem 1.5rem; }
        .comms-area::-webkit-scrollbar { width:4px; }
        .comms-date-group { margin-bottom:1.25rem; }
        .comms-date-label { font-size:.7rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem; }
        .comms-date-label::after { content:'';flex:1;height:1px;background:var(--border); }
        .comm-item { display:flex;gap:.75rem;padding:.5rem .625rem;border-radius:7px;margin-bottom:.25rem;transition:background .1s; }
        .comm-item:hover { background:var(--surface); }
        .comm-icon { font-size:.95rem;flex-shrink:0;margin-top:2px;opacity:.8; }
        .comm-body { flex:1;min-width:0; }
        .comm-meta { display:flex;align-items:center;gap:.5rem;margin-bottom:.15rem; }
        .comm-source { font-size:.7rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase; }
        .comm-source.email { color:var(--blue); }
        .comm-source.whatsapp { color:var(--green); }
        .comm-source.limitless { color:var(--purple); }
        .comm-time { font-size:.7rem;color:var(--text-3);margin-left:auto; }
        .comm-subject { font-size:.75rem;font-weight:500;color:var(--text);margin-bottom:.15rem; }
        .comm-snippet { font-size:.775rem;color:var(--text-2);line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .comms-empty { text-align:center;padding:2rem;color:var(--text-3);font-size:.8125rem; }
        .insights-area { flex:1;overflow-y:auto;padding:.75rem 1.5rem; }
        .insight-group { margin-bottom:1.25rem; }
        .insight-group-title { font-size:.7rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem; }
        .insight-group-title::after { content:'';flex:1;height:1px;background:var(--border); }
        .insight-card { margin-bottom:.5rem;padding:.7rem .75rem;background:var(--surface);border:1px solid var(--border);border-radius:7px;transition:border-color .15s; }
        .insight-card:hover { border-color:var(--border-strong); }
        .insight-card-header { display:flex;align-items:flex-start;gap:.4rem;margin-bottom:.3rem; }
        .insight-content { font-size:.79rem;color:var(--text-2);line-height:1.5;flex:1; }
        .insight-badge { font-size:.6rem;padding:.15rem .35rem;border-radius:100px;font-weight:600;flex-shrink:0; }
        .insight-badge.high { background:var(--red-bg);color:var(--red);border:1px solid var(--red-border); }
        .insight-badge.medium { background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border); }
        .insight-badge.low { background:var(--surface-2);color:var(--text-3);border:1px solid var(--border); }
        .insight-footer { display:flex;align-items:center;gap:.4rem;margin-top:.4rem; }
        .insight-btn { font-family:'Plus Jakarta Sans',sans-serif;font-size:.7rem;font-weight:500;padding:.2rem .55rem;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--surface);color:var(--text-2);transition:all .15s; }
        .insight-btn:hover { background:var(--surface-2);color:var(--text); }
        .insight-btn.resolve { background:var(--green-bg);color:var(--green);border-color:var(--green-border); }
        .insight-btn.resolve:hover { background:var(--green);color:#fff; }
        .panel-right { background:var(--surface);display:flex;flex-direction:column;overflow:hidden;height:100%; }
        .panel-right-header { padding:.875rem 1rem 0;border-bottom:1px solid var(--border);flex-shrink:0; }
        .panel-right-title { font-family:'Fraunces',serif;font-weight:400;font-size:.9rem;color:var(--text);margin-bottom:.5rem; }
        .panel-right-tabs { display:flex;gap:0;overflow-x:auto;scrollbar-width:none; }
        .panel-right-tabs::-webkit-scrollbar { display:none; }
        .panel-right-tab { font-size:.72rem;font-weight:500;color:var(--text-3);padding:.4rem .65rem;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s;background:none;border-top:none;border-left:none;border-right:none; }
        .panel-right-tab:hover { color:var(--text-2); }
        .panel-right-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
        .panel-right-content { flex:1;overflow-y:auto;padding:.5rem 0; }
        .activity-item { padding:.55rem .875rem;border-bottom:1px solid var(--border);transition:background .1s; }
        .activity-item:last-child { border-bottom:none; }
        .activity-item:hover { background:var(--surface-2); }
        .activity-top { display:flex;align-items:center;gap:.4rem;margin-bottom:.2rem; }
        .activity-project-chip { font-size:.65rem;font-weight:600;color:var(--accent);background:var(--accent-subtle);border:1px solid var(--accent-border);padding:.1rem .4rem;border-radius:100px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px; }
        .activity-icon { font-size:.8rem;opacity:.7; }
        .activity-time { font-size:.65rem;color:var(--text-3);margin-left:auto; }
        .activity-snippet { font-size:.75rem;color:var(--text-2);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .open-insight-item { margin:.375rem .75rem;padding:.65rem .75rem;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;transition:border-color .15s; }
        .open-insight-item:hover { border-color:var(--border-strong); }
        .open-insight-top { display:flex;align-items:flex-start;gap:.4rem;margin-bottom:.25rem; }
        .open-insight-project { font-size:.65rem;font-weight:600;color:var(--accent);cursor:pointer;margin-bottom:.15rem; }
        .open-insight-project:hover { text-decoration:underline; }
        .open-insight-content { font-size:.75rem;color:var(--text-2);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }
        .panel-empty { text-align:center;padding:2.5rem 1rem;color:var(--text-3);font-size:.8rem; }
        .panel-empty-icon { font-size:1.75rem;margin-bottom:.5rem;opacity:.4; }
        .btn { display:inline-flex;align-items:center;gap:.4rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8125rem;font-weight:500;padding:.4rem .9rem;border-radius:6px;border:1px solid transparent;cursor:pointer;transition:all .15s;white-space:nowrap;letter-spacing:.01em;line-height:1; }
        .btn:disabled { opacity:.45;cursor:not-allowed; }
        .btn-primary { background:var(--accent);color:oklch(99% .003 75);border-color:var(--accent); }
        .btn-primary:hover:not(:disabled) { background:var(--accent-hover);border-color:var(--accent-hover); }
        .btn-ghost { background:transparent;color:var(--text-2);border-color:var(--border); }
        .btn-ghost:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
        .btn-sm { font-size:.75rem;padding:.3rem .7rem; }
        .modal-overlay { position:fixed;inset:0;background:oklch(17% .013 75/.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:1.5rem;opacity:0;pointer-events:none;transition:opacity .18s; }
        .modal-overlay.open { opacity:1;pointer-events:auto; }
        .modal { background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;width:100%;max-width:520px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px oklch(10% .01 75/.25);transform:translateY(8px) scale(.98);transition:transform .18s; }
        .modal-overlay.open .modal { transform:translateY(0) scale(1); }
        .modal-header { display:flex;align-items:center;gap:.75rem;padding:1.125rem 1.25rem;border-bottom:1px solid var(--border);flex-shrink:0; }
        .modal-title { font-family:'Fraunces',serif;font-weight:400;font-size:1rem;letter-spacing:-.02em;color:var(--text);flex:1; }
        .modal-close { background:none;border:none;font-size:1.1rem;cursor:pointer;color:var(--text-3);padding:.1rem;line-height:1;transition:color .15s; }
        .modal-close:hover { color:var(--text); }
        .modal-body { padding:1.125rem 1.25rem;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:.875rem; }
        .modal-footer { display:flex;align-items:center;gap:.5rem;padding:.875rem 1.25rem;border-top:1px solid var(--border);flex-shrink:0; }
        .modal-footer-left { flex:1; }
        .field-group { display:flex;flex-direction:column;gap:.3rem; }
        .field-row { display:grid;grid-template-columns:1fr 1fr;gap:.75rem; }
        .field-row-3 { display:grid;grid-template-columns:1fr 1fr 1fr;gap:.75rem; }
        .field-label { font-size:.72rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3); }
        .form-input,.form-select,.form-textarea { font-family:'Plus Jakarta Sans',sans-serif;font-size:.8125rem;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.45rem .65rem;outline:none;transition:border-color .15s,box-shadow .15s;width:100%; }
        .form-input:focus,.form-select:focus,.form-textarea:focus { border-color:var(--accent-border);box-shadow:0 0 0 2px oklch(55% .14 52/.12); }
        .form-textarea { resize:vertical;min-height:80px;line-height:1.55; }
        .tag-editor { display:flex;flex-wrap:wrap;gap:.375rem;padding:.35rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;min-height:38px;align-items:center;cursor:text;transition:border-color .15s,box-shadow .15s; }
        .tag-editor:focus-within { border-color:var(--accent-border);box-shadow:0 0 0 2px oklch(55% .14 52/.12); }
        .tag-chip { display:inline-flex;align-items:center;gap:.25rem;background:var(--accent-subtle);border:1px solid var(--accent-border);color:var(--accent);font-size:.72rem;font-weight:500;padding:.15rem .4rem .15rem .5rem;border-radius:100px; }
        .tag-remove-btn { background:none;border:none;cursor:pointer;color:var(--accent);font-size:.75rem;line-height:1;padding:0;opacity:.7;transition:opacity .1s; }
        .tag-remove-btn:hover { opacity:1; }
        .tag-input { border:none;outline:none;background:transparent;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;color:var(--text);flex:1;min-width:80px;padding:.15rem .2rem; }
        .tag-input::placeholder { color:var(--text-3); }
      `}</style>

      <ResizablePanes storageKey="projects" initialLeft={260} initialRight={300}>
        {/* Left: project list */}
        <aside className="panel-left">
          <div className="panel-left-header">
            <div className="panel-left-title">Projects</div>
            <input className="search-input" type="text" placeholder="Search projects…"
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            <div className="status-tabs">
              {[
                { s: '', label: 'All' },
                { s: 'active', label: 'Active' },
                { s: 'stalled', label: 'Stalled' },
                { s: 'completed', label: 'Done' },
              ].map(({ s, label }) => (
                <button key={s} className={`status-tab${statusFilter === s ? ' active' : ''}`}
                  onClick={() => setStatusFilter(s)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="project-list">
            {filteredProjects.length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>No projects found</div>
            ) : (
              filteredProjects.map(p => (
                <div key={p.id} className={`project-row${p.id === selectedProjectId ? ' active' : ''}`}
                  onClick={() => selectProject(p.id)}>
                  <div className={`health-dot ${p.health || 'unknown'}`} />
                  <div className="project-row-meta">
                    <div className="project-row-name">{p.name}</div>
                    <div className="project-row-sub">
                      <span>{p.comm_count || 0} comms</span>
                      {p.last_activity_at && <span>· {relTime(p.last_activity_at)}</span>}
                    </div>
                  </div>
                  <div className="project-row-right">
                    <span className={`status-badge ${p.status || 'unknown'}`}>{p.status || '?'}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Main panel */}
        <main className="panel-main">
          {/* Grid view */}
          {!selectedProjectId && (
            <div className="grid-view">
              <div className="grid-header">
                <h1 className="grid-heading">Projects</h1>
                <div className="grid-header-actions">
                  <button className="btn btn-ghost btn-sm" onClick={runAnalysis}>Analysis Status</button>
                </div>
              </div>
              <div className="stats-bar">
                <div className="stat-item">
                  <span className="stat-val">{stats?.total_projects || 0}</span>
                  <span className="stat-label">Total</span>
                </div>
                <div className="stat-sep" />
                <div className="stat-item">
                  <span className="stat-val">{stats?.active_projects || 0}</span>
                  <span className="stat-label">Active</span>
                </div>
                <div className="stat-sep" />
                <div className="stat-item">
                  <span className="stat-val">{stats?.stalled_projects || 0}</span>
                  <span className="stat-label">Stalled</span>
                </div>
                <div className="stat-sep" />
                <div className="stat-item">
                  <span className="stat-val">{totalComms}</span>
                  <span className="stat-label">Comms</span>
                </div>
              </div>
              {filteredProjects.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-3)', fontSize: '.875rem' }}>
                  No projects found. Start the Projects agent to run an analysis.
                </div>
              ) : (
                <div className="project-grid">
                  {filteredProjects.map(p => {
                    const health = p.health || 'unknown'
                    return (
                      <div key={p.id} className="project-card" onClick={() => selectProject(p.id)}>
                        <div className={`card-health-bar ${health}`} />
                        <div className="card-body">
                          <div className="card-name">{p.name}</div>
                          {p.description && <div className="card-description">{p.description}</div>}
                          <div className="card-badges">
                            <span className={`status-badge ${p.status || 'unknown'}`}>{p.status || 'unknown'}</span>
                            <span className={`priority-badge ${p.priority || 'medium'}`}>{p.priority || 'medium'}</span>
                            {p.open_insights > 0 && (
                              <span className="insight-badge high">{p.open_insights} insight{p.open_insights > 1 ? 's' : ''}</span>
                            )}
                          </div>
                          {(p.tags || []).length > 0 && (
                            <div className="card-tags">
                              {p.tags.slice(0, 4).map((t, i) => <span key={i} className="tag-pill">{t}</span>)}
                            </div>
                          )}
                          {p.next_action && <div className="card-next-action">→ {p.next_action}</div>}
                        </div>
                        <div className="card-footer">
                          <span>{p.comm_count || 0} comms</span>
                          <span className="card-footer-sep" />
                          <span>{p.last_activity_at ? relTime(p.last_activity_at) : 'no activity'}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Detail view */}
          {selectedProjectId && (
            <div className="detail-view">
              {!selectedProject ? (
                <div style={{ padding: '2rem', color: 'var(--text-3)', fontSize: '.8rem' }}>Loading…</div>
              ) : (
                <>
                  <div className="detail-header">
                    <div className={`detail-health-stripe ${selectedProject.health || 'unknown'}`} />
                    <div className="detail-name-row">
                      <div className="detail-name-meta">
                        <div className="detail-name">{selectedProject.name}</div>
                        {selectedProject.description && <div className="detail-description">{selectedProject.description}</div>}
                      </div>
                      <div className="detail-header-actions">
                        <button className="btn btn-ghost btn-sm" onClick={backToGrid}>← Back</button>
                        <button className="btn btn-ghost btn-sm" onClick={openEditModal}>Edit</button>
                      </div>
                    </div>
                    <div className="detail-badges">
                      <span className={`status-badge ${selectedProject.status || 'unknown'}`}>{selectedProject.status || 'unknown'}</span>
                      <span className={`priority-badge ${selectedProject.priority || 'medium'}`}>{selectedProject.priority || 'medium'}</span>
                      <span style={{
                        fontSize: '.72rem', fontWeight: 600,
                        color: selectedProject.health === 'on_track' ? 'var(--green)'
                          : selectedProject.health === 'at_risk' ? 'var(--amber)'
                            : selectedProject.health === 'blocked' ? 'var(--red)'
                              : 'var(--text-3)'
                      }}>
                        {healthLabel(selectedProject.health)}
                      </span>
                      {(selectedProject.tags || []).map((t, i) => <span key={i} className="tag-pill">{t}</span>)}
                    </div>
                    {selectedProject.ai_summary && <div className="ai-summary-box">{selectedProject.ai_summary}</div>}
                    {selectedProject.next_action && (
                      <div className="next-action-box">
                        <span className="next-action-arrow">→</span>
                        <span>Next: {selectedProject.next_action}</span>
                      </div>
                    )}
                  </div>
                  <div className="detail-tabs">
                    <button className={`detail-tab${activeDetailTab === 'comms' ? ' active' : ''}`}
                      onClick={() => setActiveDetailTab('comms')}>Communications</button>
                    <button className={`detail-tab${activeDetailTab === 'insights' ? ' active' : ''}`}
                      onClick={() => setActiveDetailTab('insights')}>Insights</button>
                  </div>
                  {activeDetailTab === 'comms' && (
                    <div className="comms-area">
                      {!(selectedProject.communications?.length) ? (
                        <div className="comms-empty">No communications found for this project yet.</div>
                      ) : (
                        Object.entries(groupByDate(selectedProject.communications)).map(([date, items]) => (
                          <div className="comms-date-group" key={date}>
                            <div className="comms-date-label">{date}</div>
                            {items.map((c, i) => (
                              <div className="comm-item" key={i}>
                                <div className="comm-icon">{sourceIcon(c.source)}</div>
                                <div className="comm-body">
                                  <div className="comm-meta">
                                    <span className={`comm-source ${c.source}`}>{c.source}</span>
                                    <span className="comm-time">{c.occurred_at ? fmtTime(c.occurred_at) : ''}</span>
                                  </div>
                                  {c.subject && <div className="comm-subject">{c.subject}</div>}
                                  <div className="comm-snippet">{c.content_snippet || ''}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  {activeDetailTab === 'insights' && (
                    <div className="insights-area">
                      {(() => {
                        const ins = selectedProject.insights || []
                        const open = ins.filter(i => !i.is_resolved)
                        const resolved = ins.filter(i => i.is_resolved)
                        const typeOrder = ['blocker', 'risk', 'next_action', 'decision', 'opportunity', 'status']
                        const typeLabels = { blocker: 'Blockers', risk: 'Risks', next_action: 'Next Actions', decision: 'Decisions', opportunity: 'Opportunities', status: 'Status Updates' }
                        const typeGroups = {}
                        for (const i of open) {
                          const t = i.insight_type || 'status'
                          if (!typeGroups[t]) typeGroups[t] = []
                          typeGroups[t].push(i)
                        }
                        const sortedTypes = typeOrder.filter(t => typeGroups[t]?.length > 0)
                        if (!ins.length) return <div className="comms-empty">No insights available for this project yet.</div>
                        return (
                          <>
                            {sortedTypes.map(type => (
                              <div className="insight-group" key={type}>
                                <div className="insight-group-title">{insightTypeIcon(type)} {typeLabels[type] || type}</div>
                                {typeGroups[type].map(i => (
                                  <div className="insight-card" key={i.id}>
                                    <div className="insight-card-header">
                                      <span className="insight-content">{i.content}</span>
                                      <span className={`insight-badge ${i.priority || 'medium'}`}>{i.priority || 'medium'}</span>
                                    </div>
                                    <div className="insight-footer">
                                      <button className="insight-btn resolve" onClick={() => resolveInsight(i.id)}>Resolve</button>
                                      <span style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>{relTime(i.created_at)}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ))}
                            {resolved.length > 0 && (
                              <div className="insight-group">
                                <div className="insight-group-title" style={{ opacity: .5 }}>Resolved ({resolved.length})</div>
                                {resolved.map(i => (
                                  <div className="insight-card" key={i.id} style={{ opacity: .5 }}>
                                    <div className="insight-content" style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>{insightTypeIcon(i.insight_type)} {i.content}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </main>

        {/* Right panel */}
        <aside className="panel-right">
          <div className="panel-right-header">
            <div className="panel-right-title">Activity</div>
            <div className="panel-right-tabs">
              <button className={`panel-right-tab${activeRightPanel === 'activity' ? ' active' : ''}`}
                onClick={() => switchRightPanel('activity')}>Recent</button>
              <button className={`panel-right-tab${activeRightPanel === 'insights' ? ' active' : ''}`}
                onClick={() => switchRightPanel('insights')}>Open Insights</button>
            </div>
          </div>
          <div className="panel-right-content">
            {rightLoading ? (
              <div className="panel-empty"><div className="panel-empty-icon">📡</div>Loading…</div>
            ) : rightContent?.type === 'activity' ? (
              rightContent.items.length === 0 ? (
                <div className="panel-empty"><div className="panel-empty-icon">📡</div>No recent activity</div>
              ) : (
                rightContent.items.map((item, i) => (
                  <div className="activity-item" key={i}>
                    <div className="activity-top">
                      <span className="activity-project-chip" onClick={() => selectProject(item.project_id)}>
                        {item.project_name}
                      </span>
                      <span className="activity-icon">{sourceIcon(item.source)}</span>
                      <span className="activity-time">{item.occurred_at ? relTime(item.occurred_at) : ''}</span>
                    </div>
                    <div className="activity-snippet">{(item.subject || item.content_snippet || '').slice(0, 100)}</div>
                  </div>
                ))
              )
            ) : rightContent?.type === 'insights' ? (
              rightContent.items.length === 0 ? (
                <div className="panel-empty"><div className="panel-empty-icon">✨</div>No open insights</div>
              ) : (
                rightContent.items.map((item, i) => (
                  <div className="open-insight-item" key={i}>
                    <div className="open-insight-top">
                      <span className={`insight-badge ${item.priority || 'medium'}`}>{item.priority || 'medium'}</span>
                      <span style={{ fontSize: '.8rem' }}>{insightTypeIcon(item.insight_type)}</span>
                    </div>
                    <div className="open-insight-project" onClick={() => selectProject(item.project_id)}>{item.project_name}</div>
                    <div className="open-insight-content">{item.content}</div>
                  </div>
                ))
              )
            ) : null}
          </div>
        </aside>
      </ResizablePanes>

      {/* Edit modal */}
      <div className={`modal-overlay${editOpen ? ' open' : ''}`}
        onClick={e => { if (e.target === e.currentTarget) setEditOpen(false) }}>
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-header">
            <div className="modal-title">Edit project</div>
            <button className="modal-close" onClick={() => setEditOpen(false)}>✕</button>
          </div>
          <div className="modal-body">
            <div className="field-group">
              <label className="field-label" htmlFor="edit-name-proj">Project name</label>
              <input className="form-input" id="edit-name-proj" type="text" placeholder="Project name"
                value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-desc-proj">Description</label>
              <textarea className="form-textarea" id="edit-desc-proj" rows={3}
                placeholder="What is this project about?" style={{ minHeight: '70px' }}
                value={editDesc} onChange={e => setEditDesc(e.target.value)} />
            </div>
            <div className="field-row-3">
              <div className="field-group">
                <label className="field-label" htmlFor="edit-status-proj">Status</label>
                <select className="form-select" id="edit-status-proj" value={editStatus} onChange={e => setEditStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="stalled">Stalled</option>
                  <option value="on_hold">On hold</option>
                  <option value="completed">Completed</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="edit-health-proj">Health</label>
                <select className="form-select" id="edit-health-proj" value={editHealth} onChange={e => setEditHealth(e.target.value)}>
                  <option value="on_track">On track</option>
                  <option value="at_risk">At risk</option>
                  <option value="blocked">Blocked</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="edit-priority-proj">Priority</label>
                <select className="form-select" id="edit-priority-proj" value={editPriority} onChange={e => setEditPriority(e.target.value)}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-next-proj">Next action</label>
              <input className="form-input" id="edit-next-proj" type="text" placeholder="Most important next step…"
                value={editNextAction} onChange={e => setEditNextAction(e.target.value)} />
            </div>
            <div className="field-group">
              <label className="field-label">Tags</label>
              <TagEditor tags={editTags} onChange={setEditTags} />
            </div>
          </div>
          <div className="modal-footer">
            <div className="modal-footer-left">
              <button className="btn btn-ghost btn-sm" style={{ color: 'var(--text-3)', fontSize: '.75rem' }}
                onClick={archiveProject}>Archive project</button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditOpen(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={savingProject} onClick={saveProject}>
              {savingProject ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: '1.5rem', right: '1.5rem',
        background: 'var(--text)', color: 'var(--bg)',
        fontSize: '.8125rem', fontWeight: 500,
        padding: '.6rem 1rem', borderRadius: '6px',
        zIndex: 999, pointerEvents: 'none',
        opacity: toast.visible ? 1 : 0,
        transform: toast.visible ? 'translateY(0)' : 'translateY(6px)',
        transition: 'opacity .2s, transform .2s',
      }}>{toast.msg}</div>
    </>
  )
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-3)', fontSize: '.875rem' }}>Loading projects…</div>}>
      <ProjectsPageContent />
    </Suspense>
  )
}
