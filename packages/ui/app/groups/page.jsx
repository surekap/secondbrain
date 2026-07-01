'use client'
import { Suspense, useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import ResizablePanes from '../../components/ResizablePanes'

async function apiFetch(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)
  const r = await fetch(path, opts)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

function myPct(g) {
  return g.msg_count > 0 ? Math.round((g.my_msg_count / g.msg_count) * 100) : 0
}

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function typeLabel(t) {
  return { board_peers: 'Board / Peers', management: 'Management', employees: 'Employees', community: 'Community', unknown: 'Unknown' }[t] || t || '—'
}

function roleLabel(r) {
  return {
    active_leader: 'Active leader',
    active_participant: 'Active participant',
    occasional_contributor: 'Occasional contributor',
    status_receiver: 'Status receiver',
    passive_observer: 'Passive observer',
    unknown: 'Unknown',
  }[r] || r || '—'
}

const TYPE_COLOR = {
  board_peers: 'oklch(52% 0.14 290)',
  management:  'oklch(52% 0.14 240)',
  employees:   'oklch(49% 0.11 148)',
  community:   'oklch(68% 0.14 72)',
  unknown:     'var(--text-3)',
}

function GroupsPageContent() {
  const [groups, setGroups]       = useState([])
  const [filtered, setFiltered]   = useState([])
  const [selected, setSelected]   = useState(null)
  const [search, setSearch]       = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [messages, setMessages]   = useState([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [loading, setLoading]     = useState(true)
  const [activeTab, setActiveTab] = useState('summary')

  useEffect(() => {
    apiFetch('GET', '/api/relationships/groups')
      .then(data => { setGroups(data); setFiltered(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    const q = search.trim().toLowerCase()
    let result = typeFilter === 'all' ? groups : groups.filter(g => g.group_type === typeFilter)
    if (q) result = result.filter(g => (g.name || g.wa_chat_id || '').toLowerCase().includes(q))
    setFiltered(result)
  }, [search, typeFilter, groups])

  const autoSelectedRef = useRef(false)
  const searchParams = useSearchParams()

  useEffect(() => {
    if (autoSelectedRef.current || !groups.length) return
    const id = parseInt(searchParams.get('group'), 10)
    if (!id) return
    autoSelectedRef.current = true
    selectGroup(id)
  }, [groups, searchParams])

  async function selectGroup(id) {
    const g = groups.find(x => x.id === id)
    setSelected(g)
    setActiveTab('summary')
    setMessages([])
    setLoadingMsgs(true)
    try {
      const msgs = await apiFetch('GET', `/api/relationships/groups/${id}/messages`)
      setMessages(msgs)
    } catch { setMessages([]) }
    setLoadingMsgs(false)
  }

  // Counts per type for filter badges
  const typeCounts = groups.reduce((acc, g) => {
    const t = g.group_type || 'unknown'
    acc[t] = (acc[t] || 0) + 1
    return acc
  }, {})

  return (
    <>
      <style>{`
        .panel { overflow-y:auto;height:100%; }
        .panel::-webkit-scrollbar { width:4px; }
        .panel::-webkit-scrollbar-track { background:transparent; }
        .panel::-webkit-scrollbar-thumb { background:var(--border);border-radius:2px; }

        .list-header { padding:.875rem 1rem .625rem;border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:1; }
        .list-title-row { display:flex;align-items:baseline;gap:.5rem;margin-bottom:.5rem; }
        .list-title { font-size:.7rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3); }
        .list-count { font-size:.7rem;color:var(--text-3); }
        .search-input { width:100%;font-size:.8rem;padding:.35rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);outline:none;margin-bottom:.5rem; }
        .search-input:focus { border-color:var(--border-strong); }
        .filter-row { display:flex;gap:.3rem;flex-wrap:wrap; }
        .filter-chip { font-size:.68rem;font-weight:500;padding:.15rem .5rem;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--text-3);cursor:pointer;transition:all .12s;white-space:nowrap; }
        .filter-chip:hover { border-color:var(--border-strong);color:var(--text); }
        .filter-chip.active { background:var(--text);border-color:var(--text);color:var(--bg); }

        .group-item { padding:.75rem 1rem;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s; }
        .group-item:hover { background:var(--surface-2); }
        .group-item.selected { background:var(--accent-subtle); }
        .group-item-top { display:flex;align-items:flex-start;gap:.5rem;margin-bottom:.25rem; }
        .group-name { font-size:.825rem;font-weight:600;color:var(--text);flex:1;line-height:1.3;word-break:break-all; }
        .group-type-dot { width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px; }
        .group-meta { display:flex;align-items:center;gap:.5rem;font-size:.72rem;color:var(--text-3);flex-wrap:wrap; }
        .group-role-badge { font-size:.62rem;font-weight:500;padding:.1rem .4rem;border-radius:4px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-3); }

        .detail-empty { display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:.5rem;color:var(--text-3); }
        .detail-empty-icon { font-size:2rem;opacity:.4; }
        .detail-empty-text { font-size:.825rem; }

        .detail-header { padding:1.25rem 1.5rem 1rem;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0; }
        .detail-title { font-family:'Fraunces',serif;font-size:1.25rem;font-weight:400;line-height:1.3;margin-bottom:.5rem;word-break:break-all; }
        .detail-badges { display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:.5rem; }
        .detail-badge { font-size:.65rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:.2rem .55rem;border-radius:20px;border:1px solid currentColor; }
        .detail-stats { display:flex;gap:1.25rem;font-size:.75rem;color:var(--text-3);flex-wrap:wrap; }
        .detail-stat-val { font-weight:600;color:var(--text); }

        .tabs { display:flex;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0; }
        .tab { padding:.575rem 1rem;font-size:.775rem;font-weight:500;color:var(--text-3);cursor:pointer;border-bottom:2px solid transparent;transition:color .12s,border-color .12s;background:none;border-top:none;border-left:none;border-right:none; }
        .tab:hover { color:var(--text); }
        .tab.active { color:var(--accent);border-bottom-color:var(--accent); }

        .tab-body { flex:1;overflow-y:auto;padding:1rem 1.5rem; }
        .section-label { font-size:.65rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:.5rem; }
        .advice-box { background:var(--accent-subtle);border:1px solid var(--accent-border);border-radius:8px;padding:.75rem 1rem;font-size:.825rem;line-height:1.55;color:var(--text);margin-bottom:1.25rem; }
        .summary-text { font-size:.825rem;line-height:1.6;color:var(--text-2);margin-bottom:1.25rem; }
        .topic-chips { display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:1.25rem; }
        .topic-chip { font-size:.72rem;font-weight:500;padding:.2rem .55rem;background:var(--surface-2);border:1px solid var(--border);border-radius:20px;color:var(--text-2); }
        .opp-card { border:1px solid var(--border);border-radius:8px;padding:.75rem;margin-bottom:.5rem;background:var(--surface); }
        .opp-priority { display:inline-block;font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:.1rem .4rem;border-radius:4px;margin-bottom:.3rem; }
        .opp-priority.high   { background:var(--red-bg);color:var(--red);border:1px solid var(--red-border); }
        .opp-priority.medium { background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border); }
        .opp-priority.low    { background:var(--bg-2);color:var(--text-3);border:1px solid var(--border); }
        .opp-title { font-size:.8rem;font-weight:600;color:var(--text);margin-bottom:.2rem; }
        .opp-desc  { font-size:.75rem;color:var(--text-2);line-height:1.5; }
        .contact-card { border:1px solid var(--border);border-radius:8px;padding:.625rem .75rem;margin-bottom:.5rem;background:var(--surface); }
        .contact-card-name { font-size:.8rem;font-weight:600;color:var(--text);margin-bottom:.1rem; }
        .contact-card-role { font-size:.72rem;color:var(--text-3);margin-bottom:.2rem; }
        .contact-card-why  { font-size:.72rem;color:var(--text-2);line-height:1.45; }

        .messages-list { display:flex;flex-direction:column;gap:.5rem; }
        .msg-bubble { max-width:85%;padding:.5rem .75rem;border-radius:10px;font-size:.775rem;line-height:1.5; }
        .msg-bubble.from-me    { align-self:flex-end;background:oklch(90% .06 250);border-bottom-right-radius:3px; }
        .msg-bubble.from-them  { align-self:flex-start;background:var(--surface-2);border:1px solid var(--border);border-bottom-left-radius:3px; }
        .msg-sender { font-size:.65rem;font-weight:600;color:var(--text-3);margin-bottom:2px; }
        .msg-time   { font-size:.62rem;color:var(--text-3);margin-top:3px; }

        .right-panel { padding:1rem; }
        .stat-grid { display:grid;grid-template-columns:1fr 1fr;gap:.625rem;margin-bottom:1.25rem; }
        .stat-box { background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.75rem;text-align:center; }
        .stat-box-val { font-family:'Fraunces',serif;font-size:1.35rem;font-weight:400;letter-spacing:-.02em;color:var(--text);line-height:1; }
        .stat-box-lbl { font-size:.63rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-top:.25rem; }
        .dates-block { font-size:.78rem;color:var(--text-2);line-height:2;margin-bottom:1.25rem; }
        .dates-block span { color:var(--text-3); }

        .not-analyzed { padding:1rem;text-align:center;font-size:.78rem;color:var(--text-3);line-height:1.6; }
        .loading { text-align:center;padding:2rem;color:var(--text-3);font-size:.8rem; }
        .empty-panel { padding:1.5rem 1rem;text-align:center;color:var(--text-3);font-size:.78rem;line-height:1.6; }
      `}</style>

      <ResizablePanes storageKey="groups" initialLeft={280} initialRight={280}>
        {/* Left: group list */}
        <div className="panel">
          <div className="list-header">
            <div className="list-title-row">
              <span className="list-title">WhatsApp Groups</span>
              <span className="list-count">({filtered.length})</span>
            </div>
            <input className="search-input" type="text" placeholder="Filter by name…"
              value={search} onChange={e => setSearch(e.target.value)} />
            <div className="filter-row">
              {[
                { f: 'all', label: 'All' },
                { f: 'board_peers', label: 'Board' },
                { f: 'management', label: 'Mgmt' },
                { f: 'employees', label: 'Staff' },
                { f: 'community', label: 'Community' },
                { f: 'unknown', label: 'Unknown' },
              ].map(({ f, label }) => (
                <div key={f} className={`filter-chip${typeFilter === f ? ' active' : ''}`}
                  onClick={() => setTypeFilter(f)}>
                  {label}{f !== 'all' && typeCounts[f] ? ` ${typeCounts[f]}` : ''}
                </div>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="loading">Loading groups…</div>
          ) : filtered.length === 0 ? (
            <div className="loading">No groups match</div>
          ) : (
            filtered.map(g => (
              <div key={g.id} className={`group-item${selected?.id === g.id ? ' selected' : ''}`}
                onClick={() => selectGroup(g.id)}>
                <div className="group-item-top">
                  <div className="group-type-dot" style={{ background: TYPE_COLOR[g.group_type] || 'var(--border-strong)' }} />
                  <div className="group-name">{g.name || g.wa_chat_id}</div>
                </div>
                <div className="group-meta">
                  {g.my_role && g.my_role !== 'unknown' && (
                    <span className="group-role-badge">{roleLabel(g.my_role)}</span>
                  )}
                  <span>{(g.msg_count || 0).toLocaleString()} msgs · {myPct(g)}% mine</span>
                  <span>{fmtDate(g.last_activity_at)}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Middle: detail + messages */}
        <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
          {!selected ? (
            <div className="detail-empty">
              <div className="detail-empty-icon">💬</div>
              <div className="detail-empty-text">Select a group to view analysis</div>
            </div>
          ) : (
            <>
              <div className="detail-header">
                <div className="detail-title">{selected.name || selected.wa_chat_id}</div>
                <div className="detail-badges">
                  {selected.group_type && selected.group_type !== 'unknown' && (
                    <span className="detail-badge" style={{ color: TYPE_COLOR[selected.group_type] }}>
                      {typeLabel(selected.group_type)}
                    </span>
                  )}
                  {selected.my_role && selected.my_role !== 'unknown' && (
                    <span className="detail-badge" style={{ color: 'var(--text-3)' }}>
                      {roleLabel(selected.my_role)}
                    </span>
                  )}
                </div>
                <div className="detail-stats">
                  <span><span className="detail-stat-val">{(selected.msg_count || 0).toLocaleString()}</span> messages</span>
                  <span><span className="detail-stat-val">{myPct(selected)}%</span> mine</span>
                  <span>Active <span className="detail-stat-val">{fmtDate(selected.last_activity_at)}</span></span>
                  {selected.analyzed_at && (
                    <span>Analyzed <span className="detail-stat-val">{fmtDate(selected.analyzed_at)}</span></span>
                  )}
                </div>
              </div>

              <div className="tabs">
                <button className={`tab${activeTab === 'summary' ? ' active' : ''}`} onClick={() => setActiveTab('summary')}>Summary</button>
                <button className={`tab${activeTab === 'opportunities' ? ' active' : ''}`} onClick={() => setActiveTab('opportunities')}>
                  Opportunities {(selected.opportunities || []).length > 0 ? `(${selected.opportunities.length})` : ''}
                </button>
                <button className={`tab${activeTab === 'contacts' ? ' active' : ''}`} onClick={() => setActiveTab('contacts')}>
                  Contacts {(selected.notable_contacts || []).length > 0 ? `(${selected.notable_contacts.length})` : ''}
                </button>
                <button className={`tab${activeTab === 'messages' ? ' active' : ''}`} onClick={() => setActiveTab('messages')}>Messages</button>
              </div>

              <div className="tab-body">
                {activeTab === 'summary' && (
                  !selected.ai_summary && !selected.communication_advice ? (
                    <div className="not-analyzed">Not yet analyzed. Run the relationships agent to generate intelligence.</div>
                  ) : (
                    <>
                      {selected.communication_advice && (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="section-label">How to engage</div>
                          <div className="advice-box">{selected.communication_advice}</div>
                        </div>
                      )}
                      {selected.ai_summary && (
                        <div style={{ marginBottom: '1.25rem' }}>
                          <div className="section-label">About this group</div>
                          <div className="summary-text">{selected.ai_summary}</div>
                        </div>
                      )}
                      {(selected.key_topics || []).length > 0 && (
                        <div>
                          <div className="section-label">Key topics</div>
                          <div className="topic-chips">
                            {selected.key_topics.map((t, i) => <span key={i} className="topic-chip">{t}</span>)}
                          </div>
                        </div>
                      )}
                    </>
                  )
                )}

                {activeTab === 'opportunities' && (
                  (selected.opportunities || []).length === 0 ? (
                    <div className="empty-panel">No opportunities detected.</div>
                  ) : (
                    selected.opportunities.map((o, i) => (
                      <div key={i} className="opp-card">
                        <div className={`opp-priority ${o.priority || 'low'}`}>{(o.priority || 'low').toUpperCase()}</div>
                        <div className="opp-title">{o.title}</div>
                        <div className="opp-desc">{o.description}</div>
                      </div>
                    ))
                  )
                )}

                {activeTab === 'contacts' && (
                  (selected.notable_contacts || []).length === 0 ? (
                    <div className="empty-panel">No notable contacts flagged.</div>
                  ) : (
                    selected.notable_contacts.map((c, i) => (
                      <div key={i} className="contact-card">
                        <div className="contact-card-name">{c.name}</div>
                        {c.role_or_context && <div className="contact-card-role">{c.role_or_context}</div>}
                        <div className="contact-card-why">{c.why_notable}</div>
                      </div>
                    ))
                  )
                )}

                {activeTab === 'messages' && (
                  loadingMsgs ? (
                    <div className="loading">Loading messages…</div>
                  ) : messages.length === 0 ? (
                    <div className="empty-panel">No messages found.</div>
                  ) : (
                    <div className="messages-list">
                      {messages.map((m, i) => (
                        <div key={i} className={`msg-bubble ${m.from_me ? 'from-me' : 'from-them'}`}>
                          {!m.from_me && m.notify_name && <div className="msg-sender">{m.notify_name}</div>}
                          {(m.body || '').slice(0, 500)}
                          <div className="msg-time">{fmtDateTime(m.ts)}</div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: stats */}
        <div className="panel right-panel">
          {!selected ? (
            <div className="empty-panel">Select a group to see stats.</div>
          ) : (
            <>
              <div className="section-label" style={{ marginBottom: '.75rem' }}>Activity</div>
              <div className="stat-grid">
                <div className="stat-box">
                  <div className="stat-box-val">{(selected.msg_count || 0).toLocaleString()}</div>
                  <div className="stat-box-lbl">Total msgs</div>
                </div>
                <div className="stat-box">
                  <div className="stat-box-val">{myPct(selected)}%</div>
                  <div className="stat-box-lbl">My share</div>
                </div>
                <div className="stat-box">
                  <div className="stat-box-val">{(selected.my_msg_count || 0).toLocaleString()}</div>
                  <div className="stat-box-lbl">My msgs</div>
                </div>
                <div className="stat-box">
                  <div className="stat-box-val">{selected.msg_count > 0 ? (selected.msg_count - selected.my_msg_count).toLocaleString() : '—'}</div>
                  <div className="stat-box-lbl">Others</div>
                </div>
              </div>

              <div className="section-label" style={{ marginBottom: '.5rem' }}>Dates</div>
              <div className="dates-block">
                <div><span>First seen </span>{fmtDate(selected.first_seen_at)}</div>
                <div><span>Last active </span>{fmtDate(selected.last_activity_at)}</div>
                {selected.analyzed_at && <div><span>Analyzed </span>{fmtDate(selected.analyzed_at)}</div>}
              </div>

              {(selected.tags || []).length > 0 && (
                <>
                  <div className="section-label" style={{ marginBottom: '.5rem' }}>Tags</div>
                  <div className="topic-chips">
                    {selected.tags.map((t, i) => <span key={i} className="topic-chip">{t}</span>)}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </ResizablePanes>
    </>
  )
}

export default function GroupsPage() {
  return (
    <Suspense fallback={<div className="loading">Loading groups…</div>}>
      <GroupsPageContent />
    </Suspense>
  )
}
