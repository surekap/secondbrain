'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

// Replace raw WhatsApp IDs (e.g. "1234@g.us") with human-readable group names.
// Also strips trailing @c.us from phone numbers.
function resolveGroupIds(text, groupsMap) {
  if (!text || !groupsMap) return text
  return text
    .replace(/(\d{5,})@g\.us/g, (_, id) => groupsMap[id + '@g.us'] || groupsMap[id] || 'WhatsApp group')
    .replace(/(\d{5,})@c\.us/g, (_, num) => '+' + num)
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const diff = Date.now() - d
  if (diff < 86400000)   return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diff < 7*86400000) return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtAge(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const diff = Math.max(0, Date.now() - d.getTime())
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

// Map insight priority + type to Eisenhower quadrant
// Q1 = Urgent + Important (Do First)
// Q2 = Not Urgent + Important (Schedule)
// Q3 = Urgent + Not Important (Delegate)
// Q4 = Not Urgent + Not Important (Eliminate)
const ACTION_TYPES = new Set(['follow_up', 'action_required', 'risk', 'deadline', 'opportunity'])

function toQuadrant(priority, insight_type) {
  const isImportant = priority === 'high' || priority === 'medium'
  const isUrgent = ACTION_TYPES.has(insight_type) || priority === 'high'
  if (isUrgent && isImportant)  return 'q1'
  if (!isUrgent && isImportant) return 'q2'
  if (isUrgent && !isImportant) return 'q3'
  return 'q4'
}

const QUADRANTS = [
  { key: 'q1', label: 'Do First',  sub: 'Urgent · Important',      accent: 'oklch(50% 0.16 25)',  bg: 'oklch(98% 0.02 25)' },
  { key: 'q2', label: 'Schedule',  sub: 'Not Urgent · Important',   accent: 'oklch(48% 0.12 240)', bg: 'oklch(98% 0.015 240)' },
  { key: 'q3', label: 'Delegate',  sub: 'Urgent · Not Important',   accent: 'oklch(52% 0.10 60)',  bg: 'oklch(98% 0.015 60)' },
  { key: 'q4', label: 'Eliminate', sub: 'Not Urgent · Not Important', accent: 'oklch(55% 0.05 250)', bg: 'oklch(98% 0.01 250)' },
]

const PRIORITY_COLOR = {
  high:   'oklch(50% 0.16 25)',
  medium: 'oklch(52% 0.13 55)',
  low:    'oklch(50% 0.08 250)',
}

function InsightCard({ item, type, onAction, onDismiss, groupsMap }) {
  const color = PRIORITY_COLOR[item.priority] || 'var(--text-3)'
  const label = type === 'relationship' ? item.contact_name : item.project_name
  const href  = type === 'relationship'
    ? `/relationships?contact=${item.contact_id}`
    : `/projects?project=${item.project_id}`
  const title = resolveGroupIds(item.title || item.content, groupsMap)
  const desc  = resolveGroupIds(item.description, groupsMap)
  return (
    <div className="insight-card">
      <div className="ic-stripe" style={{ background: color }} />
      <Link href={href} className="ic-body" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="ic-top">
          {label && <span className="ic-label">{label}</span>}
          <span className="ic-type">{(item.insight_type || '').replace(/_/g, ' ')}</span>
        </div>
        <div className="ic-title">{title}</div>
        {desc && <div className="ic-desc">{desc}</div>}
      </Link>
      <div className="ic-actions">
        {onAction && (
          <button className="ic-btn" onClick={() => onAction(item.id)} title="Mark actioned">✓</button>
        )}
        {onDismiss && (
          <button className="ic-btn ic-btn-dim" onClick={() => onDismiss(item.id)} title="Dismiss">✕</button>
        )}
      </div>
    </div>
  )
}

async function fetchJson(path, { fallback = null, timeoutMs = 8000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(path, { signal: controller.signal })
    if (!res.ok) return fallback
    return await res.json()
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJsonDetailed(path, { fallback = null, timeoutMs = 8000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(path, { signal: controller.signal })
    if (!res.ok) {
      return { data: fallback, error: `${res.status} ${res.statusText || 'request failed'}` }
    }
    return { data: await res.json(), error: null }
  } catch (err) {
    return {
      data: fallback,
      error: err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : (err?.message || 'request failed'),
    }
  } finally {
    clearTimeout(timer)
  }
}

export default function DashboardPage() {
  const [relInsights, setRelInsights]     = useState([])
  const [projInsights, setProjInsights]   = useState([])
  const [relStats, setRelStats]           = useState(null)
  const [projStats, setProjStats]         = useState(null)
  const [recentActivity, setRecentActivity] = useState([])
  const [attentionItems, setAttentionItems] = useState([])
  const [duplicateSummary, setDuplicateSummary] = useState(null)
  const [dupComms, setDupComms]           = useState({})
  const [duplicateEvidence, setDuplicateEvidence] = useState(null)
  const [duplicateEvidenceKey, setDuplicateEvidenceKey] = useState(null)
  const [groupsMap, setGroupsMap]         = useState({})
  const [feedIssues, setFeedIssues]       = useState([])
  const [loading, setLoading]             = useState(true)

  async function load() {
    const [ri, pi, rs, ps, ra, gr, aq, ds] = await Promise.all([
      fetchJsonDetailed('/api/relationships/insights', { fallback: [], timeoutMs: 8000 }),
      fetchJsonDetailed('/api/projects/insights/open', { fallback: [], timeoutMs: 8000 }),
      fetchJsonDetailed('/api/relationships/stats', { fallback: null, timeoutMs: 8000 }),
      fetchJsonDetailed('/api/projects/stats', { fallback: null, timeoutMs: 8000 }),
      fetchJsonDetailed('/api/projects/activity/recent', { fallback: [], timeoutMs: 8000 }),
      fetchJsonDetailed('/api/relationships/groups', { fallback: [], timeoutMs: 3000 }),
      fetchJsonDetailed('/api/intelligence/attention?limit=5', { fallback: [], timeoutMs: 5000 }),
      fetchJsonDetailed('/api/intelligence/duplicates/summary?limit=3', { fallback: null, timeoutMs: 5000 }),
    ])

    const feedErrors = [
      ['relationships insights', ri.error],
      ['projects insights', pi.error],
      ['relationships stats', rs.error],
      ['projects stats', ps.error],
      ['recent activity', ra.error],
      ['relationship groups', gr.error],
      ['attention queue', aq.error],
      ['duplicate summary', ds.error],
    ].filter(([, error]) => error).map(([name, error]) => `${name}: ${error}`)

    if (Array.isArray(ri.data)) setRelInsights(ri.data)
    if (Array.isArray(pi.data)) setProjInsights(pi.data)
    if (rs.data && !rs.error) setRelStats(rs.data)
    if (ps.data && !ps.error) setProjStats(ps.data)
    if (Array.isArray(ra.data)) setRecentActivity(ra.data.slice(0, 8))
    if (Array.isArray(aq.data)) setAttentionItems(aq.data)
    if (ds.data && !ds.error) setDuplicateSummary(ds.data)
    if (Array.isArray(gr.data)) {
      const map = {}
      for (const g of gr.data) if (g.wa_chat_id && g.name) map[g.wa_chat_id] = g.name
      setGroupsMap(map)
    }
    setFeedIssues(feedErrors)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleAction(id) {
    await fetch(`/api/relationships/insights/${id}/action`, { method: 'POST' })
    setRelInsights(prev => prev.filter(x => x.id !== id))
  }

  async function handleDismiss(id) {
    await fetch(`/api/relationships/insights/${id}/dismiss`, { method: 'POST' })
    setRelInsights(prev => prev.filter(x => x.id !== id))
  }

  async function handleProjResolve(id) {
    await fetch(`/api/projects/insights/${id}/resolve`, { method: 'POST' })
    setProjInsights(prev => prev.filter(x => x.id !== id))
  }

  async function updateOpportunityStatus(id, status) {
    await fetch(`/api/intelligence/opportunities/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    setAttentionItems(prev => prev.filter(x => x.id !== id))
  }

  async function inspectDuplicate(group) {
    const ids = (group.entities || []).map(e => String(e.id)).filter(Boolean)
    if (!ids.length) return
    const key = `${group._type}-${group.duplicate_key}`
    setDuplicateEvidenceKey(key)
    setDuplicateEvidence({ loading: true, group, data: null })
    const data = await fetchJson(`/api/intelligence/duplicates/evidence?entity_type=${encodeURIComponent(group._type)}&ids=${encodeURIComponent(ids.join(','))}`, { fallback: { error: 'Failed to load evidence' }, timeoutMs: 10000 })
    setDuplicateEvidence({ loading: false, group, data })
  }

  async function decideDuplicate(group, action) {
    const duplicate_ids = (group.entities || []).map(e => String(e.id)).filter(Boolean)
    await fetch('/api/intelligence/duplicates/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entity_type: group._type,
        duplicate_key: group.duplicate_key,
        action,
        canonical_id: group.suggested_canonical_id,
        duplicate_ids,
        decided_by: 'dashboard',
      }),
    })
    await load()
  }

  async function toggleEntityComms(entityId) {
    if (dupComms[entityId] !== undefined) {
      setDupComms(prev => { const n = { ...prev }; delete n[entityId]; return n })
      return
    }
    setDupComms(prev => ({ ...prev, [entityId]: 'loading' }))
    const data = await fetchJson(`/api/relationships/contacts/${entityId}`, { fallback: null, timeoutMs: 6000 })
    setDupComms(prev => ({ ...prev, [entityId]: data?.communications || [] }))
  }

  // Build Eisenhower matrix — combine rel + proj insights
  const allInsights = [
    ...relInsights.map(i => ({ ...i, _type: 'relationship' })),
    ...projInsights.map(i => ({ ...i, _type: 'project', title: i.content })),
  ]

  const matrix = { q1: [], q2: [], q3: [], q4: [] }
  for (const item of allInsights) {
    const q = toQuadrant(item.priority, item.insight_type)
    matrix[q].push(item)
  }

  const totalInsights = allInsights.length
  const duplicateGroups = Number(duplicateSummary?.contacts?.candidate_groups || 0) + Number(duplicateSummary?.organizations?.candidate_groups || 0)
  const duplicateTop = [
    ...(duplicateSummary?.contacts?.top || []).map(g => ({ ...g, _type: 'contact' })),
    ...(duplicateSummary?.organizations?.top || []).map(g => ({ ...g, _type: 'organization' })),
  ].slice(0, 4)

  return (
    <>
      <style>{`
        .dash { max-width: 1100px; margin: 0 auto; padding: clamp(2rem,4vw,3rem) clamp(1.5rem,4vw,2rem) 4rem; }
        .dash-head { margin-bottom: 2rem; }
        .dash-title { font-family:'Fraunces',serif; font-weight:300; font-size: clamp(1.5rem,3vw,2rem); letter-spacing:-.03em; color:var(--text); margin-bottom:.25rem; }
        .dash-title em { font-style:italic; color:var(--accent); }
        .dash-desc { font-size:.825rem; color:var(--text-3); }
        .health-banner {
          display:flex; align-items:flex-start; gap:.65rem; justify-content:space-between;
          margin-bottom:1rem; padding:.8rem 1rem; border:1px solid var(--amber-border);
          background:var(--amber-bg); color:var(--amber); border-radius:10px; font-size:.8rem;
        }
        .health-banner strong { color:inherit; }
        .health-list { margin:.35rem 0 0; padding-left:1.1rem; color:inherit; }
        .health-list li + li { margin-top:.2rem; }
        .health-link { color:inherit; font-weight:600; text-decoration:underline; }

        /* Stats bar */
        .stats-row { display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:2rem; }
        .stat-card {
          flex:1; min-width:140px;
          background:var(--surface); border:1px solid var(--border); border-radius:10px;
          padding:.875rem 1.125rem;
        }
        .sc-val { font-family:'Fraunces',serif; font-size:1.6rem; font-weight:400; letter-spacing:-.03em; color:var(--text); line-height:1; }
        .sc-lbl { font-size:.7rem; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--text-3); margin-top:.3rem; }
        .sc-link { display:block; text-decoration:none; color:inherit; }
        .sc-link:hover .sc-val { color:var(--accent); }

        /* Section headings */
        .section-head { display:flex; align-items:baseline; gap:.75rem; margin-bottom:1rem; }
        .section-title { font-family:'Fraunces',serif; font-weight:300; font-size:1.1rem; letter-spacing:-.025em; color:var(--text); }
        .section-count { font-size:.75rem; font-weight:600; color:var(--text-3); background:var(--surface-2); border:1px solid var(--border); border-radius:100px; padding:.15rem .5rem; }
        .section-link { font-size:.75rem; color:var(--accent); text-decoration:none; margin-left:auto; }
        .section-link:hover { text-decoration:underline; }

        /* Eisenhower matrix */
        .matrix { display:grid; grid-template-columns:1fr 1fr; gap:.875rem; margin-bottom:2.5rem; }
        @media(max-width:640px) { .matrix { grid-template-columns:1fr; } }
        .quad {
          border:1px solid var(--border); border-radius:10px; overflow:hidden;
        }
        .quad-head {
          display:flex; align-items:center; gap:.5rem;
          padding:.625rem .875rem;
          border-bottom:1px solid var(--border);
        }
        .quad-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
        .quad-label { font-size:.8rem; font-weight:600; color:var(--text); }
        .quad-sub { font-size:.68rem; color:var(--text-3); margin-left:auto; }
        .quad-count { font-size:.7rem; font-weight:600; color:var(--text-3); background:var(--surface-2); border:1px solid var(--border); border-radius:100px; padding:.1rem .4rem; }
        .quad-items { padding:.375rem 0; }
        .quad-empty { padding:.75rem .875rem; font-size:.775rem; color:var(--text-3); }

        /* Insight card */
        .insight-card {
          display:grid; grid-template-columns:3px 1fr auto;
          gap:0 .625rem; align-items:start;
          padding:.5rem .875rem;
          border-bottom:1px solid var(--border);
        }
        .insight-card:last-child { border-bottom:none; }
        .ic-stripe { grid-column:1; grid-row:1/span 3; border-radius:2px; align-self:stretch; min-height:1.5rem; }
        .ic-body { grid-column:2; min-width:0; }
        .ic-top { display:flex; align-items:center; gap:.35rem; margin-bottom:.15rem; flex-wrap:wrap; }
        .ic-label { font-size:.68rem; font-weight:600; color:var(--text-3); }
        .ic-type { font-size:.65rem; color:var(--text-3); background:var(--surface-2); border:1px solid var(--border); border-radius:100px; padding:.08rem .35rem; }
        .ic-title { font-size:.8rem; font-weight:500; color:var(--text); line-height:1.35; }
        .ic-desc { font-size:.72rem; color:var(--text-2); line-height:1.4; margin-top:.15rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .ic-body:hover .ic-title { color: var(--accent); }
        .ic-actions { grid-column:3; display:flex; gap:.25rem; padding-top:.1rem; }
        .ic-btn { background:none; border:1px solid var(--border); border-radius:5px; width:22px; height:22px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:.7rem; color:var(--text-2); transition:all .1s; }
        .ic-btn:hover { border-color:var(--border-strong); color:var(--text); background:var(--surface-2); }
        .ic-btn-dim { opacity:.6; }

        /* Attention queue */
        .attention-list { display:flex; flex-direction:column; gap:.5rem; margin-bottom:2.25rem; }
        .attention-card { display:grid; grid-template-columns:1fr auto; gap:.75rem; align-items:start; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:.75rem .875rem; }
        .attention-meta { display:flex; align-items:center; gap:.4rem; flex-wrap:wrap; margin-bottom:.2rem; }
        .attention-type { font-size:.65rem; color:var(--text-3); background:var(--surface-2); border:1px solid var(--border); border-radius:100px; padding:.08rem .4rem; text-transform:capitalize; }
        .attention-score { font-size:.68rem; color:var(--text-3); }
        .attention-quality { font-size:.65rem; color:var(--amber); background:var(--amber-bg); border:1px solid var(--amber-border); border-radius:100px; padding:.08rem .4rem; }
        .attention-evidence { font-size:.68rem; color:var(--text-3); }
        .attention-age { font-size:.68rem; color:var(--text-3); }
        .attention-age-strong { color:var(--text); font-weight:600; }
        .attention-title { font-size:.875rem; font-weight:600; color:var(--text); line-height:1.35; }
        .attention-desc { font-size:.75rem; color:var(--text-2); line-height:1.45; margin-top:.2rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .attention-action { font-size:.72rem; color:var(--accent); margin-top:.3rem; }
        .attention-actions { display:flex; gap:.35rem; }

        /* Identity resolution */
        .identity-panel { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:.875rem; margin-bottom:2.25rem; }
        .identity-head { display:flex; align-items:baseline; gap:.75rem; margin-bottom:.75rem; }
        .identity-title { font-family:'Fraunces',serif; font-size:1rem; font-weight:300; color:var(--text); }
        .identity-sub { font-size:.72rem; color:var(--text-3); }
        .duplicate-list { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; }
        @media(max-width:720px) { .duplicate-list { grid-template-columns:1fr; } }
        .duplicate-group { border:1px solid var(--border); border-radius:8px; padding:.625rem .75rem; background:var(--surface-2); }
        .duplicate-meta { display:flex; gap:.4rem; align-items:center; flex-wrap:wrap; margin-bottom:.25rem; }
        .duplicate-kind { font-size:.62rem; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); }
        .duplicate-conf { font-size:.65rem; color:var(--accent); }
        .duplicate-key { font-size:.82rem; font-weight:600; color:var(--text); margin-bottom:.4rem; }
        .duplicate-entity-list { display:flex; flex-direction:column; gap:.35rem; margin-top:.25rem; }
        .duplicate-entity-row { border:1px solid var(--border); border-radius:6px; padding:.35rem .5rem; background:var(--surface); }
        .duplicate-entity-name { font-size:.75rem; font-weight:600; color:var(--text); }
        .duplicate-entity-canonical { font-size:.62rem; color:var(--accent); margin-left:.3rem; }
        .duplicate-entity-meta { font-size:.68rem; color:var(--text-2); margin-top:.1rem; line-height:1.4; }
        .duplicate-entity-toggle { font-size:.65rem; color:var(--accent); cursor:pointer; border:none; background:none; padding:0; margin-top:.2rem; text-decoration:underline; }
        .duplicate-entity-comms { margin-top:.35rem; border-top:1px solid var(--border); padding-top:.3rem; display:flex; flex-direction:column; gap:.25rem; }
        .dup-comm-item { font-size:.66rem; color:var(--text-2); line-height:1.35; }
        .dup-comm-source { font-size:.6rem; color:var(--text-3); }
        .duplicate-canon { font-size:.68rem; color:var(--text-3); margin-top:.25rem; }
        .duplicate-actions { display:flex; gap:.35rem; margin-top:.5rem; }
        .duplicate-action { border:1px solid var(--border); background:var(--surface); color:var(--text-2); border-radius:6px; padding:.22rem .45rem; font-size:.68rem; cursor:pointer; }
        .duplicate-action:hover { border-color:var(--border-strong); color:var(--text); }
        .duplicate-evidence { grid-column:1/-1; margin-top:.65rem; border-top:1px solid var(--border); padding-top:.65rem; display:grid; gap:.65rem; }
        .evidence-block { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:.55rem .65rem; }
        .evidence-title { font-size:.7rem; font-weight:700; color:var(--text); margin-bottom:.35rem; }
        .evidence-row { font-size:.68rem; color:var(--text-2); line-height:1.35; padding:.18rem 0; border-top:1px solid var(--border); }
        .evidence-row:first-of-type { border-top:none; }
        .evidence-id { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--text-3); }
        .evidence-empty { font-size:.68rem; color:var(--text-3); }

        /* Recent activity */
        .activity-list { display:flex; flex-direction:column; gap:.375rem; }
        .activity-item {
          display:flex; align-items:start; gap:.75rem;
          background:var(--surface); border:1px solid var(--border); border-radius:8px;
          padding:.625rem .875rem;
        }
        .ai-src { font-size:.65rem; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--text-3); width:52px; flex-shrink:0; padding-top:.1rem; }
        .ai-body { flex:1; min-width:0; }
        .ai-project { font-size:.72rem; font-weight:600; color:var(--accent); margin-bottom:.1rem; }
        .ai-snippet { font-size:.8rem; color:var(--text); line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .ai-date { font-size:.68rem; color:var(--text-3); flex-shrink:0; padding-top:.1rem; }

        .empty-state { padding:2rem 1rem; text-align:center; color:var(--text-3); font-size:.825rem; }
        .empty-state strong { color:var(--text); }

        /* Cmd+K hint */
        .search-hint {
          display:flex; align-items:center; gap:.625rem;
          background:var(--surface); border:1px solid var(--border); border-radius:8px;
          padding:.625rem .875rem; margin-bottom:2rem; cursor:pointer;
          transition:border-color .12s;
        }
        .search-hint:hover { border-color:var(--border-strong); }
        .sh-text { flex:1; font-size:.825rem; color:var(--text-3); }
        .sh-kbd { font-size:.68rem; font-weight:600; letter-spacing:.04em; color:var(--text-3); border:1px solid var(--border-strong); border-radius:4px; padding:.15rem .35rem; }
      `}</style>

      <div className="dash">
        <div className="dash-head">
          <h1 className="dash-title">Good morning — <em>here's your day</em></h1>
          <p className="dash-desc">
            {totalInsights > 0
              ? `${totalInsights} open insight${totalInsights !== 1 ? 's' : ''} across relationships and projects.`
              : 'No open insights — you\'re all caught up.'}
          </p>
        </div>

        {feedIssues.length > 0 && (
          <div className="health-banner">
            <div>
              <strong>Data feed degraded.</strong> Some intelligence slices fell back to cached/empty state instead of live data.
              <ul className="health-list">
                {feedIssues.slice(0, 4).map(issue => <li key={issue}>{issue}</li>)}
              </ul>
            </div>
            <a className="health-link" href="/observe">Check Observe</a>
          </div>
        )}

        {/* Search hint */}
        <div className="search-hint" onClick={() => {
          const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
          window.dispatchEvent(e)
        }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" style={{ color: 'var(--text-3)' }}>
            <circle cx="6.5" cy="6.5" r="5"/>
            <path d="M11 11l3 3"/>
          </svg>
          <span className="sh-text">Search emails, conversations, lifelogs, contacts…</span>
          <kbd className="sh-kbd">⌘K</kbd>
        </div>

        {/* Stats */}
        <div className="stats-row">
          {relStats && (
            <>
              <Link href="/relationships" className="stat-card sc-link">
                <div className="sc-val">{Number(relStats.total_contacts || 0).toLocaleString()}</div>
                <div className="sc-lbl">Contacts</div>
              </Link>
              <Link href="/relationships" className="stat-card sc-link">
                <div className="sc-val">{Number(relStats.pending_insights ?? relInsights.length ?? 0).toLocaleString()}</div>
                <div className="sc-lbl">Open Insights</div>
              </Link>
            </>
          )}
          {projStats && (
            <>
              <Link href="/projects" className="stat-card sc-link">
                <div className="sc-val">{Number(projStats.total_projects ?? 0).toLocaleString()}</div>
                <div className="sc-lbl">Projects</div>
              </Link>
              <Link href="/projects" className="stat-card sc-link">
                <div className="sc-val">{Number(projInsights.length || 0).toLocaleString()}</div>
                <div className="sc-lbl">Project Insights</div>
              </Link>
            </>
          )}
        </div>

        {/* Identity resolution audit */}
        {duplicateSummary && duplicateGroups > 0 && (
          <div className="identity-panel">
            <div className="identity-head">
              <span className="identity-title">Identity Resolution</span>
              <span className="section-count">{duplicateGroups} duplicate groups</span>
              <span className="identity-sub">Audit only — no auto-merge.</span>
              <a className="section-link" href="/api/intelligence/duplicates/summary?limit=25">API →</a>
            </div>
            <div className="duplicate-list">
              {duplicateTop.map(group => {
                return (
                  <div className="duplicate-group" key={`${group._type}-${group.duplicate_key}`}>
                    <div className="duplicate-meta">
                      <span className="duplicate-kind">{group._type}</span>
                      <span className="duplicate-conf">{Math.round(Number(group.confidence || 0) * 100)}% confidence</span>
                      <span className="attention-evidence">{Number(group.duplicate_count || 0)} rows</span>
                    </div>
                    <div className="duplicate-key">{group.duplicate_key}</div>
                    <div className="duplicate-entity-list">
                      {(group.entities || []).map(e => {
                        const eid = String(e.id)
                        const isSuggested = eid === String(group.suggested_canonical_id)
                        const commsState = dupComms[eid]
                        const metaParts = [
                          e.company || e.name,
                          e.job_title,
                          e.relationship_type?.replace(/_/g, ' '),
                          e.relationship_tier,
                          e.last_interaction_at ? `last: ${new Date(e.last_interaction_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })}` : 'no comms',
                        ].filter(Boolean)
                        return (
                          <div className="duplicate-entity-row" key={eid}>
                            <div>
                              <span className="duplicate-entity-name">{e.display_name || e.name || `id:${eid}`}</span>
                              {isSuggested && <span className="duplicate-entity-canonical">★ suggested canonical</span>}
                            </div>
                            <div className="duplicate-entity-meta">{metaParts.join(' · ')}</div>
                            {group._type === 'contact' && (
                              <button className="duplicate-entity-toggle" onClick={() => toggleEntityComms(eid)}>
                                {commsState === undefined ? 'Show recent comms' : commsState === 'loading' ? 'Loading…' : 'Hide comms'}
                              </button>
                            )}
                            {commsState && commsState !== 'loading' && (
                              <div className="duplicate-entity-comms">
                                {commsState.length === 0
                                  ? <span className="dup-comm-source">No communications found</span>
                                  : commsState.slice(0, 5).map(c => (
                                    <div className="dup-comm-item" key={c.id}>
                                      <span className="dup-comm-source">{c.source} · {new Date(c.occurred_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })} · </span>
                                      {c.subject ? <strong>{c.subject}</strong> : null}{c.subject && c.content_snippet ? ' — ' : null}{c.content_snippet || '(no snippet)'}
                                    </div>
                                  ))
                                }
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <div className="duplicate-actions">
                      <button className="duplicate-action" onClick={() => inspectDuplicate(group)}>Inspect evidence</button>
                      <button className="duplicate-action" onClick={() => decideDuplicate(group, 'confirmed')}>Confirm duplicate</button>
                      <button className="duplicate-action" onClick={() => decideDuplicate(group, 'ignored')}>Ignore</button>
                    </div>
                    {duplicateEvidenceKey === `${group._type}-${group.duplicate_key}` && duplicateEvidence && (
                      <div className="duplicate-evidence">
                        {duplicateEvidence.loading ? <div className="evidence-empty">Loading evidence…</div> : duplicateEvidence.data?.error ? <div className="evidence-empty">{duplicateEvidence.data.error}</div> : (
                          <>
                            <div className="evidence-block">
                              <div className="evidence-title">Entities</div>
                              {(duplicateEvidence.data?.entities || []).map(e => (
                                <div className="evidence-row" key={`entity-${e.id}`}>
                                  <span className="evidence-id">#{e.id}</span> {e.display_name || e.name} {e.company ? `· ${e.company}` : ''} {e.job_title ? `· ${e.job_title}` : ''} {e.domain ? `· ${e.domain}` : ''}
                                  <br />tier/type: {e.relationship_tier || e.sector || '—'} · last: {fmtDate(e.last_interaction_at || e.updated_at)}
                                </div>
                              ))}
                            </div>
                            <div className="evidence-block">
                              <div className="evidence-title">Aliases</div>
                              {(duplicateEvidence.data?.aliases || []).length ? duplicateEvidence.data.aliases.slice(0, 12).map((a, i) => (
                                <div className="evidence-row" key={`alias-${i}`}><span className="evidence-id">#{a.entity_id}</span> {a.alias} · {a.source || 'source unknown'}</div>
                              )) : <div className="evidence-empty">No aliases found.</div>}
                            </div>
                            <div className="evidence-block">
                              <div className="evidence-title">Recent communications</div>
                              {(duplicateEvidence.data?.communications || []).length ? duplicateEvidence.data.communications.slice(0, 12).map((c, i) => (
                                <div className="evidence-row" key={`comm-${i}`}><span className="evidence-id">#{c.entity_id}</span> {fmtDate(c.occurred_at)} · {c.source}/{c.direction} {c.group_name ? `· ${c.group_name}` : ''}<br />{c.subject || c.content_snippet || 'No snippet'}</div>
                              )) : <div className="evidence-empty">No relationship communications found.</div>}
                            </div>
                            <div className="evidence-block">
                              <div className="evidence-title">WhatsApp/raw touches</div>
                              {(duplicateEvidence.data?.whatsapp_messages || duplicateEvidence.data?.touches || []).length ? [ ...(duplicateEvidence.data?.touches || []), ...(duplicateEvidence.data?.whatsapp_messages || []) ].slice(0, 12).map((m, i) => (
                                <div className="evidence-row" key={`wa-${i}`}><span className="evidence-id">{m.entity_id ? `#${m.entity_id}` : m.chat_id}</span> {fmtDate(m.touched_at || m.ts)} · {m.source || m.event || m.msg_type || 'whatsapp'}<br />{m.note || m.body || m.external_id || 'No snippet'}</div>
                              )) : <div className="evidence-empty">No raw WhatsApp/touch evidence found.</div>}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Attention queue */}
        {attentionItems.length > 0 && (
          <>
            <div className="section-head">
              <span className="section-title">Attention Queue</span>
              <span className="section-count">{attentionItems.length}</span>
            </div>
            <div className="attention-list">
              {attentionItems.map(item => (
                <div className="attention-card" key={item.id}>
                  <div>
                    <div className="attention-meta">
                      <span className="attention-type">{String(item.opportunity_type || item.item_type || 'opportunity').replace(/_/g, ' ')}</span>
                      {item.primary_contact_name && <span className="ic-label">{item.primary_contact_name}</span>}
                      {item.primary_project_name && <span className="ic-label">{item.primary_project_name}</span>}
                      {item.attention_score != null
                        ? <span className="attention-score">attention {Number(item.attention_score).toFixed(0)}</span>
                        : item.expected_value_score != null && <span className="attention-score">score {Number(item.expected_value_score).toFixed(0)}</span>}
                      {item.evidence_count != null && <span className="attention-evidence">{Number(item.evidence_count)} evidence</span>}
                      {(item.quality_flags || []).slice(0, 2).map(flag => (
                        <span className="attention-quality" key={flag}>{String(flag).replace(/_/g, ' ')}</span>
                      ))}
                      {(item.source_first_seen_at || item.first_seen_at || item.created_at) && (
                        <span className="attention-age">
                          source <span className="attention-age-strong">{fmtAge(item.source_first_seen_at || item.first_seen_at || item.created_at)}</span>
                        </span>
                      )}
                      {(item.source_last_seen_at || item.last_seen_at) && (item.source_last_seen_at || item.last_seen_at) !== (item.source_first_seen_at || item.first_seen_at || item.created_at) && (
                        <span className="attention-age">source updated {fmtAge(item.source_last_seen_at || item.last_seen_at)}</span>
                      )}
                    </div>
                    <div className="attention-title">{resolveGroupIds(item.title, groupsMap)}</div>
                    {item.description && <div className="attention-desc">{resolveGroupIds(item.description, groupsMap)}</div>}
                    {item.recommended_next_action && <div className="attention-action">Next: {item.recommended_next_action}</div>}
                  </div>
                  <div className="attention-actions">
                    <button className="ic-btn" onClick={() => updateOpportunityStatus(item.id, 'actioned')} title="Mark actioned">✓</button>
                    <button className="ic-btn ic-btn-dim" onClick={() => updateOpportunityStatus(item.id, 'dismissed')} title="Dismiss">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Eisenhower matrix */}
        <div className="section-head">
          <span className="section-title">Priority Matrix</span>
          <span className="section-count">{totalInsights}</span>
        </div>

        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : totalInsights === 0 ? (
          <div className="empty-state">
            {feedIssues.length > 0
              ? <><strong>No insights rendered.</strong> The live feeds are degraded, so the dashboard is not trustworthy yet.</>
              : 'No open insights — everything is clear.'}
          </div>
        ) : (
          <div className="matrix">
            {QUADRANTS.map(q => {
              const items = matrix[q.key]
              return (
                <div className="quad" key={q.key} style={{ background: q.bg }}>
                  <div className="quad-head" style={{ background: q.bg }}>
                    <div className="quad-dot" style={{ background: q.accent }} />
                    <span className="quad-label">{q.label}</span>
                    <span className="quad-count">{items.length}</span>
                    <span className="quad-sub">{q.sub}</span>
                  </div>
                  <div className="quad-items">
                    {items.length === 0 ? (
                      <div className="quad-empty">Nothing here</div>
                    ) : (
                      items.slice(0, 5).map(item => (
                        <InsightCard
                          key={`${item._type}-${item.id}`}
                          item={item}
                          type={item._type}
                          onAction={item._type === 'relationship' ? handleAction : null}
                          onDismiss={item._type === 'relationship' ? handleDismiss : handleProjResolve}
                          groupsMap={groupsMap}
                        />
                      ))
                    )}
                    {items.length > 5 && (() => {
                      const overflow = items.slice(5)
                      const hasRel  = overflow.some(i => i._type === 'relationship')
                      const hasProj = overflow.some(i => i._type === 'project')
                      return (
                        <div style={{ padding: '.5rem .875rem', fontSize: '.72rem', color: 'var(--text-3)' }}>
                          +{items.length - 5} more —{' '}
                          {hasRel && <Link href="/relationships" style={{ color: 'var(--accent)', textDecoration: 'none' }}>relationships</Link>}
                          {hasRel && hasProj && <span> · </span>}
                          {hasProj && <Link href="/projects" style={{ color: 'var(--accent)', textDecoration: 'none' }}>projects</Link>}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Recent project activity */}
        {recentActivity.length > 0 && (
          <>
            <div className="section-head" style={{ marginTop: '2rem' }}>
              <span className="section-title">Recent Activity</span>
              <span className="section-count">{recentActivity.length}</span>
              <Link href="/projects" className="section-link">View projects →</Link>
            </div>
            <div className="activity-list">
              {recentActivity.map((a, i) => (
                <div key={i} className="activity-item">
                  <span className="ai-src">{a.source}</span>
                  <div className="ai-body">
                    <div className="ai-project">{a.project_name}</div>
                    <div className="ai-snippet">{a.content_snippet || a.subject}</div>
                  </div>
                  <span className="ai-date">{fmtDate(a.occurred_at)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}
