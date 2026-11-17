import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { sessions } from './db.ts'

// In-memory connection state shared by the router, the spawner and the HTTP server.

/** Channel MCP servers, one per running session, keyed by session name. */
export const channels = new Map<string, WebSocket>()

/** Set while the hub shuts down (for a code reload), so it starts nothing it can't see through. */
export const lifecycle = { stopping: false }

/** Browser tabs. */
export const uiClients = new Set<WebSocket>()

/** Emits `status:<name>` whenever a session's status changes. */
export const bus = new EventEmitter()
bus.setMaxListeners(200)

/** Per-session turn bookkeeping, used for delivery acks and the lost-reply safety net. */
// `forUser` is true when the turn answers the user (their message, or something typed at the terminal),
// as opposed to a turn started by another session.
export const turns = new Map<string, { startedAt: number; replied: boolean; forUser: boolean }>()

/** When each session last showed a sign of life (a hook fired or it called a hub tool). */
export const activity = new Map<string, number>()

/** What each session is doing right now ("Editing auth.ts"), shown live in the app while a turn runs. */
export const doing = new Map<string, { text: string; since: number }>()

/** Background shells, tasks or agents an idle session still has running ("1 shell"), read from its footer. */
export const background = new Map<string, string>()

export function setBackground(name: string, what: string | null) {
  if ((background.get(name) ?? null) === what) return
  if (what) background.set(name, what)
  else background.delete(name)
  sessionChanged(name)
}

export function setDoing(name: string, text: string | null) {
  if (text === null) {
    if (!doing.delete(name)) return
  } else {
    const since = turns.get(name)?.startedAt ?? doing.get(name)?.since ?? Date.now()
    doing.set(name, { text, since })
  }
  broadcast({ type: 'activity', session: name, activity: doing.get(name) ?? null })
}

export function broadcast(event: Record<string, unknown>) {
  const data = JSON.stringify(event)
  for (const ws of uiClients) if (ws.readyState === 1) ws.send(data)
}

export function sendToChannel(name: string, payload: Record<string, unknown>): boolean {
  const ws = channels.get(name)
  if (!ws || ws.readyState !== 1) return false
  ws.send(JSON.stringify(payload))
  return true
}

export function setStatus(name: string, status: string, detail: string | null = null) {
  const before = sessions.get(name)
  if (!before) return
  if (before.status === status && before.status_detail === detail) return
  sessions.update(name, { status, status_detail: detail })
  if (status !== 'working' && status !== 'blocked') setDoing(name, null)
  if (status !== 'idle') background.delete(name)
  sessionChanged(name)
  bus.emit(`status:${name}`, status)
  if (status === 'attention' || status === 'exited') bus.emit('trouble', name, status, detail)
}

export function sessionChanged(name: string) {
  const session = sessions.get(name)
  if (session) broadcast({ type: 'session', session: publicSession(session) })
}

/** A session row for the app: extra MCP servers by name only, since their env and headers can hold keys. */
export function publicSession<T extends { name: string; mcp_servers?: string | null }>(s: T) {
  let names: string[] = []
  try {
    names = s.mcp_servers ? Object.keys(JSON.parse(s.mcp_servers)) : []
  } catch {
    // unreadable: none shown
  }
  return { ...s, mcp_servers: names, background: background.get(s.name) ?? null }
}
