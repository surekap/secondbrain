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

function ItemCard({ item, onRemove }) {
  async function setStatus(status) {
    await fetch(`/api/intelligence/opportunities/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }).catch(() => {})
    onRemove(item.id)
  }

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
  const [q, setQ] = useState('')

  async function load() {
    setLoading(true)
    const [attention, opportunities, searchStats, refreshStatus] = await Promise.all([
      fetchJson('/api/intelligence/attention?limit=50', []),
      fetchJson('/api/intelligence/opportunities?limit=50', []),
      fetchJson('/api/search/stats', null),
      fetchJson('/api/intelligence/refresh/status', null),
    ])
    setItems(Array.isArray(attention) ? attention : [])
    setOpps(Array.isArray(opportunities) ? opportunities : [])
    setStats(searchStats)
    setRefresh(refreshStatus)
    setLoading(false)
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

      {loading ? <div className="empty">Loading intelligence…</div> : filtered.length === 0 ? <div className="empty">No intelligence items match this filter.</div> : (
        <div className="intel-list">
          {filtered.map(item => <ItemCard key={item.id} item={item} onRemove={id => setItems(prev => prev.filter(x => x.id !== id))} />)}
        </div>
      )}
    </div>
  )
}
