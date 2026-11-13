// The ⌘K palette and the New session sheet.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { html, api, shortPath, ago, local, unmark, excerpt, modelLabel } from '../lib.js'
import { Icon } from '../icons.js'
import { Dot, useAutosize } from './parts.js'
import { Highlight } from '../views/Lists.js'
import {
  switcherOpen, totalUnread, lightbox, paletteOpen, modelSheet, sendNow, newSessionOpen, sessionList, sessions, route, navigate, sessionPath, sessionAction, createSession, send,
} from '../store.js'

export function Overlay({ onClose, children, label }) {
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
// Session switcher: tap a session's name on the phone to jump to another without going back to Home.

export function SessionSwitcher() {
  if (!switcherOpen.value) return null
  const close = () => (switcherOpen.value = false)
  const current = route.value.view === 'session' ? route.value.name : null
  const go = name => {
    close()
    navigate(sessionPath(name), { replace: route.value.view === 'session' })
  }
  return html`<${Overlay} onClose=${close} label="Switch session">
    <div class="sheet switcher">
      <div class="sheet-head"><h2>Sessions</h2>
        <button class="btn ghost icon-only" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
      <div class="list">
        ${sessionList.value.map(s => html`<button class=${`item ${s.name === current ? 'sel' : ''}`} key=${s.name} onClick=${() => go(s.name)}>
          <${Dot} status=${s.status} />
          <span class="main"><span class="txt mono">${s.name}</span>
            <span class="sub">${s.status === 'blocked' ? 'Needs your approval' : s.status === 'working' && s.activity ? s.activity.text : s.last_message ? excerpt(s.last_message) : shortPath(s.cwd, 40)}</span></span>
          ${s.unread > 0 && html`<span class="badge">${s.unread}</span>`}
        </button>`)}
      </div>
      <div class="sheet-foot">
        <button class="btn ghost" onClick=${() => { close(); navigate('/') }}><${Icon} name="home" />Home</button>
        <button class="btn" onClick=${() => { close(); newSessionOpen.value = true }}><${Icon} name="plus" />New session</button>
      </div>
    </div>
  </${Overlay}>`
}

// ---------------------------------------------------------------------------------------------
// Model and effort: shows what a session is using; changes run as slash commands in its terminal.

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function ModelSheet() {
  const name = modelSheet.value
  if (!name) return null
  const s = sessions.value[name]
  if (!s) return null
  const close = () => (modelSheet.value = null)
  const run = command => {
    sendNow(name, command)
    close()
  }
  return html`<${Overlay} onClose=${close} label="Model and effort">
    <div class="sheet model-sheet">
      <div class="sheet-head"><h2>Model and effort · <span class="mono">${name}</span></h2>
        <button class="btn ghost icon-only" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
      <div class="sheet-body">
        <div class="kv"><span class="label">Model</span><span class="mono">${s.model ? `${modelLabel(s.model)} (${s.model})` : 'not reported yet'}</span></div>
        <div class="field"><span>Effort</span>
          <div class="chips">${EFFORTS.map(e => html`<button class=${`chip ${s.effort === e ? 'on' : ''}`} onClick=${() => run(`/effort ${e}`)}>${e}</button>`)}</div>
        </div>
        <button class="btn" onClick=${() => { run('/model'); navigate(sessionPath(name, 'terminal'), { replace: true }) }}>
          <${Icon} name="terminal" />Choose a model in the terminal</button>
        <p class="hint">These run as <span class="mono">/effort</span> and <span class="mono">/model</span> in ${name}'s terminal. You can also type
          any slash command, like <span class="mono">/model sonnet</span> or <span class="mono">/compact</span>, straight into the message box.
          The display updates after the session's next reply.</p>
      </div>
    </div>
  </${Overlay}>`
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

const MODES = [['folder', 'Folder'], ['new', 'New project'], ['github', 'From GitHub']]
/** A session name from a folder name: "My.Project" → "my-project" (mirrors the server). */
const nameFrom = folder => folder.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 32)

function NewSessionBody() {
  const close = () => (newSessionOpen.value = false)
  const [mode, setMode] = useState(local.get('neural.newMode', 'folder'))
  const [name, setName] = useState('')
  const [named, setNamed] = useState(false) // typed by hand, so choosing a folder doesn't overwrite it
  const [cwd, setCwd] = useState('')
  const [repo, setRepo] = useState(null)
  const [github, setGithub] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [projects, setProjects] = useState(null)
  const [repos, setRepos] = useState(null)
  const [filter, setFilter] = useState('')
  const promptRef = useAutosize(prompt)

  useEffect(() => {
    api('GET', '/api/projects').then(setProjects, e => setProjects({ root: '', folders: [], github: false, error: e.message }))
  }, [])
  useEffect(() => {
    local.set('neural.newMode', mode)
    setError('')
    if (mode === 'github' && !repos) api('GET', '/api/projects/github').then(r => setRepos(r.repos), e => setRepos({ error: e.message }))
  }, [mode])

  const suggest = n => !named && setName(nameFrom(n))
  const pickFolder = f => {
    setCwd(f.path)
    suggest(f.name)
  }
  const pickRepo = r => {
    setRepo(r)
    suggest(r.name)
  }

  // Folders other sessions use outside the projects folder, for typing a path by hand.
  const dirs = useMemo(() => {
    const set = new Set()
    for (const s of sessionList.value) if (s.role !== 'orchestrator') set.add(s.cwd)
    return [...set].sort()
  }, [])

  const ready = name.trim() && (mode === 'folder' ? cwd.trim() : mode === 'github' ? repo : true)
  const submit = async e => {
    e.preventDefault()
    if (!ready || busy) return
    setError('')
    try {
      let dir = cwd.trim()
      if (mode === 'new') {
        setBusy(github ? 'Creating the project and its GitHub repository…' : 'Creating the project…')
        dir = (await api('POST', '/api/projects', { name: name.trim(), github })).path
      } else if (mode === 'github') {
        setBusy(`Cloning ${repo.nameWithOwner}…`)
        dir = (await api('POST', '/api/projects/clone', { repo: repo.nameWithOwner })).path
      }
      setBusy('Starting…')
      const s = await createSession({ name: name.trim(), cwd: dir, prompt: prompt.trim() || undefined })
      close()
      navigate(sessionPath(s.name))
    } catch (err) {
      setError(err.message)
      setBusy('')
    }
  }

  const root = projects?.root ? shortPath(projects.root) : '~/Projects'
  const q = filter.trim().toLowerCase()
  const shownRepos = Array.isArray(repos) ? repos.filter(r => !q || r.nameWithOwner.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)) : []

  return html`<${Overlay} onClose=${close} label="New session">
    <form class="sheet new-session" onSubmit=${submit}>
      <div class="sheet-head"><h2>New session</h2>
        <button type="button" class="btn ghost icon-only" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
      <div class="sheet-body">
        <div class="seg" role="tablist">
          ${MODES.map(([id, label]) => html`<button type="button" role="tab" aria-selected=${mode === id} class=${`seg-btn ${mode === id ? 'on' : ''}`}
            onClick=${() => setMode(id)}>${label}</button>`)}
        </div>

        ${mode === 'folder' && html`<div class="field"><span>Work in</span>
          ${projects === null ? html`<div class="quiet">Loading…</div>` : html`<div class="pick-list" role="listbox" aria-label="Project folders">
            ${projects.folders.map(f => html`<button type="button" role="option" key=${f.path} aria-selected=${cwd === f.path}
              class=${`pick ${cwd === f.path ? 'on' : ''}`} onClick=${() => pickFolder(f)}>
              <span class="pick-name mono">${f.name}</span>
              <span class="pick-meta">${f.git ? html`<${Icon} name="branch" size=${12} />${f.branch ?? 'git'}` : 'no git'}${f.sessions.length ? ` · ${f.sessions.join(', ')}` : ''} · ${ago(f.modified)}</span>
            </button>`)}
            ${!projects.folders.length && html`<div class="quiet">No folders in ${root} yet. Start a new project, or type a folder below.</div>`}
          </div>`}
          <input class="input mono" value=${cwd} list="neural-dirs" placeholder="or type a folder: /Users/you/code/api" aria-label="Folder"
            autocapitalize="off" autocomplete="off" spellcheck="false" onInput=${e => setCwd(e.currentTarget.value)} />
          <datalist id="neural-dirs">${dirs.map(d => html`<option value=${d} />`)}</datalist>
        </div>`}

        ${mode === 'new' && html`<p class="hint">Creates <span class="mono">${root}/${name.trim() || 'name'}</span> with git, and starts a session there.</p>
          ${projects?.github
            ? html`<label class="check"><input type="checkbox" checked=${github} onChange=${e => setGithub(e.currentTarget.checked)} />
                Also create a private GitHub repository</label>`
            : projects && html`<p class="hint">Sign in to the GitHub CLI on the Mac (<span class="mono">gh auth login</span>) to create a GitHub repository too.</p>`}`}

        ${mode === 'github' && html`<div class="field"><span>Repository</span>
          ${repos === null ? html`<div class="quiet">Loading your repositories…</div>`
            : repos.error ? html`<div class="error">${repos.error}</div>`
            : html`<input class="input" placeholder="Filter" value=${filter} onInput=${e => setFilter(e.currentTarget.value)} autocapitalize="off" spellcheck="false" />
              <div class="pick-list" role="listbox" aria-label="GitHub repositories">
                ${shownRepos.map(r => html`<button type="button" role="option" key=${r.nameWithOwner} disabled=${r.cloned}
                  aria-selected=${repo?.nameWithOwner === r.nameWithOwner} class=${`pick ${repo?.nameWithOwner === r.nameWithOwner ? 'on' : ''}`} onClick=${() => pickRepo(r)}>
                  <span class="pick-name mono">${r.nameWithOwner}</span>
                  <span class="pick-meta">${r.cloned ? `already in ${root}` : [r.isPrivate ? 'private' : 'public', ago(r.updatedAt), r.description].filter(Boolean).join(' · ')}</span>
                </button>`)}
                ${!shownRepos.length && html`<div class="quiet">No repositories match.</div>`}
              </div>
              <p class="hint">Clones into <span class="mono">${root}</span>. Already cloned? Pick it under Folder.</p>`}
        </div>`}

        <label class="field"><span>Session name</span>
          <input class="input mono" value=${name} required pattern="[a-z0-9][a-z0-9_\\-]{0,31}" placeholder="api"
            autocapitalize="off" autocomplete="off" spellcheck="false" onInput=${e => { setName(e.currentTarget.value.toLowerCase()); setNamed(Boolean(e.currentTarget.value)) }} />
          <span class="hint">${mode === 'new' ? 'Also the folder name. ' : ''}Lowercase letters, digits, - and _. Other sessions use this name to reach it.</span>
        </label>
        <label class="field"><span>First message (optional)</span>
          <textarea ref=${promptRef} class="input" rows="2" value=${prompt} onInput=${e => setPrompt(e.currentTarget.value)}
            placeholder="What should it work on?"></textarea>
        </label>
        ${error && html`<div class="error">${error}</div>`}
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn ghost" onClick=${close}>Cancel</button>
        <button class="btn primary" disabled=${!ready || Boolean(busy)}>${busy || (mode === 'new' ? 'Create and start' : mode === 'github' ? 'Clone and start' : 'Start session')}</button>
      </div>
    </form>
  </${Overlay}>`
}
