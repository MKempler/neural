// The ⌘K palette and the New session sheet.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { html, api, shortPath, ago, local, unmark } from '../lib.js'
import { Icon } from '../icons.js'
import { Dot, useAutosize } from './parts.js'
import { Highlight } from '../views/Lists.js'
import {
  lightbox, paletteOpen, newSessionOpen, sessionList, sessions, route, navigate, sessionPath, sessionAction, createSession, send,
} from '../store.js'

function Overlay({ onClose, children, label }) {
  useEffect(() => {
    const esc = e => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [])
  return html`<div class="overlay" role="dialog" aria-modal="true" aria-label=${label} onPointerDown=${e => e.target === e.currentTarget && onClose()}>
    ${children}
  </div>`
}

// ---------------------------------------------------------------------------------------------
// Full-size photo viewer: arrows or swipe between a message's photos, Esc or a tap outside to close.

export function Lightbox() {
  const lb = lightbox.value
  const touch = useRef(null)
  useEffect(() => {
    if (!lb) return
    const onKey = e => {
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lb])
  if (!lb) return null
  const close = () => (lightbox.value = null)
  const step = d => {
    const cur = lightbox.value
    if (cur) lightbox.value = { ...cur, index: (cur.index + d + cur.items.length) % cur.items.length }
  }
  const a = lb.items[lb.index]
  const many = lb.items.length > 1
  return html`<${Overlay} onClose=${close} label="Photo">
    <div class="lightbox" onPointerDown=${e => e.target === e.currentTarget && close()}
        onTouchStart=${e => (touch.current = e.touches[0].clientX)}
        onTouchEnd=${e => { const dx = e.changedTouches[0].clientX - (touch.current ?? 0); if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1) }}>
      <img src=${a.view ?? a.url} alt=${a.name} />
      <div class="lightbox-bar">
        <span class="truncate">${a.name}${a.width ? ` · ${a.width}×${a.height}` : ''}${many ? ` · ${lb.index + 1} of ${lb.items.length}` : ''}</span>
        ${many && html`<button class="btn sm" aria-label="Previous" onClick=${() => step(-1)}><${Icon} name="back" /></button>
          <button class="btn sm" aria-label="Next" onClick=${() => step(1)}><${Icon} name="next" /></button>`}
        <a class="btn sm" href=${`${a.url}/download`}><${Icon} name="download" />Original</a>
        <button class="btn sm" aria-label="Close" onClick=${close}><${Icon} name="x" /></button>
      </div>
    </div>
  </${Overlay}>`
}

// ---------------------------------------------------------------------------------------------

export function Palette() {
  if (!paletteOpen.value) return null
  return html`<${PaletteBody} />`
}

function PaletteBody() {
  const close = () => (paletteOpen.value = false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [hits, setHits] = useState([])
  const input = useRef(null)
  useEffect(() => input.current?.focus(), [])

  // Search history as you type, once the query is long enough to mean something.
  useEffect(() => {
    if (q.trim().length < 3) return setHits([])
    const t = setTimeout(async () => {
      try {
        setHits(await api('GET', `/api/search?limit=6&q=${encodeURIComponent(q)}`))
      } catch {
        setHits([])
      }
    }, 220)
    return () => clearTimeout(t)
  }, [q])

  const r = route.value
  const current = r.view === 'session' ? sessions.value[r.name] : null
  const needle = q.trim().toLowerCase()
  const items = useMemo(() => {
    const out = []
    for (const s of sessionList.value) {
      if (!needle || s.name.includes(needle) || s.cwd.toLowerCase().includes(needle)) {
        out.push({ group: 'Sessions', key: `s${s.name}`, icon: html`<${Dot} status=${s.status} />`, text: s.name, sub: shortPath(s.cwd, 60),
          run: () => navigate(sessionPath(s.name)) })
      }
    }
    const actions = [
      { text: 'New session', icon: 'plus', run: () => (newSessionOpen.value = true) },
      { text: 'Home', icon: 'home', run: () => navigate('/') },
      { text: 'Timeline', icon: 'timeline', run: () => navigate('/timeline') },
      current && { text: `Open ${current.name}'s terminal`, icon: 'terminal', run: () => navigate(sessionPath(current.name, 'terminal')) },
      current && { text: `Restart ${current.name}`, icon: 'restart', run: () => sessionAction(current.name, 'restart').catch(e => alert(e.message)) },
    ].filter(Boolean)
    for (const a of actions) {
      if (!needle || a.text.toLowerCase().includes(needle)) out.push({ group: 'Actions', key: `a${a.text}`, icon: html`<${Icon} name=${a.icon} />`, ...a })
    }
    for (const h of hits) {
      out.push({ group: 'History', key: `h${h.kind}${h.id}`, icon: html`<${Icon} name="history" />`,
        text: html`<${Highlight} text=${unmark(h.snippet)} />`,
        sub: `${h.session ?? ''} · ${ago(h.ts)}${h.match === 'meaning' ? ' · matched by meaning' : ''}`,
        run: () => (h.kind === 'message' && sessions.value[h.session] ? navigate(sessionPath(h.session)) : navigate(`/search?q=${encodeURIComponent(q)}`)) })
    }
    if (needle) out.push({ group: 'History', key: 'all', icon: html`<${Icon} name="search" />`, text: `Search all history for “${q.trim()}”`,
      run: () => navigate(`/search?q=${encodeURIComponent(q.trim())}`) })
    return out
  }, [needle, hits, sessionList.value, current?.name])

  useEffect(() => setSel(0), [needle])
  const choose = it => {
    close()
    it.run()
  }
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => Math.min(i + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); choose(items[sel]) }
  }

  let lastGroup = ''
  return html`<${Overlay} onClose=${close} label="Command palette">
    <div class="sheet palette">
      <div class="search-row"><${Icon} name="search" />
        <input ref=${input} value=${q} onInput=${e => setQ(e.currentTarget.value)} onKeyDown=${onKey}
          placeholder="Jump to a session, run an action, or search history" aria-label="Search" autocomplete="off" spellcheck="false" />
      </div>
      <div class="list" role="listbox">
        ${items.length === 0 && html`<div class="empty">Nothing matches.</div>`}
        ${items.map((it, i) => {
          const head = it.group !== lastGroup ? html`<div class="group label">${it.group}</div>` : null
          lastGroup = it.group
          return html`${head}<button key=${it.key} role="option" aria-selected=${i === sel} class=${`item ${i === sel ? 'sel' : ''}`}
              onMouseMove=${() => setSel(i)} onClick=${() => choose(it)}>
            ${it.icon}<span class="main"><span class="txt">${it.text}</span>${it.sub && html`<span class="sub">${it.sub}</span>`}</span>
          </button>`
        })}
      </div>
      <div class="foot"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></div>
    </div>
  </${Overlay}>`
}

// ---------------------------------------------------------------------------------------------

export function NewSession() {
  if (!newSessionOpen.value) return null
  return html`<${NewSessionBody} />`
}

function NewSessionBody() {
  const close = () => (newSessionOpen.value = false)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(local.get('neural.lastCwd', ''))
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const first = useRef(null)
  const promptRef = useAutosize(prompt)
  useEffect(() => first.current?.focus(), [])

  // Suggest folders already in use, and their parents.
  const dirs = useMemo(() => {
    const set = new Set()
    for (const s of sessionList.value) {
      if (s.role === 'orchestrator') continue
      set.add(s.cwd)
      set.add(s.cwd.replace(/\/[^/]+$/, ''))
    }
    return [...set].filter(Boolean).sort()
  }, [])

  const submit = async e => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const s = await createSession({ name: name.trim(), cwd: cwd.trim(), prompt: prompt.trim() || undefined })
      close()
      navigate(sessionPath(s.name))
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`<${Overlay} onClose=${close} label="New session">
    <form class="sheet" onSubmit=${submit}>
      <div class="sheet-head"><h2>New session</h2>
        <button type="button" class="btn ghost icon-only" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
      <div class="sheet-body">
        <label class="field"><span>Name</span>
          <input ref=${first} class="input mono" value=${name} required pattern="[a-z0-9][a-z0-9_\\-]{0,31}" placeholder="api"
            autocapitalize="off" autocomplete="off" spellcheck="false" onInput=${e => setName(e.currentTarget.value.toLowerCase())} />
          <span class="hint">Lowercase letters, digits, - and _. Other sessions use this name to reach it.</span>
        </label>
        <label class="field"><span>Folder</span>
          <input class="input mono" value=${cwd} required list="neural-dirs" placeholder="/Users/you/Projects/api"
            autocapitalize="off" autocomplete="off" spellcheck="false" onInput=${e => setCwd(e.currentTarget.value)} />
          <datalist id="neural-dirs">${dirs.map(d => html`<option value=${d} />`)}</datalist>
        </label>
        <label class="field"><span>First message (optional)</span>
          <textarea ref=${promptRef} class="input" rows="3" value=${prompt} onInput=${e => setPrompt(e.currentTarget.value)}
            placeholder="What should it work on?"></textarea>
        </label>
        ${error && html`<div class="error">${error}</div>`}
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn ghost" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${busy}>${busy ? 'Starting…' : 'Start session'}</button>
      </div>
    </form>
  </${Overlay}>`
}
