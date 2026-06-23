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

export default function DashboardPage() {
  const [relInsights, setRelInsights]     = useState([])
  const [projInsights, setProjInsights]   = useState([])
  const [relStats, setRelStats]           = useState(null)
  const [projStats, setProjStats]         = useState(null)
  const [recentActivity, setRecentActivity] = useState([])
  const [attentionItems, setAttentionItems] = useState([])
  const [groupsMap, setGroupsMap]         = useState({})
  const [loading, setLoading]             = useState(true)

  async function load() {
    try {
      const [ri, pi, rs, ps, ra, gr, aq] = await Promise.all([
        fetch('/api/relationships/insights').then(r => r.json()),
        fetch('/api/projects/insights/open').then(r => r.json()),
        fetch('/api/relationships/stats').then(r => r.json()),
        fetch('/api/projects/stats').then(r => r.json()),
        fetch('/api/projects/activity/recent').then(r => r.json()),
        fetch('/api/relationships/groups').then(r => r.json()),
        fetch('/api/intelligence/attention?limit=5').then(r => r.ok ? r.json() : []).catch(() => []),
      ])
      if (Array.isArray(ri)) setRelInsights(ri)
      if (Array.isArray(pi)) setProjInsights(pi)
      if (rs && !rs.error)  setRelStats(rs)
      if (ps && !ps.error)  setProjStats(ps)
      if (Array.isArray(ra)) setRecentActivity(ra.slice(0, 8))
      if (Array.isArray(aq)) setAttentionItems(aq)
      if (Array.isArray(gr)) {
        const map = {}
        for (const g of gr) if (g.wa_chat_id && g.name) map[g.wa_chat_id] = g.name
        setGroupsMap(map)
      }
    } catch { /* ignore */ }
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

  return (
    <>
      <style>{`
        .dash { max-width: 1100px; margin: 0 auto; padding: clamp(2rem,4vw,3rem) clamp(1.5rem,4vw,2rem) 4rem; }
        .dash-head { margin-bottom: 2rem; }
        .dash-title { font-family:'Fraunces',serif; font-weight:300; font-size: clamp(1.5rem,3vw,2rem); letter-spacing:-.03em; color:var(--text); margin-bottom:.25rem; }
        .dash-title em { font-style:italic; color:var(--accent); }
        .dash-desc { font-size:.825rem; color:var(--text-3); }

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
        .attention-age { font-size:.68rem; color:var(--text-3); }
        .attention-age-strong { color:var(--text); font-weight:600; }
        .attention-title { font-size:.875rem; font-weight:600; color:var(--text); line-height:1.35; }
        .attention-desc { font-size:.75rem; color:var(--text-2); line-height:1.45; margin-top:.2rem; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .attention-action { font-size:.72rem; color:var(--accent); margin-top:.3rem; }
        .attention-actions { display:flex; gap:.35rem; }

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
                      {item.expected_value_score != null && <span className="attention-score">score {Number(item.expected_value_score).toFixed(0)}</span>}
                      {(item.first_seen_at || item.created_at) && (
                        <span className="attention-age">
                          first seen <span className="attention-age-strong">{fmtAge(item.first_seen_at || item.created_at)}</span>
                        </span>
                      )}
                      {item.last_seen_at && item.last_seen_at !== (item.first_seen_at || item.created_at) && (
                        <span className="attention-age">updated {fmtAge(item.last_seen_at)}</span>
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
          <div className="empty-state">No open insights — everything is clear.</div>
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
