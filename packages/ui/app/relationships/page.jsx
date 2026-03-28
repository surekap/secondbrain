'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
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

function avatarInitial(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name[0].toUpperCase()
}

function avatarColor(name) {
  let hash = 0
  for (const c of (name || '?')) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  const hues = [52, 148, 240, 290, 25, 70, 200, 320]
  const hue = hues[Math.abs(hash) % hues.length]
  return `oklch(52% 0.13 ${hue})`
}

function sourceIcon(source) {
  return { email: '📧', whatsapp: '💬', limitless: '🎙️' }[source] || '📌'
}

function resolveGroupIds(text, groupsMap) {
  if (!text) return text
  return text
    .replace(/(\d{5,})@g\.us/g, (_, id) => (groupsMap && groupsMap[id + '@g.us']) || (groupsMap && groupsMap[id]) || 'WhatsApp group')
    .replace(/(\d{5,})@c\.us/g, (_, num) => '+' + num)
}

function insightIcon(type) {
  return {
    awaiting_reply: '💬',
    unread_group: '👥',
    cold_email: '📧',
    opportunity: '✨',
    action_needed: '⚡',
    topic: '💡',
    cross_source_opportunity: '🔗',
    project_match: '🎯',
  }[type] || '📌'
}

function priorityIcon(p) {
  return { high: '🔴', medium: '🟡', low: '⚪' }[p] || '⚪'
}

function isJpegB64(s) {
  return typeof s === 'string' && (s.startsWith('/9j/') || s.startsWith('iVBOR')) && s.length > 200
}

function CommContent({ comm }) {
  const meta = comm.metadata || {}
  const snippet = comm.content_snippet || comm.subject || ''
  const msgType = meta.msg_type || ''

  if (meta.thumbnail_b64) {
    const caption = (snippet && !isJpegB64(snippet)) ? snippet : null
    return (
      <>
        {caption && <div className="comm-snippet">{caption}</div>}
        <img className="comm-media-thumb"
          src={`data:image/jpeg;base64,${meta.thumbnail_b64}`}
          alt={msgType || 'media'}
          onClick={() => {
            const src = meta.wa_msg_id
              ? `/api/media/wa/${encodeURIComponent(meta.wa_msg_id)}`
              : `data:image/jpeg;base64,${meta.thumbnail_b64}`
            window.__openLightbox?.(src)
          }}
        />
        {meta.msg_type === 'document' && meta.wa_msg_id && (
          <a href={`/api/media/wa/${encodeURIComponent(meta.wa_msg_id)}`} target="_blank" rel="noreferrer">
            Download {meta.filename || 'document'}
          </a>
        )}
      </>
    )
  }

  if (isJpegB64(snippet)) {
    return (
      <img className="comm-media-thumb"
        src={`data:image/jpeg;base64,${snippet}`}
        alt="image"
        onClick={() => window.__openLightbox?.(`data:image/jpeg;base64,${snippet}`)}
      />
    )
  }

  return (
    <>
      {comm.subject && <div className="comm-subject">{comm.subject}</div>}
      {snippet && <div className="comm-snippet">{snippet}</div>}
    </>
  )
}

function TagEditor({ tags, onChange }) {
  const [inputVal, setInputVal] = useState('')

  function addTag(raw) {
    const tag = raw.trim().replace(/,+$/, '').toLowerCase()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
  }

  function removeTag(i) {
    onChange(tags.filter((_, idx) => idx !== i))
  }

  function handleKeyDown(e) {
    if ((e.key === 'Enter' || e.key === ',') && inputVal.trim()) {
      e.preventDefault()
      addTag(inputVal)
      setInputVal('')
    } else if (e.key === 'Backspace' && !inputVal && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="tag-editor" onClick={() => document.getElementById('tag-input-rel')?.focus()}>
      {tags.map((tag, i) => (
        <span className="tag-chip" key={i}>
          {tag}
          <button className="tag-remove-btn" type="button" onClick={() => removeTag(i)}>×</button>
        </span>
      ))}
      <input
        className="tag-input"
        id="tag-input-rel"
        type="text"
        placeholder="Add tag, press Enter…"
        value={inputVal}
        onChange={e => setInputVal(e.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}

export default function RelationshipsPage() {
  const searchParams = useSearchParams()
  const autoSelectedRef = useRef(false)

  const [contacts, setContacts] = useState([])
  const [selectedContactId, setSelectedContactId] = useState(null)
  const [selectedContact, setSelectedContact] = useState(null)
  const [insights, setInsights] = useState([])
  const [groupsMap, setGroupsMap] = useState({})
  const [insightFilter, setInsightFilterState] = useState('')
  const [stats, setStats] = useState(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [searchDebounce, setSearchDebounce] = useState(null)
  const [toast, setToast] = useState({ msg: '', visible: false })
  const toastTimer = useRef(null)
  const [lightboxSrc, setLightboxSrc] = useState(null)
  const [detailTab, setDetailTab] = useState('communications') // 'communications' | 'research' | 'opportunities'
  const [sourceFilter, setSourceFilter] = useState('')  // '' | 'whatsapp' | 'email' | 'limitless'
  const [contactResearch, setContactResearch] = useState(null)
  const [contactOpportunities, setContactOpportunities] = useState([])
  const [researchRefreshing, setResearchRefreshing] = useState(false)

  // Edit modal state
  const [editOpen, setEditOpen] = useState(false)
  const [editName, setEditName] = useState('')
  const [editCompany, setEditCompany] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editRelType, setEditRelType] = useState('unknown')
  const [editStrength, setEditStrength] = useState('weak')
  const [editSummary, setEditSummary] = useState('')
  const [editTags, setEditTags] = useState([])
  const [savingContact, setSavingContact] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)
  const [reanalyzeStatus, setReanalyzeStatus] = useState('')
  const [reanalyzeColor, setReanalyzeColor] = useState('var(--text-3)')

  useEffect(() => { window.__openLightbox = (src) => setLightboxSrc(src) }, [setLightboxSrc])

  function showToast(msg) {
    setToast({ msg, visible: true })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(t => ({ ...t, visible: false })), 2500)
  }

  async function loadContacts(s, t) {
    const params = new URLSearchParams()
    if (s) params.set('search', s)
    if (t) params.set('type', t)
    try {
      const data = await apiFetch('GET', '/api/relationships/contacts' + (params.toString() ? '?' + params.toString() : ''))
      setContacts(data)
    } catch { /* ignore */ }
  }

  async function loadInsights(filter) {
    const params = new URLSearchParams()
    if (filter) params.set('type', filter)
    try {
      const data = await apiFetch('GET', '/api/relationships/insights' + (params.toString() ? '?' + params.toString() : ''))
      setInsights(data)
    } catch { /* ignore */ }
  }

  async function loadStats() {
    try {
      const s = await apiFetch('GET', '/api/relationships/stats')
      setStats(s)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadContacts('', '')
    loadInsights('')
    loadStats()
    fetch('/api/relationships/groups').then(r => r.json()).then(data => {
      if (Array.isArray(data)) {
        const map = {}
        for (const g of data) if (g.wa_chat_id && g.name) map[g.wa_chat_id] = g.name
        setGroupsMap(map)
      }
    }).catch(() => {})
    const interval = setInterval(() => { loadStats(); loadInsights(insightFilter) }, 30000)
    return () => clearInterval(interval)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select contact from URL param ?contact=<id>
  useEffect(() => {
    if (autoSelectedRef.current || !contacts.length) return
    const id = parseInt(searchParams.get('contact'), 10)
    if (!id) return
    autoSelectedRef.current = true
    selectContact(id)
  }, [contacts]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearch() {
    clearTimeout(searchDebounce)
    setSearchDebounce(setTimeout(() => loadContacts(search, typeFilter), 300))
  }

  useEffect(() => {
    handleSearch()
  }, [search, typeFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  async function selectContact(id) {
    setSelectedContactId(id)
    setSelectedContact(null)
    setDetailTab('communications')
    setSourceFilter('')
    setContactResearch(null)
    setContactOpportunities([])
    try {
      const c = await apiFetch('GET', `/api/relationships/contacts/${id}`)
      setSelectedContact(c)
    } catch { showToast('Failed to load contact') }
  }

  async function loadContactResearch(id) {
    try {
      const data = await apiFetch('GET', `/api/relationships/contacts/${id}/research`)
      setContactResearch(data)
    } catch { /* ignore */ }
  }

  async function loadContactOpportunities(id) {
    try {
      const data = await apiFetch('GET', `/api/relationships/contacts/${id}/opportunities`)
      setContactOpportunities(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
  }

  async function handleDetailTabChange(tab) {
    setDetailTab(tab)
    if (!selectedContactId) return
    if (tab === 'research' && !contactResearch) loadContactResearch(selectedContactId)
    if (tab === 'opportunities') loadContactOpportunities(selectedContactId)
  }

  async function triggerResearchRefresh() {
    if (!selectedContactId) return
    setResearchRefreshing(true)
    try {
      await apiFetch('POST', `/api/relationships/contacts/${selectedContactId}/research`)
      showToast('Research queued — refresh in a minute')
    } catch { showToast('Failed to queue research') }
    setResearchRefreshing(false)
  }

  function openEditModal() {
    if (!selectedContact) return
    const c = selectedContact
    setEditName(c.display_name || '')
    setEditCompany(c.company || '')
    setEditTitle(c.job_title || '')
    setEditRelType(c.relationship_type || 'unknown')
    setEditStrength(c.relationship_strength || 'weak')
    setEditSummary(c.summary || '')
    setEditTags(Array.from(c.tags || []))
    setReanalyzeStatus('')
    setReanalyzeColor('var(--text-3)')
    setEditOpen(true)
  }

  async function saveContact() {
    if (!selectedContact) return
    setSavingContact(true)
    const updates = {
      display_name: editName.trim(),
      company: editCompany.trim() || null,
      job_title: editTitle.trim() || null,
      relationship_type: editRelType,
      relationship_strength: editStrength,
      summary: editSummary.trim() || null,
      tags: editTags,
    }
    try {
      const updated = await apiFetch('PATCH', `/api/relationships/contacts/${selectedContact.id}`, updates)
      setSelectedContact(prev => ({ ...prev, ...updated }))
      setContacts(prev => prev.map(c => c.id === selectedContact.id ? { ...c, ...updated } : c))
      setEditOpen(false)
      showToast('Contact saved')
    } catch (err) { showToast('Failed to save — ' + err.message) }
    setSavingContact(false)
  }

  async function toggleNoise() {
    if (!selectedContact) return
    const newNoise = !selectedContact.is_noise
    try {
      const updated = await apiFetch('PATCH', `/api/relationships/contacts/${selectedContact.id}`, { is_noise: newNoise })
      setSelectedContact(prev => ({ ...prev, ...updated }))
      showToast(newNoise ? 'Marked as noise — will be hidden from list' : 'Contact restored')
      if (newNoise) {
        setContacts(prev => prev.filter(c => c.id !== selectedContact.id))
        setSelectedContactId(null)
        setSelectedContact(null)
        setEditOpen(false)
      }
    } catch { showToast('Failed to update') }
  }

  async function reanalyzeContact() {
    if (!selectedContact) return
    setReanalyzing(true)
    setReanalyzeStatus('Asking Claude to re-analyze this contact…')
    setReanalyzeColor('var(--text-3)')
    try {
      const result = await apiFetch('POST', `/api/relationships/contacts/${selectedContact.id}/reanalyze`)
      setEditCompany(result.company || '')
      setEditTitle(result.job_title || '')
      setEditRelType(result.relationship_type || 'unknown')
      setEditStrength(result.relationship_strength || 'weak')
      setEditSummary(result.summary || '')
      if (result.tags) setEditTags(result.tags)
      setReanalyzeStatus('✓ Analysis complete — review and save')
      setReanalyzeColor('var(--green)')
      showToast('AI analysis complete')
    } catch (err) {
      setReanalyzeStatus('✗ Analysis failed: ' + err.message)
      setReanalyzeColor('var(--red)')
    }
    setReanalyzing(false)
  }

  async function actionInsight(id) {
    try {
      await apiFetch('POST', `/api/relationships/insights/${id}/action`)
      setInsights(prev => prev.filter(i => i.id !== id))
      showToast('Marked as done')
    } catch { showToast('Failed to update') }
  }

  async function dismissInsight(id) {
    try {
      await apiFetch('POST', `/api/relationships/insights/${id}/dismiss`)
      setInsights(prev => prev.filter(i => i.id !== id))
      showToast('Dismissed')
    } catch { showToast('Failed to update') }
  }

  async function runAnalysis() {
    try {
      const r = await apiFetch('GET', '/api/relationships/run')
      showToast(r.message || r.error || 'Analysis triggered')
    } catch { showToast('Failed to trigger analysis') }
  }

  function setInsightFilter(filter) {
    setInsightFilterState(filter)
    loadInsights(filter)
  }

  // Group comms by date
  function groupByDate(comms) {
    const groups = {}
    for (const c of comms) {
      const key = c.occurred_at ? fmtDate(c.occurred_at) : 'Unknown date'
      if (!groups[key]) groups[key] = []
      groups[key].push(c)
    }
    return groups
  }

  return (
    <>
      <style suppressHydrationWarning>{`
        .panel-left { background:var(--surface);display:flex;flex-direction:column;overflow:hidden;height:100%; }
        .panel-left-header { padding:.875rem 1rem .75rem;border-bottom:1px solid var(--border);flex-shrink:0; }
        .panel-left-title { font-family:'Fraunces',serif;font-weight:400;font-size:.9rem;color:var(--text);margin-bottom:.625rem; }
        .search-row { display:flex;gap:.5rem;align-items:center; }
        .search-input { flex:1;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8rem;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:.4rem .6rem;outline:none;transition:border-color .15s; }
        .search-input:focus { border-color:var(--accent-border); }
        .search-input::placeholder { color:var(--text-3); }
        .type-filter { font-family:'Plus Jakarta Sans',sans-serif;font-size:.75rem;color:var(--text-2);background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:.4rem .5rem;outline:none;cursor:pointer; }
        .contact-list { flex:1;overflow-y:auto;padding:.375rem 0; }
        .contact-list::-webkit-scrollbar { width:4px; }
        .contact-list::-webkit-scrollbar-track { background:transparent; }
        .contact-list::-webkit-scrollbar-thumb { background:var(--border);border-radius:2px; }
        .contact-row { display:flex;align-items:center;gap:.625rem;padding:.625rem 1rem;cursor:pointer;transition:background .1s;border-left:2px solid transparent; }
        .contact-row:hover { background:var(--surface-2); }
        .contact-row.active { background:var(--accent-subtle);border-left-color:var(--accent); }
        .contact-avatar { width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:600;flex-shrink:0;letter-spacing:0;color:oklch(99% .003 75); }
        .contact-row-meta { flex:1;min-width:0; }
        .contact-row-name { font-size:.8125rem;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3; }
        .contact-row-sub { font-size:.7rem;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:.1rem; }
        .contact-row-right { display:flex;flex-direction:column;align-items:flex-end;gap:.25rem;flex-shrink:0; }
        .rel-badge { font-size:.6rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:.15rem .4rem;border-radius:100px;white-space:nowrap; }
        .rel-badge.colleague { background:var(--blue-bg);color:var(--blue);border:1px solid var(--blue-border); }
        .rel-badge.friend { background:var(--green-bg);color:var(--green);border:1px solid var(--green-border); }
        .rel-badge.client { background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border); }
        .rel-badge.family { background:var(--purple-bg);color:var(--purple);border:1px solid var(--purple-border); }
        .rel-badge.vendor,.rel-badge.service_provider,.rel-badge.professional_contact { background:var(--surface-2);color:var(--text-2);border:1px solid var(--border); }
        .rel-badge.unknown { background:var(--surface-2);color:var(--text-3);border:1px solid var(--border); }
        .time-label { font-size:.65rem;color:var(--text-3); }
        .panel-main { display:flex;flex-direction:column;overflow:hidden;background:var(--bg);height:100%; }
        .profile-empty { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;color:var(--text-3); }
        .profile-empty-icon { font-size:2.5rem;opacity:.4; }
        .profile-empty-text { font-family:'Fraunces',serif;font-weight:300;font-size:1.1rem;color:var(--text-3);letter-spacing:-.02em; }
        .profile-view { flex:1;display:flex;flex-direction:column;overflow:hidden; }
        .profile-header { padding:1.25rem 1.5rem 1rem;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0; }
        .profile-name-row { display:flex;align-items:flex-start;gap:.75rem;margin-bottom:.5rem; }
        .profile-avatar { width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:600;flex-shrink:0;color:oklch(99% .003 75); }
        .profile-name-meta { flex:1;min-width:0; }
        .profile-name { font-family:'Fraunces',serif;font-weight:400;font-size:1.25rem;letter-spacing:-.02em;color:var(--text);line-height:1.2; }
        .profile-title-company { font-size:.8rem;color:var(--text-2);margin-top:.15rem; }
        .profile-header-actions { display:flex;align-items:flex-start;gap:.5rem;margin-left:auto;flex-shrink:0; }
        .profile-badges { display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-top:.5rem; }
        .strength-badge { font-size:.65rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:.15rem .4rem;border-radius:100px; }
        .strength-badge.strong { background:var(--green-bg);color:var(--green);border:1px solid var(--green-border); }
        .strength-badge.moderate { background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border); }
        .strength-badge.weak { background:var(--surface-2);color:var(--text-3);border:1px solid var(--border); }
        .strength-badge.noise { background:var(--red-bg);color:var(--red);border:1px solid var(--red-border); }
        .tag-pill { font-size:.65rem;font-weight:500;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);padding:.15rem .45rem;border-radius:100px; }
        .profile-summary { font-size:.8125rem;color:var(--text-2);line-height:1.6;margin-top:.625rem;max-width:600px; }
        .comms-area { flex:1;overflow-y:auto;padding:1rem 1.5rem; }
        .comms-area::-webkit-scrollbar { width:4px; }
        .comms-date-group { margin-bottom:1.5rem; }
        .comms-date-label { font-size:.7rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem; }
        .comms-date-label::after { content:'';flex:1;height:1px;background:var(--border); }
        .comm-item { display:flex;gap:.75rem;padding:.6rem .75rem;border-radius:7px;margin-bottom:.3rem;transition:background .1s; }
        .comm-item:hover { background:var(--surface); }
        .comm-icon { font-size:1rem;flex-shrink:0;margin-top:1px;opacity:.8; }
        .comm-body { flex:1;min-width:0; }
        .comm-meta { display:flex;align-items:center;gap:.5rem;margin-bottom:.2rem; }
        .comm-direction { font-size:.7rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase; }
        .comm-direction.inbound { color:var(--green); }
        .comm-direction.outbound { color:var(--blue); }
        .comm-direction.group { color:var(--text-3); }
        .comm-time { font-size:.7rem;color:var(--text-3);margin-left:auto; }
        .comm-snippet { font-size:.8rem;color:var(--text-2);line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .comm-subject { font-size:.75rem;font-weight:500;color:var(--text);margin-bottom:.15rem; }
        .comm-media-thumb { max-width:200px;max-height:140px;border-radius:6px;border:1px solid var(--border);display:block;margin-top:.25rem;object-fit:cover;cursor:zoom-in; }
        .comms-empty { text-align:center;padding:2rem;color:var(--text-3);font-size:.8125rem; }
        .panel-right { background:var(--surface);display:flex;flex-direction:column;overflow:hidden;height:100%; }
        .panel-right-header { padding:.875rem 1rem 0;border-bottom:1px solid var(--border);flex-shrink:0; }
        .panel-right-title { font-family:'Fraunces',serif;font-weight:400;font-size:.9rem;color:var(--text);margin-bottom:.625rem; }
        .stats-row { display:flex;gap:1rem;margin-bottom:.75rem; }
        .mini-stat { display:flex;flex-direction:column;gap:.1rem; }
        .mini-stat-val { font-family:'Fraunces',serif;font-weight:500;font-size:1.1rem;letter-spacing:-.02em;color:var(--text);line-height:1; }
        .mini-stat-label { font-size:.65rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3); }
        .insight-tabs { display:flex;gap:0;overflow-x:auto;scrollbar-width:none; }
        .insight-tabs::-webkit-scrollbar { display:none; }
        .insight-tab { font-size:.75rem;font-weight:500;color:var(--text-3);padding:.5rem .75rem;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s;background:none;border-top:none;border-left:none;border-right:none; }
        .insight-tab:hover { color:var(--text-2); }
        .insight-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
        .insights-list { flex:1;overflow-y:auto;padding:.5rem 0; }
        .insights-list::-webkit-scrollbar { width:4px; }
        .insight-card { margin:.375rem .75rem;padding:.75rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;transition:border-color .15s; }
        .insight-card:hover { border-color:var(--border-strong); }
        .insight-card-header { display:flex;align-items:flex-start;gap:.5rem;margin-bottom:.35rem; }
        .insight-type-icon { font-size:.875rem;flex-shrink:0;margin-top:1px; }
        .insight-card-meta { flex:1;min-width:0; }
        .insight-title { font-size:.8rem;font-weight:600;color:var(--text);line-height:1.3; }
        .insight-contact { font-size:.7rem;color:var(--accent);margin-top:.1rem; }
        .priority-badge { font-size:.6rem;flex-shrink:0; }
        .insight-description { font-size:.75rem;color:var(--text-2);line-height:1.5;margin-bottom:.5rem; }
        .insight-actions { display:flex;gap:.4rem; }
        .insight-btn { font-family:'Plus Jakarta Sans',sans-serif;font-size:.7rem;font-weight:500;padding:.25rem .6rem;border-radius:4px;border:1px solid var(--border);cursor:pointer;background:var(--surface);color:var(--text-2);transition:all .15s; }
        .insight-btn:hover { background:var(--surface-2);color:var(--text); }
        .insight-btn.action { background:var(--accent);color:#fff;border-color:var(--accent); }
        .insight-btn.action:hover { background:var(--accent-hover); }
        .insight-btn.dismiss:hover { background:var(--red-bg);color:var(--red);border-color:var(--red-border); }
        .insights-empty { text-align:center;padding:2.5rem 1rem;color:var(--text-3);font-size:.8rem; }
        .insights-empty-icon { font-size:2rem;margin-bottom:.5rem;opacity:.4; }
        .btn { display:inline-flex;align-items:center;gap:.4rem;font-family:'Plus Jakarta Sans',sans-serif;font-size:.8125rem;font-weight:500;padding:.4rem .9rem;border-radius:6px;border:1px solid transparent;cursor:pointer;transition:all .15s;white-space:nowrap;letter-spacing:.01em;line-height:1; }
        .btn:disabled { opacity:.45;cursor:not-allowed; }
        .btn-primary { background:var(--accent);color:oklch(99% .003 75);border-color:var(--accent); }
        .btn-primary:hover:not(:disabled) { background:var(--accent-hover);border-color:var(--accent-hover); }
        .btn-ghost { background:transparent;color:var(--text-2);border-color:var(--border); }
        .btn-ghost:hover:not(:disabled) { background:var(--surface-2);color:var(--text); }
        .btn-sm { font-size:.75rem;padding:.3rem .7rem; }
        .btn-danger { background:transparent;color:var(--red);border-color:var(--red-border); }
        .btn-danger:hover:not(:disabled) { background:var(--red-bg); }
        .modal-overlay { position:fixed;inset:0;background:oklch(17% .013 75/.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:1.5rem;opacity:0;pointer-events:none;transition:opacity .18s; }
        .modal-overlay.open { opacity:1;pointer-events:auto; }
        .modal { background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;width:100%;max-width:500px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px oklch(10% .01 75/.25);transform:translateY(8px) scale(.98);transition:transform .18s; }
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
        .lightbox { position:fixed;inset:0;background:oklch(10% .01 75/.88);z-index:300;display:flex;align-items:center;justify-content:center;cursor:zoom-out;opacity:0;pointer-events:none;transition:opacity .18s; }
        .lightbox.open { opacity:1;pointer-events:auto; }
        .lightbox img { max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 20px 60px oklch(5% 0 0/.5); }
        .header-right { display:flex;align-items:center;gap:.75rem; }
        .detail-tab-bar { display:flex;gap:0;border-bottom:1px solid var(--border);background:var(--surface);flex-shrink:0;padding:0 1.5rem; }
        .detail-tab { font-family:'Plus Jakarta Sans',sans-serif;font-size:.78rem;font-weight:500;color:var(--text-3);padding:.6rem .875rem;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s;background:none;border-top:none;border-left:none;border-right:none; }
        .detail-tab:hover { color:var(--text-2); }
        .detail-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
        .source-filter-row { display:flex;gap:.375rem;padding:.75rem 1.5rem .25rem;flex-shrink:0; }
        .source-chip { font-size:.7rem;font-weight:500;padding:.2rem .6rem;border-radius:100px;border:1px solid var(--border);background:var(--surface);color:var(--text-3);cursor:pointer;transition:all .12s; }
        .source-chip:hover { border-color:var(--border-strong);color:var(--text-2); }
        .source-chip.active { background:var(--accent-subtle);border-color:var(--accent-border);color:var(--accent); }
        .my-role-label { font-size:.75rem;color:var(--text-3);margin-top:.15rem; }
        .my-role-label span { color:var(--text-2);font-weight:500; }
        .research-area { flex:1;overflow-y:auto;padding:1.25rem 1.5rem; }
        .research-area::-webkit-scrollbar { width:4px; }
        .research-dossier { font-size:.875rem;color:var(--text-1);line-height:1.75;padding:1rem 1.125rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:1.5rem; }
        .research-dossier p { margin:0 0 .75rem; }
        .research-dossier p:last-child { margin-bottom:0; }
        .research-dossier-label { font-size:.7rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:.625rem; }
        .research-provider { padding:1rem 1.125rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:.75rem; }
        .research-provider-header { font-size:.8125rem;font-weight:600;color:var(--text-1);margin-bottom:.5rem;display:flex;align-items:center;gap:.4rem; }
        .research-provider-summary { font-size:.8375rem;color:var(--text-2);line-height:1.65;white-space:pre-wrap;word-break:break-word; }
        .research-meta { font-size:.7rem;color:var(--text-3);margin-top:.625rem;display:flex;flex-direction:column;gap:.2rem; }
        .research-meta-query { word-break:break-all; }
        .research-empty { text-align:center;padding:2.5rem 1rem;color:var(--text-3); }
        .research-empty-icon { font-size:2rem;margin-bottom:.5rem;opacity:.4; }
        .opps-area { flex:1;overflow-y:auto;padding:.75rem 1rem; }
        .opps-area::-webkit-scrollbar { width:4px; }
        .opps-empty { text-align:center;padding:2rem 1rem;color:var(--text-3);font-size:.8rem; }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0.5rem 1.5rem', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        <div className="header-right">
          {stats?.last_analysis_at && (
            <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>Last run {relTime(stats.last_analysis_at)}</span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={runAnalysis}>Run Analysis</button>
        </div>
      </div>

      <ResizablePanes storageKey="relationships" initialLeft={280} initialRight={320}>
        {/* Left panel */}
        <aside className="panel-left">
          <div className="panel-left-header">
            <div className="panel-left-title">Contacts</div>
            <div className="search-row">
              <input className="search-input" type="text" placeholder="Search…"
                value={search} onChange={e => setSearch(e.target.value)} />
              <select className="type-filter" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">All types</option>
                <option value="friend">Friend</option>
                <option value="colleague">Colleague</option>
                <option value="client">Client</option>
                <option value="family">Family</option>
                <option value="vendor">Vendor</option>
                <option value="service_provider">Service</option>
                <option value="professional_contact">Professional</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
          </div>
          <div className="contact-list">
            {contacts.length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-3)', fontSize: '.8rem' }}>No contacts found</div>
            ) : (
              contacts.map(c => {
                const initial = avatarInitial(c.display_name)
                const color = avatarColor(c.display_name)
                const sub = c.company || (c.last_interaction_at ? relTime(c.last_interaction_at) : '')
                const relType = c.relationship_type || 'unknown'
                const relLabel = relType.replace(/_/g, ' ')
                return (
                  <div key={c.id} className={`contact-row${c.id === selectedContactId ? ' active' : ''}`}
                    onClick={() => selectContact(c.id)}>
                    <div className="contact-avatar" style={{ background: color }}>
                      {c.avatar_data && isJpegB64(c.avatar_data) ? (
                        <img
                          src={`data:image/jpeg;base64,${c.avatar_data}`}
                          alt={c.display_name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
                        />
                      ) : (
                        initial
                      )}
                    </div>
                    <div className="contact-row-meta">
                      <div className="contact-row-name">{c.display_name}</div>
                      <div className="contact-row-sub">{sub}</div>
                    </div>
                    <div className="contact-row-right">
                      <span className={`rel-badge ${relType}`}>{relLabel}</span>
                      <span className="time-label">{c.last_interaction_at ? relTime(c.last_interaction_at) : ''}</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </aside>

        {/* Main panel */}
        <main className="panel-main">
          {!selectedContact ? (
            <div className="profile-empty">
              <div className="profile-empty-icon">👤</div>
              <div className="profile-empty-text">
                {selectedContactId ? 'Loading…' : 'Select a contact to view their profile'}
              </div>
            </div>
          ) : (
            <div className="profile-view">
              <div className="profile-header">
                <div className="profile-name-row">
                  <div className="profile-avatar" style={{ background: avatarColor(selectedContact.display_name) }}>
                    {selectedContact.avatar_data && isJpegB64(selectedContact.avatar_data) ? (
                      <img
                        src={`data:image/jpeg;base64,${selectedContact.avatar_data}`}
                        alt={selectedContact.display_name}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
                      />
                    ) : avatarInitial(selectedContact.display_name)}
                  </div>
                  <div className="profile-name-meta">
                    <div className="profile-name">{selectedContact.display_name}</div>
                    {(selectedContact.job_title || selectedContact.company) && (
                      <div className="profile-title-company">
                        {[selectedContact.job_title, selectedContact.company].filter(Boolean).join(' @ ')}
                      </div>
                    )}
                    {selectedContact.my_role && (
                      <div className="my-role-label">Your role: <span>{selectedContact.my_role}</span></div>
                    )}
                  </div>
                  <div className="profile-header-actions">
                    <button className="btn btn-ghost btn-sm" onClick={openEditModal}>Edit</button>
                  </div>
                </div>
                <div className="profile-badges">
                  <span className={`rel-badge ${selectedContact.relationship_type || 'unknown'}`}>
                    {(selectedContact.relationship_type || 'unknown').replace(/_/g, ' ')}
                  </span>
                  <span className={`strength-badge ${selectedContact.relationship_strength || 'weak'}`}>
                    {selectedContact.relationship_strength || 'weak'}
                  </span>
                  {(selectedContact.tags || []).map((t, i) => <span key={i} className="tag-pill">{t}</span>)}
                </div>
                {selectedContact.summary && <p className="profile-summary">{selectedContact.summary}</p>}
              </div>

              {/* Tab bar */}
              <div className="detail-tab-bar">
                {['communications', 'research', 'opportunities'].map(tab => (
                  <button key={tab}
                    className={`detail-tab${detailTab === tab ? ' active' : ''}`}
                    onClick={() => handleDetailTabChange(tab)}>
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {/* Communications tab */}
              {detailTab === 'communications' && (
                <>
                  <div className="source-filter-row">
                    {[['', 'All'], ['whatsapp', '💬 WhatsApp'], ['email', '📧 Email'], ['limitless', '🎙️ Limitless']].map(([val, label]) => (
                      <button key={val}
                        className={`source-chip${sourceFilter === val ? ' active' : ''}`}
                        onClick={() => setSourceFilter(val)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="comms-area">
                    {(() => {
                      const filtered = (selectedContact.communications || [])
                        .filter(c => !sourceFilter || c.source === sourceFilter)
                      if (!filtered.length) return <div className="comms-empty">No communications recorded yet</div>
                      return Object.entries(groupByDate(filtered)).map(([date, items]) => (
                        <div className="comms-date-group" key={date}>
                          <div className="comms-date-label">{date}</div>
                          {items.map((c, i) => {
                            const dir = c.direction || 'inbound'
                            const dirLabel = dir === 'outbound' ? '↗ Sent' : dir === 'group' ? '👥 Group' : '↙ Received'
                            return (
                              <div className="comm-item" key={i}>
                                <div className="comm-icon">{sourceIcon(c.source)}</div>
                                <div className="comm-body">
                                  <div className="comm-meta">
                                    <span className={`comm-direction ${dir}`}>{dirLabel}</span>
                                    <span className="comm-time">{fmtTime(c.occurred_at)}</span>
                                  </div>
                                  <CommContent comm={c} />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ))
                    })()}
                  </div>
                </>
              )}

              {/* Research tab */}
              {detailTab === 'research' && (
                <div className="research-area">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                    <span style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                      {contactResearch?.providers?.[0]?.researched_at
                        ? `Last researched ${relTime(contactResearch.providers[0].researched_at)}`
                        : 'Not yet researched'}
                    </span>
                    <button className="btn btn-ghost btn-sm"
                      onClick={triggerResearchRefresh}
                      disabled={researchRefreshing}>
                      {researchRefreshing ? 'Queuing…' : 'Refresh'}
                    </button>
                  </div>

                  {!contactResearch ? (
                    <div className="research-empty">
                      <div className="research-empty-icon">🔍</div>
                      Loading…
                    </div>
                  ) : !contactResearch.research_summary && (!contactResearch.providers || contactResearch.providers.length === 0) ? (
                    <div className="research-empty">
                      <div className="research-empty-icon">🔍</div>
                      <div>No research yet</div>
                      <button className="btn btn-primary btn-sm" style={{ marginTop: '.75rem' }}
                        onClick={triggerResearchRefresh}>
                        Research this contact
                      </button>
                    </div>
                  ) : (
                    <>
                      {contactResearch.research_summary && (
                        <div className="research-dossier">
                          <div className="research-dossier-label">Dossier</div>
                          {contactResearch.research_summary.split(/\n\n+/).map((para, i) => (
                            <p key={i}>{para.replace(/\n/g, ' ')}</p>
                          ))}
                        </div>
                      )}
                      {(contactResearch.providers || []).map(p => (
                        <div className="research-provider" key={p.source}>
                          <div className="research-provider-header">
                            <span>{{ tavily: '🌐', openai: '🤖', peopledatalabs: '👤', serpapi: '🔎' }[p.source] || '📌'}</span>
                            <span>{p.source}</span>
                          </div>
                          <div className="research-provider-summary">{p.summary}</div>
                          <div className="research-meta">
                            <span className="research-meta-query">Query: {p.query}</span>
                            {p.researched_at && <span>{fmtDate(p.researched_at)}</span>}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}

              {/* Opportunities tab */}
              {detailTab === 'opportunities' && (
                <div className="opps-area">
                  {contactOpportunities.length === 0 ? (
                    <div className="opps-empty">
                      <div style={{ fontSize: '2rem', opacity: .4, marginBottom: '.5rem' }}>✨</div>
                      No opportunities yet
                    </div>
                  ) : (
                    contactOpportunities.map(ins => (
                      <div className="insight-card" key={ins.id}>
                        <div className="insight-card-header">
                          <div className="insight-type-icon">{insightIcon(ins.insight_type)}</div>
                          <div className="insight-card-meta">
                            <div className="insight-title">{ins.title}</div>
                          </div>
                          <span className="priority-badge" title={`${ins.priority} priority`}>{priorityIcon(ins.priority)}</span>
                        </div>
                        {ins.description && <div className="insight-description">{ins.description}</div>}
                        <div className="insight-actions">
                          <button className="insight-btn action" onClick={() => actionInsight(ins.id)}>Done</button>
                          <button className="insight-btn dismiss" onClick={() => dismissInsight(ins.id)}>Dismiss</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </main>

        {/* Right panel */}
        <aside className="panel-right">
          <div className="panel-right-header">
            <div className="panel-right-title">Opportunities</div>
            <div className="stats-row">
              <div className="mini-stat">
                <span className="mini-stat-val">{stats?.total_contacts ?? '—'}</span>
                <span className="mini-stat-label">Contacts</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val">{stats?.pending_insights ?? '—'}</span>
                <span className="mini-stat-label">Pending</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val">{stats?.strong_contacts ?? '—'}</span>
                <span className="mini-stat-label">Strong</span>
              </div>
            </div>
            <div className="insight-tabs">
              {[
                { filter: '', label: 'All' },
                { filter: 'awaiting_reply', label: 'Awaiting Reply' },
                { filter: 'unread_group', label: 'Active Groups' },
                { filter: 'cold_email', label: 'Cold Emails' },
                { filter: 'opportunity,cross_source_opportunity,project_match', label: 'Opportunities' },
              ].map(({ filter, label }) => (
                <button key={filter} className={`insight-tab${insightFilter === filter ? ' active' : ''}`}
                  onClick={() => setInsightFilter(filter)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="insights-list">
            {insights.length === 0 ? (
              <div className="insights-empty">
                <div className="insights-empty-icon">✨</div>
                No pending opportunities
              </div>
            ) : (
              insights.map(ins => (
                <div className="insight-card" key={ins.id}>
                  <div className="insight-card-header">
                    <div className="insight-type-icon">{insightIcon(ins.insight_type)}</div>
                    <div className="insight-card-meta">
                      <div className="insight-title">{resolveGroupIds(ins.title, groupsMap)}</div>
                      {ins.contact_name && <div className="insight-contact">{ins.contact_name}</div>}
                    </div>
                    <span className="priority-badge" title={`${ins.priority} priority`}>{priorityIcon(ins.priority)}</span>
                  </div>
                  {ins.description && <div className="insight-description">{resolveGroupIds(ins.description, groupsMap)}</div>}
                  <div className="insight-actions">
                    <button className="insight-btn action" onClick={() => actionInsight(ins.id)}>Done</button>
                    <button className="insight-btn dismiss" onClick={() => dismissInsight(ins.id)}>Dismiss</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </ResizablePanes>

      {/* Lightbox */}
      {lightboxSrc && (
        <div className="lightbox open" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="" onClick={e => e.stopPropagation()} />
        </div>
      )}

      {/* Edit modal */}
      <div className={`modal-overlay${editOpen ? ' open' : ''}`} onClick={e => { if (e.target === e.currentTarget) setEditOpen(false) }}>
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-header">
            <div className="modal-title">Edit — {selectedContact?.display_name}</div>
            <button className="modal-close" onClick={() => setEditOpen(false)}>✕</button>
          </div>
          <div className="modal-body">
            <div className="field-row">
              <div className="field-group">
                <label className="field-label" htmlFor="edit-name-rel">Display name</label>
                <input className="form-input" id="edit-name-rel" type="text" placeholder="Full name"
                  value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="edit-company-rel">Company</label>
                <input className="form-input" id="edit-company-rel" type="text" placeholder="Company name"
                  value={editCompany} onChange={e => setEditCompany(e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field-group">
                <label className="field-label" htmlFor="edit-title-rel">Job title</label>
                <input className="form-input" id="edit-title-rel" type="text" placeholder="Role / title"
                  value={editTitle} onChange={e => setEditTitle(e.target.value)} />
              </div>
              <div className="field-group">
                <label className="field-label" htmlFor="edit-rel-type-rel">Relationship type</label>
                <select className="form-select" id="edit-rel-type-rel" value={editRelType} onChange={e => setEditRelType(e.target.value)}>
                  <option value="family">Family</option>
                  <option value="friend">Friend</option>
                  <option value="colleague">Colleague</option>
                  <option value="client">Client</option>
                  <option value="vendor">Vendor</option>
                  <option value="service_provider">Service provider</option>
                  <option value="professional_contact">Professional contact</option>
                  <option value="unknown">Unknown</option>
                </select>
              </div>
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-strength-rel">Relationship strength</label>
              <select className="form-select" id="edit-strength-rel" value={editStrength} onChange={e => setEditStrength(e.target.value)}>
                <option value="strong">Strong — frequent meaningful contact</option>
                <option value="moderate">Moderate — occasional contact</option>
                <option value="weak">Weak — rare / transactional</option>
                <option value="noise">Noise — bot / irrelevant</option>
              </select>
            </div>
            <div className="field-group">
              <label className="field-label">Tags</label>
              <TagEditor tags={editTags} onChange={setEditTags} />
            </div>
            <div className="field-group">
              <label className="field-label" htmlFor="edit-summary-rel">Summary &amp; notes</label>
              <textarea className="form-textarea" id="edit-summary-rel" rows={4}
                placeholder="Who is this person? Key context, how you met, what to remember…"
                style={{ minHeight: '100px' }}
                value={editSummary} onChange={e => setEditSummary(e.target.value)} />
            </div>
            <div>
              <button className="btn btn-ghost btn-sm" disabled={reanalyzing} onClick={reanalyzeContact}>
                {reanalyzing ? '⟳ Analyzing…' : '✦ Re-analyze with AI'}
              </button>
              {reanalyzeStatus && (
                <div style={{ fontSize: '.72rem', color: reanalyzeColor, marginTop: '.3rem' }}>{reanalyzeStatus}</div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <div className="modal-footer-left">
              <button className="btn btn-ghost btn-sm btn-danger" onClick={toggleNoise}>
                {selectedContact?.is_noise ? 'Restore contact' : 'Mark as noise'}
              </button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditOpen(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={savingContact} onClick={saveContact}>
              {savingContact ? 'Saving…' : 'Save changes'}
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
