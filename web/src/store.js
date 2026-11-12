// App state as signals, kept current by one WebSocket to the server.
import { signal, computed, batch } from '@preact/signals'
import { api, local } from './lib.js'

export const connected = signal(false)
export const loaded = signal(false)
export const user = signal({ name: '' })
export const health = signal({})
export const liveTerminal = signal(false)
export const sessions = signal(/** @type {Record<string, any>} */ ({}))
export const permissions = signal(/** @type {any[]} */ ([]))
export const recent = signal(/** @type {any[]} */ ([])) // newest last, across all sessions
export const threads = signal(/** @type {Record<string, any[]>} */ ({})) // per session, loaded on demand
export const route = signal(parse(location))
export const paletteOpen = signal(false)
export const newSessionOpen = signal(false)
export const lightbox = signal(/** @type {null | { items: any[], index: number }} */ (null))

export const sessionList = computed(() => {
  const all = Object.values(sessions.value)
  return all.sort((a, b) => (a.role === 'orchestrator' ? -1 : 0) - (b.role === 'orchestrator' ? -1 : 0) || a.name.localeCompare(b.name))
})
export const orchestrator = computed(() => sessionList.value.find(s => s.role === 'orchestrator') ?? null)
export const totalUnread = computed(() => sessionList.value.reduce((n, s) => n + (s.unread ?? 0), 0))

// ---------------------------------------------------------------------------------------------
// Routing: /, /s/:name, /timeline, /search, /sessions

function parse(loc) {
  const params = new URLSearchParams(loc.search)
  const [, first, second] = loc.pathname.split('/').map(decodeURIComponent)
  if (first === 's' && second) return { view: 'session', name: second, tab: params.get('tab') ?? 'chat' }
  if (first === 'timeline') return { view: 'timeline', session: params.get('session') ?? '' }
  if (first === 'search') return { view: 'search', q: params.get('q') ?? '' }
  if (first === 'sessions') return { view: 'sessions' }
  // Older notification links used /?session=<name>.
  if (params.get('session')) return { view: 'session', name: params.get('session'), tab: params.get('terminal') === '1' ? 'terminal' : 'chat' }
  return { view: 'home' }
}

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return
  history[replace ? 'replaceState' : 'pushState'](null, '', path)
  route.value = parse(location)
  document.querySelector('.scroll')?.scrollTo?.(0, 0)
}
window.addEventListener('popstate', () => (route.value = parse(location)))

// Rewrite the older /?session=<name> notification links to the session's own address.
if (route.value.view === 'session' && new URLSearchParams(location.search).has('session')) {
  history.replaceState(null, '', `/s/${encodeURIComponent(route.value.name)}${route.value.tab !== 'chat' ? `?tab=${route.value.tab}` : ''}`)
}

export const sessionPath = (name, tab) => `/s/${encodeURIComponent(name)}${tab && tab !== 'chat' ? `?tab=${tab}` : ''}`

// ---------------------------------------------------------------------------------------------
// Loading

export async function loadState() {
  const [state, timeline] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/messages?limit=200')])
  batch(() => {
    user.value = state.user ?? { name: '' }
    health.value = state.health ?? {}
    liveTerminal.value = Boolean(state.liveTerminal)
    sessions.value = Object.fromEntries(state.sessions.map(s => [s.name, s]))
    permissions.value = state.permissions
    recent.value = timeline
    loaded.value = true
  })
  // Threads that are open get refreshed too, to catch anything missed while disconnected.
  await Promise.all(Object.keys(threads.value).map(loadThread))
}

export async function loadThread(name) {
  const rows = await api('GET', `/api/messages?limit=200&session=${encodeURIComponent(name)}`)
  threads.value = { ...threads.value, [name]: rows }
}

export async function loadOlder(name) {
  const rows = threads.value[name] ?? []
  if (!rows.length) return 0
  const older = await api('GET', `/api/messages?limit=100&session=${encodeURIComponent(name)}&before=${rows[0].id}`)
  threads.value = { ...threads.value, [name]: [...older, ...rows] }
  return older.length
}

// ---------------------------------------------------------------------------------------------
// Live updates

let socket
let retry = 500

export function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`)
  socket.onopen = async () => {
    retry = 500
    connected.value = true
    sendPresence()
    try {
      await loadState()
    } catch {
      // the next reconnect tries again
    }
  }
  socket.onclose = () => {
    connected.value = false
    setTimeout(connect, retry)
    retry = Math.min(retry * 2, 8000)
  }
  socket.onmessage = e => handle(JSON.parse(e.data))
}

function patchSession(name, fields) {
  const s = sessions.value[name]
  if (s) sessions.value = { ...sessions.value, [name]: { ...s, ...fields } }
}

function upsertMessage(list, m) {
  const i = list.findIndex(x => x.id === m.id)
  if (i === -1) return [...list, m]
  const copy = list.slice()
  copy[i] = { ...copy[i], ...m }
  return copy
}

function handle(ev) {
  switch (ev.type) {
    case 'message': {
      const m = ev.message
      batch(() => {
        recent.value = upsertMessage(recent.value, m).slice(-400)
        const next = { ...threads.value }
        for (const name of new Set([m.from_name, m.to_name])) if (next[name]) next[name] = upsertMessage(next[name], m)
        threads.value = next
        for (const name of new Set([m.from_name, m.to_name])) {
          const s = sessions.value[name]
          if (!s) continue
          const fromSession = m.from_name === name && m.to_name === 'user'
          patchSession(name, { last_message: m, unread: (s.unread ?? 0) + (fromSession && !isReading(name) ? 1 : 0) })
        }
      })
      if (m.to_name === 'user' && isReading(m.from_name)) markRead(m.from_name, m.id)
      break
    }
    case 'delivery': {
      const fix = list => list.map(x => (x.id === ev.message_id ? { ...x, delivery: ev.state, via: ev.via } : x))
      batch(() => {
        recent.value = fix(recent.value)
        threads.value = Object.fromEntries(Object.entries(threads.value).map(([k, v]) => [k, fix(v)]))
      })
      break
    }
    case 'session': {
      const prev = sessions.value[ev.session.name]
      sessions.value = { ...sessions.value, [ev.session.name]: { last_message: null, unread: 0, ...prev, ...ev.session } }
      break
    }
    case 'session_removed': {
      const { [ev.name]: _, ...rest } = sessions.value
      sessions.value = rest
      if (route.value.view === 'session' && route.value.name === ev.name) navigate('/', { replace: true })
      break
    }
    case 'read':
      patchSession(ev.session, { unread: ev.unread })
      break
    case 'permission':
      permissions.value = [...permissions.value.filter(p => p.id !== ev.request.id), ev.request]
      break
    case 'permission_closed':
      permissions.value = permissions.value.filter(p => p.id !== ev.id)
      break
  }
}

// ---------------------------------------------------------------------------------------------
// Reading and presence

/** True while this tab is visible and showing that session's conversation. */
export function isReading(name) {
  const r = route.value
  return !document.hidden && r.view === 'session' && r.name === name && r.tab !== 'activity'
}

export function markRead(name, id) {
  const s = sessions.value[name]
  if (!s || !id) return
  if (s.unread) patchSession(name, { unread: 0 })
  api('POST', '/api/read', { session: name, id }).catch(() => {})
}

export function readLatest(name) {
  const last = sessions.value[name]?.last_message
  if (last) markRead(name, last.id)
}

function sendPresence() {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'presence', visible: !document.hidden }))
}
document.addEventListener('visibilitychange', () => {
  sendPresence()
  const r = route.value
  if (!document.hidden && r.view === 'session') readLatest(r.name)
})
window.addEventListener('pagehide', () => socket?.readyState === 1 && socket.send(JSON.stringify({ type: 'presence', visible: false })))

// ---------------------------------------------------------------------------------------------
// Actions

export async function send(to, body, attachments = []) {
  const m = await api('POST', '/api/messages', { to, body, attachments })
  handle({ type: 'message', message: m })
  return m
}

export const sessionAction = (name, action) => api('POST', `/api/sessions/${encodeURIComponent(name)}/${action}`)
export const removeSession = name => api('DELETE', `/api/sessions/${encodeURIComponent(name)}`)
export const decide = (id, behavior) => api('POST', `/api/permissions/${id}`, { behavior })

export async function createSession(fields) {
  const s = await api('POST', '/api/sessions', fields)
  sessions.value = { ...sessions.value, [s.name]: { last_message: null, unread: 0, ...s } }
  local.set('neural.lastCwd', fields.cwd)
  return s
}
