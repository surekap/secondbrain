'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

const SURFACE_OPTIONS = ['all', 'capital', 'relationship', 'internal', 'project', 'admin', 'closure']

async function fetchJson(path, fallback) {
  try {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (error) {
    return fallback
  }
}

async function fetchJsonDetailed(path, fallback) {
  try {
    const res = await fetch(path)
    if (!res.ok) return { data: fallback, error: `HTTP ${res.status}` }
    return { data: await res.json(), error: null }
  } catch (error) {
    return { data: fallback, error: error?.message || 'request failed' }
  }
}

function fmtAge(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const diff = Math.max(0, Date.now() - d.getTime())
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins || 1}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function score(item) {
  return Number(item.attention_score ?? item.expected_value_score ?? 0).toFixed(0)
}

function parseCrossChannelSourceRef(sourceRef) {
  if (typeof sourceRef !== 'string') return {}
  if (!sourceRef.startsWith('cross_channel_project:')) return {}
  const parts = sourceRef.split(':')
  return {
    projectId: parts[1] || null,
    groupId: parts[2] || null,
    contactId: parts[3] || null,
  }
}

function traceTargets(item) {
  const targets = []
  const seen = new Set()
  const add = (href, label) => {
    if (!href || seen.has(href)) return
    seen.add(href)
    targets.push({ href, label })
  }

  const refs = Array.isArray(item?.source_refs) && item.source_refs.length > 0
    ? item.source_refs
    : (item?.source_ref ? [item.source_ref] : [])

  for (const ref of refs) {
    if (typeof ref !== 'string') continue
    const parsed = parseCrossChannelSourceRef(ref)
    if (parsed.groupId) add(`/groups?group=${encodeURIComponent(parsed.groupId)}`, 'Trace group')
    if (parsed.contactId) add(`/relationships?contact=${encodeURIComponent(parsed.contactId)}`, 'Trace contact')
    if (ref.startsWith('group:')) add(`/groups?group=${encodeURIComponent(ref.slice(6))}`, 'Trace group')
    if (ref.startsWith('project:')) add(`/projects?project=${encodeURIComponent(ref.slice(8))}`, 'Trace project')
  }

  if (item?.primary_contact_id) add(`/relationships?contact=${encodeURIComponent(item.primary_contact_id)}`, 'Open contact')
  if (item?.primary_project_id) add(`/projects?project=${encodeURIComponent(item.primary_project_id)}`, 'Open project')
  return targets
}

function evidenceTraceHref(ev, item) {
  const meta = ev?.metadata || {}
  if (ev?.source_table === 'relationships.groups') {
    const groupId = meta.group_id || ev.source_id
    if (groupId) return `/groups?group=${encodeURIComponent(groupId)}`
  }
  if (meta.contact_id) return `/relationships?contact=${encodeURIComponent(meta.contact_id)}`
  if (item?.primary_contact_id) return `/relationships?contact=${encodeURIComponent(item.primary_contact_id)}`
  if (item?.primary_project_id) return `/projects?project=${encodeURIComponent(item.primary_project_id)}`
  return null
}

function ItemCard({ item, onRemove, evidence, evidenceLoading, evidenceOpen, onToggleEvidence }) {
  async function setStatus(status) {
    await fetch(`/api/intelligence/opportunities/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => {})
    onRemove(item.id)
  }

  const evidenceCount = Number(item.evidence_count || 0)

  return (
    <article className="intel-card">
      <div className="intel-card-main">
        <div className="intel-meta">
          <span className="pill primary">attention {score(item)}</span>
          <span className="pill">{String(item.opportunity_type || item.item_type || 'opportunity').replace(/_/g, ' ')}</span>
          {item.surface_bucket && <span className="pill">{String(item.surface_bucket).replace(/_/g, ' ')}</span>}
          {item.evidence_count != null && <span className="pill">{Number(item.evidence_count)} evidence</span>}
          {item.primary_contact_name && <span className="pill muted">{item.primary_contact_name}</span>}
          {item.primary_project_name && <span className="pill muted">{item.primary_project_name}</span>}
          {(item.quality_flags || []).slice(0, 3).map(flag => <span className="pill warn" key={flag}>{String(flag).replace(/_/g, ' ')}</span>)}
        </div>
        <h2>{item.title}</h2>
        {item.description && <p className="desc">{item.description}</p>}
        {item.recommended_next_action && <p className="next"><strong>Next:</strong> {item.recommended_next_action}</p>}
        <div className="why">
          {item.why_now || 'No timing rationale recorded.'}
          {(item.source_last_seen_at || item.last_seen_at) && <span> · source updated {fmtAge(item.source_last_seen_at || item.last_seen_at)}</span>}
        </div>

        {traceTargets(item).length > 0 && (
          <div className="trace-row">
            {traceTargets(item).map(target => (
              <Link key={target.href} className="trace-pill" href={target.href}>
                {target.label}
              </Link>
            ))}
          </div>
        )}

        {evidenceCount > 0 && (
          <div className="evidence-panel">
            <button className="evidence-toggle" onClick={() => onToggleEvidence(item.id)}>
              {evidenceOpen ? 'Hide evidence' : `Show evidence (${evidenceCount})`}
            </button>
            {evidenceOpen && (
              <div className="evidence-list">
                {evidenceLoading ? (
                  <div className="evidence-empty">Loading evidence…</div>
                ) : evidence?.length ? (
                  evidence.map(ev => {
                    const href = evidenceTraceHref(ev, item)
                    return (
                    <div className="evidence-item" key={ev.id}>
                      <div className="evidence-meta">
                        <span className="evidence-source">{String(ev.source_table || 'evidence').replace(/_/g, ' ')}</span>
                        {ev.occurred_at && <span>{fmtAge(ev.occurred_at)}</span>}
                        {ev.relevance != null && <span>relevance {Number(ev.relevance).toFixed(2)}</span>}
                        {ev.source_ref && <span className="evidence-ref">{ev.source_ref}</span>}
                      </div>
                      <div className="evidence-quote">{ev.excerpt || ev.quote || 'No excerpt recorded.'}</div>
                      {href && (
                        <div className="trace-row">
                          <Link className="trace-link" href={href}>
                            Trace communication
                          </Link>
                        </div>
                      )}
                    </div>
                    )
                  })
                ) : (
                  <div className="evidence-empty">No evidence rows returned.</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="intel-actions">
        <button onClick={() => setStatus('actioned')}>Actioned</button>
        <button className="ghost" onClick={() => setStatus('dismissed')}>Dismiss</button>
      </div>
    </article>
  )
}

export default function IntelligencePage() {
  const [items, setItems] = useState([])
  const [opps, setOpps] = useState([])
  const [stats, setStats] = useState(null)
  const [refresh, setRefresh] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadIssues, setLoadIssues] = useState([])
  const [q, setQ] = useState('')
  const [surface, setSurface] = useState('all')
  const [expandedEvidence, setExpandedEvidence] = useState({})
  const [evidenceById, setEvidenceById] = useState({})
  const [evidenceLoadingById, setEvidenceLoadingById] = useState({})

  async function load() {
    setLoading(true)
    const attentionPath = surface && surface !== 'all'
      ? `/api/intelligence/attention?limit=50&surface=${encodeURIComponent(surface)}`
      : '/api/intelligence/attention?limit=50'
    const [attention, opportunities, searchStats, refreshStatus] = await Promise.all([
      fetchJsonDetailed(attentionPath, []),
      fetchJsonDetailed('/api/intelligence/opportunities?limit=50', []),
      fetchJsonDetailed('/api/search/stats', null),
      fetchJsonDetailed('/api/intelligence/refresh/status', null),
    ])
    setItems(Array.isArray(attention.data) ? attention.data : [])
    setOpps(Array.isArray(opportunities.data) ? opportunities.data : [])
    setStats(searchStats.data)
    setRefresh(refreshStatus.data)
    setLoadIssues([
      attention.error && `attention: ${attention.error}`,
      opportunities.error && `opportunities: ${opportunities.error}`,
      searchStats.error && `search stats: ${searchStats.error}`,
      refreshStatus.error && `refresh status: ${refreshStatus.error}`,
    ].filter(Boolean))
    setLoading(false)
  }

  async function toggleEvidence(id) {
    setExpandedEvidence(prev => ({ ...prev, [id]: !prev[id] }))
    if (expandedEvidence[id] || evidenceById[id] || evidenceLoadingById[id]) return

    setEvidenceLoadingById(prev => ({ ...prev, [id]: true }))
    const data = await fetchJsonDetailed(`/api/intelligence/opportunities/${id}/evidence?limit=5`, [])
    setEvidenceById(prev => ({ ...prev, [id]: Array.isArray(data.data) ? data.data : [] }))
    setEvidenceLoadingById(prev => ({ ...prev, [id]: false }))
  }

  useEffect(() => { load() }, [surface])

  const filtered = items.filter(item => {
    const needle = q.trim().toLowerCase()
    if (!needle) return true
    return [item.title, item.description, item.recommended_next_action, item.primary_contact_name, item.primary_project_name]
      .filter(Boolean).join(' ').toLowerCase().includes(needle)
  })
  const emailStats = stats?.sources?.find(s => s.source === 'email')
  const lastRefresh = refresh?.last

  return (
    <div className="intel-page">
      <style>{`
        .intel-page { max-width:1180px; margin:0 auto; padding:clamp(2rem,4vw,3rem) clamp(1.25rem,4vw,2rem) 4rem; }
        .intel-head { display:flex; justify-content:space-between; gap:1rem; align-items:flex-start; margin-bottom:1.25rem; }
        .intel-head h1 { font-family:'Fraunces',serif; font-size:clamp(1.7rem,3vw,2.35rem); font-weight:300; letter-spacing:-.035em; margin:0; color:var(--text); }
        .intel-sub { color:var(--text-3); font-size:.86rem; margin-top:.35rem; line-height:1.5; }
        .health-banner {
          display:flex; align-items:flex-start; justify-content:space-between; gap:1rem;
          border:1px solid var(--amber-border); background:var(--amber-bg); color:var(--amber);
          border-radius:12px; padding:.9rem 1rem; margin:1rem 0 1.25rem; font-size:.82rem;
        }
        .health-banner strong { color:inherit; }
        .health-banner ul { margin:.35rem 0 0; padding-left:1.1rem; }
        .health-banner li + li { margin-top:.2rem; }
        .health-link { color:inherit; font-weight:600; text-decoration:underline; white-space:nowrap; }
        .refresh-btn, .intel-actions button { border:1px solid var(--border); background:var(--surface); color:var(--text); border-radius:8px; padding:.45rem .7rem; cursor:pointer; font-size:.78rem; }
        .refresh-btn:hover, .intel-actions button:hover { border-color:var(--border-strong); background:var(--surface-2); }
        .intel-actions .ghost { color:var(--text-3); }
        .intel-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.75rem; margin:1rem 0 1.5rem; }
        @media(max-width:760px){ .intel-stats { grid-template-columns:1fr 1fr; } .intel-head { flex-direction:column; } .intel-card { grid-template-columns:1fr !important; } }
        .stat { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:.85rem 1rem; }
        .stat-val { font-family:'Fraunces',serif; font-size:1.45rem; color:var(--text); line-height:1; }
        .stat-lbl { margin-top:.25rem; color:var(--text-3); font-size:.68rem; text-transform:uppercase; letter-spacing:.07em; font-weight:700; }
        .toolbar { display:flex; flex-direction:column; gap:.55rem; align-items:stretch; margin-bottom:1rem; }
        .toolbar-row { display:flex; gap:.75rem; align-items:center; }
        .surface-bar { display:flex; flex-wrap:wrap; gap:.4rem; }
        .surface-chip { border:1px solid var(--border); background:var(--surface); color:var(--text-3); border-radius:999px; padding:.32rem .65rem; font-size:.68rem; cursor:pointer; text-transform:capitalize; }
        .surface-chip.active { color:var(--accent); border-color:color-mix(in oklab, var(--accent) 30%, var(--border)); background:color-mix(in oklab, var(--accent) 8%, var(--surface)); }
        .surface-chip:hover { border-color:var(--border-strong); }
        .search { flex:1; border:1px solid var(--border); background:var(--surface); border-radius:10px; padding:.65rem .8rem; color:var(--text); }
        .api-link { color:var(--accent); font-size:.78rem; text-decoration:none; white-space:nowrap; }
        .intel-list { display:flex; flex-direction:column; gap:.75rem; }
        .intel-card { display:grid; grid-template-columns:1fr auto; gap:1rem; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem; }
        .intel-card h2 { margin:.35rem 0 .35rem; font-size:1rem; line-height:1.35; color:var(--text); }
        .intel-meta { display:flex; flex-wrap:wrap; gap:.35rem; align-items:center; }
        .pill { border:1px solid var(--border); background:var(--surface-2); color:var(--text-3); border-radius:999px; padding:.12rem .45rem; font-size:.67rem; text-transform:capitalize; }
        .pill.primary { color:var(--accent); border-color:color-mix(in oklab, var(--accent) 30%, var(--border)); }
        .pill.warn { color:var(--amber); background:var(--amber-bg); border-color:var(--amber-border); }
        .pill.muted { color:var(--text-2); }
        .desc { color:var(--text-2); font-size:.82rem; line-height:1.5; margin:.35rem 0; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
        .next { color:var(--accent); font-size:.8rem; line-height:1.45; margin:.45rem 0; }
        .why { color:var(--text-3); font-size:.72rem; line-height:1.45; }
        .evidence-panel { margin-top:.65rem; border-top:1px solid var(--border); padding-top:.65rem; }
        .evidence-toggle { border:1px solid var(--border); background:var(--surface-2); color:var(--text); border-radius:8px; padding:.35rem .6rem; font-size:.72rem; cursor:pointer; }
        .evidence-toggle:hover { border-color:var(--border-strong); }
        .evidence-list { margin-top:.6rem; display:flex; flex-direction:column; gap:.5rem; }
        .evidence-item { border:1px solid var(--border); border-radius:10px; background:var(--surface-2); padding:.65rem .75rem; }
        .evidence-meta { display:flex; flex-wrap:wrap; gap:.35rem; color:var(--text-3); font-size:.68rem; margin-bottom:.35rem; }
        .evidence-source { text-transform:capitalize; color:var(--accent); }
        .evidence-ref { font-family:monospace; }
        .evidence-link { color:var(--accent); text-decoration:none; font-weight:600; }
        .evidence-link:hover { text-decoration:underline; }
        .trace-link { color:var(--accent); text-decoration:none; font-size:.72rem; font-weight:600; }
        .trace-link:hover { text-decoration:underline; }
        .trace-row { display:flex; gap:.55rem; flex-wrap:wrap; margin-top:.35rem; }
        .trace-pill { display:inline-flex; align-items:center; gap:.25rem; padding:.12rem .45rem; border-radius:999px; border:1px solid color-mix(in oklab, var(--accent) 30%, var(--border)); background:color-mix(in oklab, var(--accent) 6%, var(--surface-2)); color:var(--accent); text-decoration:none; font-size:.66rem; font-weight:600; }
        .trace-pill:hover { text-decoration:underline; }
        .trace-pill.secondary { color:var(--text-2); border-color:var(--border); background:var(--surface-2); }
        .trace-pill.secondary:hover { text-decoration:none; border-color:var(--border-strong); }
        .trace-note { color:var(--text-3); font-size:.66rem; }
        .evidence-quote { color:var(--text); font-size:.76rem; line-height:1.45; white-space:pre-wrap; }
        .evidence-empty { color:var(--text-3); font-size:.72rem; }
        .intel-actions { display:flex; gap:.4rem; align-items:flex-start; }
        .empty { border:1px dashed var(--border); border-radius:12px; padding:2rem; color:var(--text-3); text-align:center; }
      `}</style>

      <div className="intel-head">
        <div>
          <h1>Intelligence</h1>
          <div className="intel-sub">Attention-ranked opportunities, open loops, project signals, and email-derived intelligence.</div>
        </div>
        <button className="refresh-btn" onClick={load}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>

      {loadIssues.length > 0 && (
        <div className="health-banner">
          <div>
            <strong>Intelligence feeds degraded.</strong> Some slices fell back to empty/cache state.
            <ul>
              {loadIssues.slice(0, 4).map(issue => <li key={issue}>{issue}</li>)}
            </ul>
          </div>
          <a className="health-link" href="/observe">Check Observe</a>
        </div>
      )}

      <div className="intel-stats">
        <div className="stat"><div className="stat-val">{items.length}</div><div className="stat-lbl">Attention items</div></div>
        <div className="stat"><div className="stat-val">{opps.length}</div><div className="stat-lbl">Open opportunities loaded</div></div>
        <div className="stat"><div className="stat-val">{emailStats ? Number(emailStats.total).toLocaleString() : '—'}</div><div className="stat-lbl">Emails ingested</div></div>
        <div className="stat"><div className="stat-val">{lastRefresh?.status || '—'}</div><div className="stat-lbl">Last refresh</div></div>
      </div>

      <div className="toolbar">
        <div className="surface-bar" role="tablist" aria-label="Attention surfaces">
          {SURFACE_OPTIONS.map(option => (
            <button
              key={option}
              type="button"
              className={`surface-chip ${surface === option ? 'active' : ''}`}
              onClick={() => setSurface(option)}
            >
              {option === 'all' ? 'All' : option.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
        <div className="toolbar-row">
          <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter intelligence… e.g. project, capital, follow-up" />
          <a className="api-link" href={`/api/intelligence/attention?limit=50${surface && surface !== 'all' ? `&surface=${encodeURIComponent(surface)}` : ''}`}>API →</a>
        </div>
      </div>

      {loading ? <div className="empty">Loading intelligence…</div> : filtered.length === 0 ? (
        <div className="empty">
          {loadIssues.length > 0
            ? <>No live items rendered. The intelligence pipeline is degraded, so this surface is not trustworthy yet.</>
            : refresh?.last?.status && refresh.last.status !== 'completed'
              ? <>No items rendered. Last refresh is <strong>{refresh.last.status}</strong>; fix the refresh pipeline first.</>
              : 'No intelligence items match this filter.'}
        </div>
      ) : (
        <div className="intel-list">
          {filtered.map(item => (
            <ItemCard
              key={item.id}
              item={item}
              onRemove={id => setItems(prev => prev.filter(x => x.id !== id))}
              evidence={evidenceById[item.id]}
              evidenceLoading={Boolean(evidenceLoadingById[item.id])}
              evidenceOpen={Boolean(expandedEvidence[item.id])}
              onToggleEvidence={toggleEvidence}
            />
          ))}
        </div>
      )}
    </div>
  )
}
