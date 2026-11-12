// Timeline (every message) and Search (keyword and meaning).
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, api, ago, unmark } from '../lib.js'
import { Icon } from '../icons.js'
import { Message } from '../components/parts.js'
import { recent, sessions, sessionList, route, navigate, sessionPath } from '../store.js'

export function Timeline() {
  const filter = route.value.session
  const [older, setOlder] = useState([])
  const [more, setMore] = useState(true)
  const all = [...older, ...recent.value]
  const rows = filter ? all.filter(m => m.from_name === filter || m.to_name === filter) : all
  const shown = rows.slice(-300)
  const loadOlder = async () => {
    const first = all[0]
    if (!first) return
    const page = await api('GET', `/api/messages?limit=200&before=${first.id}`)
    if (page.length < 200) setMore(false)
    setOlder([...page, ...older])
  }
  const chip = (value, label) => html`<button class=${`chip ${filter === value ? 'on' : ''}`}
    onClick=${() => navigate(value ? `/timeline?session=${encodeURIComponent(value)}` : '/timeline', { replace: true })}>${label}</button>`

  return html`<div class="scroll"><div class="page narrow">
    <div class="page-head"><h1>Timeline</h1><span class="label">${rows.length} messages</span></div>
    <div class="chips">${chip('', 'all')}${sessionList.value.map(s => chip(s.name, s.name))}</div>
    ${more && all.length >= 200 && html`<button class="btn ghost sm load-more" onClick=${loadOlder}>Load earlier messages</button>`}
    ${shown.length === 0 ? html`<div class="empty">No messages yet.</div>`
      : html`<div class="thread-inner" style="padding: 0">${shown.map(m => html`<${Message} m=${m} key=${m.id} />`)}</div>`}
  </div></div>`
}

const MATCH = { keyword: 'keyword', meaning: 'meaning', both: 'keyword + meaning' }

export function Search() {
  const [q, setQ] = useState(route.value.q)
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const input = useRef(null)
  useEffect(() => {
    input.current?.focus()
    if (route.value.q) run(route.value.q)
  }, [])
  async function run(query) {
    if (!query.trim()) return setResults(null)
    setBusy(true)
    try {
      setResults(await api('GET', `/api/search?limit=50&q=${encodeURIComponent(query)}`))
    } finally {
      setBusy(false)
    }
  }
  const submit = e => {
    e.preventDefault()
    navigate(`/search?q=${encodeURIComponent(q)}`, { replace: true })
    run(q)
  }
  return html`<div class="scroll"><div class="page narrow">
    <div class="page-head"><h1>Search</h1><span class="label">every message and transcript</span></div>
    <form class="searchbar" onSubmit=${submit}>
      <input ref=${input} class="input" type="search" value=${q} onInput=${e => setQ(e.currentTarget.value)}
        placeholder="A word, a phrase, or a question" autocomplete="off" />
      <button class="btn primary" disabled=${busy}><${Icon} name="search" />Search</button>
    </form>
    ${results === null ? html`<div class="empty">Search by keyword or describe what you remember. Results that match by meaning are marked.</div>`
      : results.length === 0 ? html`<div class="empty">Nothing found.</div>`
      : html`<div class="results">${results.map(r => html`<${Result} r=${r} key=${`${r.kind}${r.id}`} />`)}</div>`}
  </div></div>`
}

export function Highlight({ text }) {
  // Keyword snippets mark matches with [brackets]; meaning matches have none.
  const parts = text.split(/(\[[^\]]+\])/g)
  return parts.map(p => (p.startsWith('[') && p.endsWith(']') ? html`<mark>${p.slice(1, -1)}</mark>` : p))
}

function Result({ r }) {
  const open = r.kind === 'message' && sessions.value[r.session] ? () => navigate(sessionPath(r.session)) : null
  const Tag = open ? 'button' : 'div'
  return html`<${Tag} class="result" onClick=${open}>
    <div class="where">
      <span class="who">${r.session ?? ''}</span>
      <span>${r.kind === 'message' ? r.who.replace(' -> ', ' → ').replace(/\buser\b/g, 'you') : `transcript · ${r.who}`}</span>
      ${r.ts && html`<span title=${new Date(r.ts).toLocaleString()}>${ago(r.ts)}</span>`}
      ${r.match && html`<span class=${`tag ${r.match !== 'keyword' ? 'accent' : ''}`}>${MATCH[r.match]}</span>`}
    </div>
    <div class="snippet"><${Highlight} text=${unmark(r.snippet)} /></div>
  </${Tag}>`
}
