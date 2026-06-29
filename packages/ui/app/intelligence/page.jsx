'use client'

import { useEffect, useState } from 'react'

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
                  evidence.map(ev => (
                    <div className="evidence-item" key={ev.id}>
                      <div className="evidence-meta">
                        <span className="evidence-source">{String(ev.source_table || 'evidence').replace(/_/g, ' ')}</span>
                        {ev.occurred_at && <span>{fmtAge(ev.occurred_at)}</span>}
                        {ev.relevance != null && <span>relevance {Number(ev.relevance).toFixed(2)}</span>}
                        {ev.source_ref && <span className="evidence-ref">{ev.source_ref}</span>}
                      </div>
                      <div className="evidence-quote">{ev.excerpt || ev.quote || 'No excerpt recorded.'}</div>
                    </div>
                  ))
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
  const [expandedEvidence, setExpandedEvidence] = useState({})
  const [evidenceById, setEvidenceById] = useState({})
  const [evidenceLoadingById, setEvidenceLoadingById] = useState({})

  async function load() {
    setLoading(true)
    const [attention, opportunities, searchStats, refreshStatus] = await Promise.all([
      fetchJsonDetailed('/api/intelligence/attention?limit=50', []),
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

  useEffect(() => { load() }, [])

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
        .toolbar { display:flex; justify-content:space-between; gap:.75rem; align-items:center; margin-bottom:1rem; }
        .search { flex:1; border:1px solid var(--border); background:var(--surface); border-radius:10px; padding:.65rem .8rem; color:var(--text); }
        .api-link { color:var(--accent); font-size:.78rem; text-decoration:none; }
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
        <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter intelligence… e.g. Jxtapose, Hartex, Vikas" />
        <a className="api-link" href="/api/intelligence/attention?limit=50">API →</a>
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
