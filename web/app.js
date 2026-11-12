const $ = id => document.getElementById(id)
const ALL = '*'

const state = {
  sessions: new Map(),
  permissions: new Map(),
  unread: new Map(),
  current: null, // session name, or ALL for the combined timeline
  view: 'thread', // thread | search
  messages: [],
  terminalOpen: false,
  liveTerminal: false,
}

// ---------------------------------------------------------------------------------------------
// API

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// A small, safe subset of Markdown: fenced code, inline code, bold and bare links. Everything is escaped first.
function markdown(text) {
  return text.split(/(```[\s\S]*?(?:```|$))/g).map(part => {
    if (part.startsWith('```')) {
      const code = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')
      return `<pre><code>${esc(code)}</code></pre>`
    }
    return esc(part)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
  }).join('')
}

const STATUS_TEXT = {
  starting: 'Starting', idle: 'Idle', working: 'Working', blocked: 'Waiting for approval',
  attention: 'Needs attention', exited: 'Exited', stopped: 'Stopped',
}
const DELIVERY_TEXT = { pending: 'Queued', pushed: 'Sent', acked: 'Delivered', failed: 'Not delivered' }

function time(ts) {
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

// ---------------------------------------------------------------------------------------------
// Sidebar

function renderSidebar() {
  const nav = $('sessions')
  nav.replaceChildren()
  const row = (key, name, sub, dotClass) => {
    const unread = state.unread.get(key) ?? 0
    const b = el('button', { className: 'session' + (state.current === key && state.view === 'thread' ? ' active' : '') },
      el('span', { className: `dot ${dotClass}` }),
      el('span', { className: 'name', textContent: name }),
      unread ? el('span', { className: 'badge', textContent: String(unread) }) : el('span'),
      el('span', { className: 'sub', textContent: sub }),
    )
    b.onclick = () => select(key)
    nav.append(b)
  }
  for (const s of state.sessions.values()) {
    const role = s.role === 'orchestrator' ? 'Orchestrator · ' : ''
    row(s.name, s.name, `${role}${STATUS_TEXT[s.status] ?? s.status} · ${s.cwd}`, s.status)
  }
  row(ALL, 'All messages', 'Everything, across sessions', 'stopped')
  const total = [...state.unread.values()].reduce((a, b) => a + b, 0)
  $('menu-badge').hidden = !total
  $('menu-badge').textContent = String(total)
  document.title = total ? `(${total}) Claude Hub` : 'Claude Hub'
}

// ---------------------------------------------------------------------------------------------
// Header, notice and permission cards

function renderHeader() {
  const s = state.sessions.get(state.current)
  const searching = state.view === 'search'
  $('title-name').textContent = searching ? 'Search history' : state.current === ALL ? 'All messages' : s?.name ?? 'Claude Hub'
  $('title-status').textContent = searching || !s ? '' : `${STATUS_TEXT[s.status] ?? s.status}${s.channel_connected ? '' : ' · channel not connected'} · ${s.cwd}`
  $('actions').hidden = searching || !s
  $('composer').hidden = searching || !s
  $('thread').hidden = searching
  $('search').hidden = !searching
  if (s) {
    const down = ['stopped', 'exited'].includes(s.status)
    $('restart-btn').textContent = down ? 'Start' : 'Restart'
    $('stop-btn').hidden = down
    $('input').placeholder = `Message ${s.name}`
  }
  const notice = $('notice')
  const show = !searching && s?.status_detail && ['attention', 'exited', 'blocked', 'stopped'].includes(s.status)
  notice.hidden = !show
  notice.textContent = show ? s.status_detail : ''
  if (!s || searching) setTerminal(false)
}

function renderPermissions() {
  const box = $('permissions')
  box.replaceChildren()
  for (const p of state.permissions.values()) {
    const decide = behavior => async () => {
      try {
        await api('POST', `/api/permissions/${p.id}`, { behavior })
      } catch (e) {
        alert(e.message)
      }
    }
    box.append(el('div', { className: 'permission' },
      el('h3', { textContent: `${p.session} wants to use ${p.tool_name}` }),
      el('div', { textContent: p.description }),
      el('pre', { textContent: p.input_preview }),
      el('div', { className: 'row' },
        el('button', { textContent: 'Deny', onclick: decide('deny') }),
        el('button', { className: 'primary', textContent: 'Allow', onclick: decide('allow') }),
      ),
    ))
  }
}

// ---------------------------------------------------------------------------------------------
// Thread

function messageNode(m) {
  const fromUser = m.from_name === 'user'
  const toUser = m.to_name === 'user'
  const kind = fromUser ? 'mine' : toUser ? 'theirs' : 'between'
  const bubble = el('div', { className: 'bubble' })
  bubble.innerHTML = markdown(m.body)

  const bits = []
  if (kind === 'between') bits.push(`${m.from_name} → ${m.to_name}`)
  else if (state.current === ALL) bits.push(fromUser ? `to ${m.to_name}` : m.from_name)
  bits.push(time(m.ts))
  if (m.source === 'stop_hook') bits.push('from the terminal')
  const meta = el('div', { className: 'meta' }, bits.join(' · '))
  if (m.delivery) {
    const text = DELIVERY_TEXT[m.delivery] + (m.via === 'paste' && m.delivery !== 'pending' ? ' (typed into the terminal)' : '')
    meta.append(' · ', el('span', { className: m.delivery === 'failed' ? 'failed' : '', textContent: text }))
  }
  const node = el('div', { className: `msg ${kind}` }, bubble, meta)
  node.dataset.id = m.id
  return node
}

function renderThread() {
  const box = $('thread')
  box.replaceChildren()
  if (!state.current) {
    box.append(el('div', { className: 'empty', textContent: 'No sessions yet. Start one to begin.' }))
    return
  }
  if (!state.messages.length) {
    box.append(el('div', { className: 'empty', textContent: state.current === ALL ? 'No messages yet.' : 'No messages yet. Say something.' }))
    return
  }
  box.append(...state.messages.map(messageNode))
  box.scrollTop = box.scrollHeight
}

function belongsHere(m) {
  return state.current === ALL || m.from_name === state.current || m.to_name === state.current
}

function addMessage(m) {
  if (state.view === 'thread' && belongsHere(m)) {
    if (state.messages.some(x => x.id === m.id)) return
    const box = $('thread')
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
    if (!state.messages.length) box.replaceChildren()
    state.messages.push(m)
    box.append(messageNode(m))
    if (nearBottom || m.from_name === 'user') box.scrollTop = box.scrollHeight
  }
  const visible = state.view === 'thread' && state.current === m.from_name && !document.hidden
  if (m.to_name === 'user' && !visible) {
    state.unread.set(m.from_name, (state.unread.get(m.from_name) ?? 0) + 1)
    renderSidebar()
  }
}

function updateDelivery(id, delivery, via) {
  const m = state.messages.find(x => x.id === id)
  if (!m) return
  Object.assign(m, { delivery, via })
  document.querySelector(`.msg[data-id="${id}"]`)?.replaceWith(messageNode(m))
}

async function loadThread() {
  if (!state.current) return renderThread()
  const key = state.current
  const url = key === ALL ? '/api/messages?limit=200' : `/api/messages?limit=200&session=${encodeURIComponent(key)}`
  const rows = await api('GET', url)
  if (state.current !== key) return
  state.messages = rows
  renderThread()
}

async function select(key) {
  state.current = key
  state.view = 'thread'
  state.unread.delete(key)
  document.body.classList.remove('menu-open')
  try {
    localStorage.setItem('hub.current', key)
  } catch {
    // private window: the choice just won't be remembered
  }
  renderSidebar()
  renderHeader()
  if (state.terminalOpen && state.sessions.has(key)) setTerminal(true) // follow the selection
  await loadThread()
}

// ---------------------------------------------------------------------------------------------
// Terminal view

let terminalTimer
let live = null // { term, fit, ws } while a live terminal is attached
let historyMode = false // scrollback snapshot instead of the live view

const scripts = new Map()
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const tag = el('script', { src, onload: resolve, onerror: () => reject(new Error(`could not load ${src}`)) })
      document.head.append(tag)
    }))
  }
  return scripts.get(src)
}

async function refreshScreen() {
  if (!state.terminalOpen || live || !state.sessions.has(state.current)) return
  try {
    const { screen } = await api('GET', `/api/screen/${encodeURIComponent(state.current)}?history=${historyMode ? 3000 : 0}`)
    const pre = $('screen')
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
    pre.textContent = screen || '(nothing on screen)'
    if (atBottom) pre.scrollTop = pre.scrollHeight
  } catch {
    // shown as stale until the next refresh
  }
}

// The live view makes this tab a real client of the session's terminal: what you type goes straight in.
async function openLive() {
  await loadScript('/vendor/xterm.js')
  await loadScript('/vendor/addon-fit.js')
  const name = state.current
  const term = new Terminal({
    fontSize: matchMedia('(max-width: 760px)').matches ? 11 : 12.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    cursorBlink: true,
    scrollback: 0, // history lives in tmux; the History button shows it
    theme: { background: '#101216', foreground: '#d6d6d2' },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open($('xterm'))
  fit.fit()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/term?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`)
  const send = msg => ws.readyState === 1 && ws.send(JSON.stringify(msg))
  ws.onmessage = e => term.write(e.data)
  ws.onclose = () => live?.ws === ws && term.write('\r\n[terminal disconnected]\r\n')
  term.onData(data => send({ type: 'input', data }))
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
  live = { term, fit, ws, send }
}

function closeLive() {
  if (!live) return
  const old = live
  live = null
  old.ws.close()
  old.term.dispose()
  $('xterm').replaceChildren()
}
window.addEventListener('resize', () => live?.fit.fit())

function setTerminal(open) {
  state.terminalOpen = open
  $('terminal').hidden = !open
  $('term-btn').textContent = open ? 'Hide terminal' : 'Terminal'
  clearInterval(terminalTimer)
  closeLive()
  if (!open) return
  const useLive = state.liveTerminal && !historyMode
  $('xterm').hidden = !useLive
  $('screen').hidden = useLive
  $('type-form').hidden = useLive
  $('history-btn').hidden = !state.liveTerminal
  $('history-btn').textContent = historyMode ? 'Back to live' : 'History'
  if (useLive) {
    openLive().catch(() => {
      // The live view could not start (old browser, blocked socket): use snapshots instead.
      state.liveTerminal = false
      setTerminal(true)
    })
  } else {
    refreshScreen().then(() => ($('screen').scrollTop = $('screen').scrollHeight))
    terminalTimer = setInterval(refreshScreen, historyMode ? 5000 : 1500)
  }
}

const KEY_BYTES = { Enter: '\r', Escape: '\x1b', Up: '\x1b[A', Down: '\x1b[B', Tab: '\t', BTab: '\x1b[Z', 'C-c': '\x03' }

async function sendKeys(keys) {
  if (live) {
    for (const k of keys) live.send({ type: 'input', data: KEY_BYTES[k] ?? k })
    live.term.focus()
    return
  }
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(state.current)}/keys`, { keys })
    setTimeout(refreshScreen, 250)
  } catch (e) {
    alert(e.message)
  }
}

// ---------------------------------------------------------------------------------------------
// Search

async function runSearch(q) {
  const box = $('search-results')
  box.replaceChildren()
  if (!q.trim()) return
  const hits = await api('GET', `/api/search?limit=50&q=${encodeURIComponent(q)}`)
  if (!hits.length) {
    box.append(el('div', { className: 'empty', textContent: 'Nothing found.' }))
    return
  }
  for (const h of hits) {
    const b = el('button', { className: 'hit' })
    const where = [h.session, h.who, h.ts ? time(h.ts) : '', h.kind === 'transcript' ? 'transcript' : '', h.match === 'meaning' ? 'matched by meaning' : ''].filter(Boolean).join(' · ')
    b.append(el('div', { className: 'where', textContent: where }))
    const snippet = el('div')
    snippet.innerHTML = esc(h.snippet).replace(/\[([^\]]+)\]/g, '<mark>$1</mark>')
    b.append(snippet)
    if (state.sessions.has(h.session)) b.onclick = () => select(h.session)
    box.append(b)
  }
}

// ---------------------------------------------------------------------------------------------
// Live updates

let socket
let retry = 500

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`)
  socket.onopen = async () => {
    retry = 500
    $('conn').className = 'dot on'
    $('conn').title = 'Connected'
    sendPresence()
    await loadState() // also catches up on anything missed while disconnected
  }
  socket.onclose = () => {
    $('conn').className = 'dot off'
    $('conn').title = 'Disconnected, retrying'
    setTimeout(connect, retry)
    retry = Math.min(retry * 2, 8000)
  }
  socket.onmessage = e => {
    const ev = JSON.parse(e.data)
    if (ev.type === 'message') addMessage(ev.message)
    else if (ev.type === 'delivery') updateDelivery(ev.message_id, ev.state, ev.via)
    else if (ev.type === 'session') {
      const isNew = !state.sessions.has(ev.session.name)
      state.sessions.set(ev.session.name, ev.session)
      renderSidebar()
      if (ev.session.name === state.current) renderHeader()
      if (isNew && !state.current) select(ev.session.name)
    } else if (ev.type === 'session_removed') {
      state.sessions.delete(ev.name)
      if (state.current === ev.name) select(state.sessions.keys().next().value ?? null)
      else renderSidebar()
    } else if (ev.type === 'permission') {
      state.permissions.set(ev.request.id, ev.request)
      renderPermissions()
    } else if (ev.type === 'permission_closed') {
      state.permissions.delete(ev.id)
      renderPermissions()
    }
  }
}

async function loadState() {
  const data = await api('GET', '/api/state')
  state.sessions = new Map(data.sessions.map(s => [s.name, s]))
  state.permissions = new Map(data.permissions.map(p => [p.id, p]))
  state.liveTerminal = Boolean(data.liveTerminal)
  // A tapped notification opens the hub with ?session=<name>.
  const asked = new URLSearchParams(location.search).get('session')
  const wantTerminal = new URLSearchParams(location.search).get('terminal') === '1'
  if (asked && state.sessions.has(asked)) {
    state.current = asked
    history.replaceState(null, '', '/')
  }
  if (!state.current || (state.current !== ALL && !state.sessions.has(state.current))) {
    let saved = null
    try {
      saved = localStorage.getItem('hub.current')
    } catch {
      // no storage available
    }
    state.current = saved && (saved === ALL || state.sessions.has(saved)) ? saved : state.sessions.keys().next().value ?? null
  }
  renderSidebar()
  renderHeader()
  renderPermissions()
  if (wantTerminal && state.sessions.has(state.current)) setTerminal(true) // ?session=<name>&terminal=1 opens it directly
  await loadThread()
}

// ---------------------------------------------------------------------------------------------
// Events

const input = $('input')
const autosize = () => {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.4) + 'px'
}
input.addEventListener('input', autosize)
input.addEventListener('keydown', e => {
  // Enter sends on a keyboard; on a phone Enter makes a new line and the button sends.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault()
    $('composer').requestSubmit()
  }
})

$('composer').addEventListener('submit', async e => {
  e.preventDefault()
  const body = input.value.trim()
  if (!body || !state.sessions.has(state.current)) return
  $('send-btn').disabled = true
  try {
    addMessage(await api('POST', '/api/messages', { to: state.current, body }))
    input.value = ''
    autosize()
  } catch (err) {
    alert(err.message)
  } finally {
    $('send-btn').disabled = false
    input.focus()
  }
})

$('menu-btn').onclick = () => document.body.classList.toggle('menu-open')
document.querySelector('main').addEventListener('click', e => {
  if (document.body.classList.contains('menu-open') && !e.target.closest('#menu-btn')) document.body.classList.remove('menu-open')
})

$('term-btn').onclick = () => setTerminal(!state.terminalOpen)
$('history-btn').onclick = e => {
  e.stopPropagation()
  historyMode = !historyMode
  setTerminal(true)
}
$('keys').addEventListener('click', e => {
  const key = e.target.dataset?.key
  if (key) sendKeys([key])
})
$('type-form').addEventListener('submit', e => {
  e.preventDefault()
  const text = $('type-input').value
  if (!text) return
  api('POST', `/api/sessions/${encodeURIComponent(state.current)}/type`, { text })
    .then(() => setTimeout(refreshScreen, 250), err => alert(err.message))
  $('type-input').value = ''
})

$('stop-btn').onclick = async () => {
  if (!confirm(`Stop ${state.current}? Its conversation is kept and can be started again.`)) return
  await api('POST', `/api/sessions/${encodeURIComponent(state.current)}/stop`).catch(e => alert(e.message))
}
$('restart-btn').onclick = async () => {
  await api('POST', `/api/sessions/${encodeURIComponent(state.current)}/restart`).catch(e => alert(e.message))
}

$('search-btn').onclick = () => {
  state.view = 'search'
  document.body.classList.remove('menu-open')
  renderSidebar()
  renderHeader()
  $('search-input').focus()
}
$('search-form').addEventListener('submit', e => {
  e.preventDefault()
  runSearch($('search-input').value).catch(err => alert(err.message))
})

const dialog = $('new-dialog')
$('new-btn').onclick = () => {
  $('new-error').hidden = true
  document.body.classList.remove('menu-open')
  dialog.showModal()
}
$('new-cancel').onclick = () => dialog.close()
$('new-form').addEventListener('submit', async e => {
  e.preventDefault()
  const form = new FormData(e.target)
  try {
    const s = await api('POST', '/api/sessions', { name: form.get('name'), cwd: form.get('cwd'), prompt: form.get('prompt') })
    state.sessions.set(s.name, s)
    dialog.close()
    e.target.reset()
    await select(s.name)
  } catch (err) {
    $('new-error').textContent = err.message
    $('new-error').hidden = false
  }
})

// ---------------------------------------------------------------------------------------------
// Notifications (Web Push). The hub skips them while a tab is in front, so each tab reports that.

function sendPresence() {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'presence', visible: !document.hidden }))
}
document.addEventListener('visibilitychange', sendPresence)
window.addEventListener('pagehide', () => socket?.readyState === 1 && socket.send(JSON.stringify({ type: 'presence', visible: false })))

const b64ToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

async function setupNotifications() {
  const btn = $('notify-btn')
  if (!('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.register('/sw.js')
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open' && state.sessions.has(e.data.session)) select(e.data.session)
  })
  if (!('PushManager' in window) || !('Notification' in window)) {
    // On an iPhone, push only exists once the page is added to the Home Screen.
    if (/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone) {
      btn.hidden = false
      btn.textContent = 'Notifications: add to Home Screen first'
      btn.disabled = true
    }
    return
  }
  const refresh = async () => {
    const sub = await reg.pushManager.getSubscription()
    btn.hidden = false
    btn.disabled = Notification.permission === 'denied'
    btn.textContent = Notification.permission === 'denied' ? 'Notifications blocked in browser settings'
      : sub ? 'Notifications on (tap to test)' : 'Turn on notifications'
    return sub
  }
  // Keep the hub's copy of the subscription current; browsers rotate them.
  const existing = await refresh()
  if (existing) api('POST', '/api/push/subscribe', { subscription: existing.toJSON() }).catch(() => {})

  btn.onclick = async () => {
    try {
      let sub = await reg.pushManager.getSubscription()
      if (sub) {
        const { sent } = await api('POST', '/api/push/test')
        if (!sent) alert('The hub could not send a notification to this device. Try turning notifications off and on in the browser.')
        return
      }
      if ((await Notification.requestPermission()) !== 'granted') return void refresh()
      const { publicKey } = await api('GET', '/api/push')
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) })
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() })
      await refresh()
      await api('POST', '/api/push/test')
    } catch (e) {
      alert('Could not turn on notifications: ' + e.message)
    }
  }
}
setupNotifications().catch(() => {})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.view === 'thread' && state.unread.delete(state.current)) renderSidebar()
})

connect()
