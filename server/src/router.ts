import { config } from './config.ts'
import { sessions, messages, outbox, events, permissions, type Message } from './db.ts'
import { searchAll } from './embed.ts'
import { broadcast, channels, sendToChannel, setStatus, sessionChanged, turns, activity } from './live.ts'
import { notify } from './push.ts'
import { claimFor, checkUnclaimed, describeForClaude, forMessages, importFile, summary } from './files.ts'
import { mux, startSession, stopSession, restartSession, waitFor, markHealthy, validName } from './spawner.ts'

const MAX_ATTEMPTS = 4

// ---------------------------------------------------------------------------------------------
// Sending: every message is stored first, then delivered.

export function sendMessage(m: { from: string; to: string; body: string; source: string; in_reply_to?: number | null; attachments?: number[] }): Message {
  const body = m.body.trim()
  const files = [...new Set((m.attachments ?? []).map(Number))]
  if (!body && !files.length) throw new Error('empty message')
  if (m.to !== 'user' && !sessions.get(m.to)) throw new Error(`no session "${m.to}"`)
  checkUnclaimed(files)
  const stored = messages.insert({ from: m.from, to: m.to, body, source: m.source, in_reply_to: m.in_reply_to })
  if (files.length) claimFor(stored.id, files)
  if (m.to !== 'user') {
    outbox.add(stored.id, m.to)
    flush(m.to)
  }
  const fresh = messages.get(stored.id)!
  broadcast({ type: 'message', message: fresh })
  if (m.to === 'user' && m.from !== 'system') {
    void notify({ title: m.from, body: body || summary(fresh.attachments as { kind: string }[]), session: m.from, tag: `msg-${m.from}` })
  }
  return fresh
}

/** Push every pending message for a session through its channel, oldest first. */
export function flush(target: string) {
  const s = sessions.get(target)
  if (!s || !channels.has(target)) return
  for (const row of outbox.pending(target)) {
    const msg = messages.get(row.message_id)
    if (!msg) continue
    if (row.attempts >= MAX_ATTEMPTS) {
      outbox.markFailed(row.message_id, 'gave up after repeated delivery attempts')
      delivery(row.message_id)
      continue
    }
    const from = msg.from_name === 'user' || msg.from_name === 'system' ? msg.from_name : `session:${msg.from_name}`
    const ok = sendToChannel(target, { type: 'push', msg_id: String(msg.id), from, ts: msg.ts, body: forClaude(msg.id, msg.body) })
    if (!ok) return
    outbox.markPushed(msg.id, 'channel')
    delivery(msg.id)
    beginTurnIfIdle(target, msg.from_name === 'user')
  }
}

/** The message text a session receives, with a note about any attached files. */
function forClaude(messageId: number, body: string) {
  const note = describeForClaude(forMessages([messageId]).get(messageId) ?? [])
  return [body, note].filter(Boolean).join('\n\n')
}

function delivery(messageId: number) {
  const m = messages.get(messageId)
  if (m) broadcast({ type: 'delivery', message_id: m.id, state: m.delivery, via: m.via })
}

function ack(messageId: number, by: string) {
  if (outbox.markAcked(messageId, by).changes) delivery(messageId)
}

// A push into an idle session starts a turn. Messages pushed while a turn is running wait for the next one,
// so the Stop that ends the current turn must not count as evidence that they were read.
function beginTurnIfIdle(name: string, forUser: boolean) {
  const s = sessions.get(name)
  if (!s) return
  if (s.status !== 'idle') {
    // Already in a turn that this message will be read in or right after; or not usable yet.
    const turn = turns.get(name)
    if (turn && forUser && Date.now() - turn.startedAt < 1000) turn.forUser = true
    return
  }
  turns.set(name, { startedAt: Date.now(), replied: false, forUser })
  setStatus(name, 'working')
}

// ---------------------------------------------------------------------------------------------
// Hooks: Claude Code POSTs lifecycle events here. They are the source of truth for session state.

export function handleHook(name: string, event: string, payload: any) {
  const s = sessions.get(name)
  if (!s) return
  activity.set(name, Date.now())
  if (event === 'PostToolUse') return // heartbeat only
  events.add(name, `hook:${event}`, payload)

  if (payload?.session_id && (payload.session_id !== s.claude_session_id || payload.transcript_path !== s.transcript_path)) {
    sessions.update(name, { claude_session_id: payload.session_id, transcript_path: payload.transcript_path ?? null })
    sessionChanged(name)
  }

  switch (event) {
    case 'SessionStart':
      if (s.status === 'starting' && channels.has(name)) becomeReady(name)
      break
    case 'UserPromptSubmit': {
      // Channel messages arrive as prompts too, wrapped in the hub's tag: seeing one here is proof of delivery.
      const tags = String(payload?.prompt ?? '').match(/<channel\b[^>]*\bsource="(?:neural|hub)"[^>]*>/g) ?? []
      let forUser = tags.length === 0 // no tag: typed at the terminal
      for (const tag of tags) {
        if (/\bfrom="user"/.test(tag)) forUser = true
        const id = Number(tag.match(/\bmsg_id="(\d+)"/)?.[1])
        if (id && outbox.get(id)?.target === name) ack(id, 'prompt')
      }
      turns.set(name, { startedAt: Date.now(), replied: false, forUser })
      setStatus(name, 'working')
      break
    }
    case 'Notification':
      // Claude is waiting on the user: a permission prompt or a question in the terminal.
      if (/permission|needs your|waiting for (your )?input|approval/i.test(String(payload?.message ?? ''))) {
        if (s.status === 'working') setStatus(name, 'blocked', String(payload.message))
      }
      break
    case 'Stop':
      onTurnEnd(name, payload)
      break
    case 'SessionEnd':
      // The user quit Claude in its terminal: treat that as a deliberate stop, not a crash to recover from.
      if (['prompt_input_exit', 'logout'].includes(payload?.reason)) {
        permissions.expire(name)
        setStatus(name, 'stopped', 'Exited from the terminal')
      }
      break
  }
}

function onTurnEnd(name: string, payload: any) {
  const turn = turns.get(name)
  const startedAt = turn?.startedAt ?? 0
  markHealthy(name)

  // Anything pushed before this turn began was in front of Claude during it.
  for (const row of outbox.pushed(name)) {
    if (row.pushed_at && Date.parse(row.pushed_at) <= startedAt + 1000) ack(row.message_id, 'turn-end')
  }

  // Safety net: Claude answered the user in the terminal without calling the reply tool. Show the answer anyway.
  // Turns started by another session are left alone; their outcome travels by send_message.
  const last = String(payload?.last_assistant_message ?? '').trim()
  if (turn && turn.forUser && !turn.replied && last) {
    sendMessage({ from: name, to: 'user', body: last, source: 'stop_hook' })
  }

  for (const p of permissions.open().filter(p => p.session === name)) closePermission(p.id, 'expired')

  // Messages that arrived mid-turn are delivered by Claude Code as the next turn.
  const waiting = outbox.pushed(name)
  if (waiting.length) {
    const forUser = waiting.some(row => messages.get(row.message_id)?.from_name === 'user')
    turns.set(name, { startedAt: Date.now(), replied: false, forUser })
    setStatus(name, 'working')
  } else {
    turns.delete(name)
    setStatus(name, 'idle')
  }
}

// ---------------------------------------------------------------------------------------------
// Channel connections.

export function channelConnected(name: string) {
  sessions.update(name, { channel_connected: 1 })
  events.add(name, 'channel-connected', null)
  const s = sessions.get(name)!
  if (s.status === 'starting' || s.status === 'attention' || s.status === 'exited') becomeReady(name)
  else {
    sessionChanged(name)
    // A reconnect (hub restart) may have dropped pushes that were in flight; send them again.
    for (const row of outbox.pushed(name)) outbox.requeue(row.message_id, 'channel reconnected')
    setTimeout(() => flush(name), 1500)
  }
}

function becomeReady(name: string) {
  setStatus(name, 'idle')
  sessionChanged(name)
  // Give Claude Code a moment to finish registering the channel listener before the first push.
  setTimeout(() => flush(name), 1500)
}

export function channelDisconnected(name: string) {
  if (!sessions.get(name)) return
  sessions.update(name, { channel_connected: 0 })
  events.add(name, 'channel-disconnected', null)
  sessionChanged(name)
}

// ---------------------------------------------------------------------------------------------
// Fallback delivery: a push that shows no sign of being read is pasted into the terminal instead.

export async function retryStale() {
  for (const row of outbox.stale(config.ackTimeoutSec)) {
    const s = sessions.get(row.target)
    if (!s || ['stopped', 'exited', 'starting'].includes(s.status)) continue // delivered when it is back
    // The clock starts when the message could first have been read: when it was pushed, or when the turn
    // it is waiting behind ended. Any hook or tool call since then means the session is busy, not deaf.
    const basis = Math.max(Date.parse(row.pushed_at ?? ''), turns.get(row.target)?.startedAt ?? 0)
    if (Date.now() - basis < config.ackTimeoutSec * 1000) continue
    if ((activity.get(row.target) ?? 0) > basis + 250) continue
    const msg = messages.get(row.message_id)
    if (!msg) continue
    if (row.attempts >= MAX_ATTEMPTS) {
      outbox.markFailed(row.message_id, 'no sign of delivery after retries')
      delivery(row.message_id)
      setStatus(row.target, 'attention', 'Messages are not getting through. Open the terminal view to check on it.')
      continue
    }
    try {
      if (!(await mux.alive(row.target))) continue // reconcile restarts it, and the message is requeued then
      const from = msg.from_name === 'user' ? 'user' : `session:${msg.from_name}`
      // Record the attempt before typing, so the turn it starts is counted from here.
      outbox.markPushed(row.message_id, 'paste')
      turns.set(row.target, { startedAt: Date.now(), replied: false, forUser: msg.from_name === 'user' })
      events.add(row.target, 'fallback-paste', { message_id: row.message_id })
      await mux.paste(row.target, `[Neural message from ${from}, msg_id=${msg.id}; answer with the neural reply tool]\n${forClaude(msg.id, msg.body)}`)
      delivery(row.message_id)
      setStatus(row.target, 'working')
    } catch (e) {
      events.add(row.target, 'fallback-failed', { message_id: row.message_id, error: String(e) })
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Permission relay.

export function permissionRequested(name: string, p: { request_id: string; tool_name: string; description: string; input_preview: string }) {
  const request = permissions.add(name, p)
  setStatus(name, 'blocked', `Wants to use ${p.tool_name}`)
  broadcast({ type: 'permission', request })
  void notify({ title: `${name} needs approval`, body: `${p.tool_name}: ${p.description}`, session: name, tag: `perm-${name}` })
}

export function decidePermission(id: number, behavior: 'allow' | 'deny') {
  const p = permissions.get(id)
  if (!p || p.verdict) throw new Error('that request is no longer open')
  if (!sendToChannel(p.session, { type: 'permission_verdict', request_id: p.request_id, behavior })) {
    throw new Error(`"${p.session}" is not connected; answer in its terminal instead`)
  }
  closePermission(id, behavior)
  if (sessions.get(p.session)?.status === 'blocked') setStatus(p.session, 'working')
}

function closePermission(id: number, verdict: string) {
  if (permissions.decide(id, verdict).changes) broadcast({ type: 'permission_closed', id, verdict })
}

// ---------------------------------------------------------------------------------------------
// Tools: calls the channel MCP server forwards on behalf of Claude.

const ORCHESTRATOR_ONLY = new Set(['spawn_session', 'stop_session', 'restart_session', 'read_screen', 'wait_for'])

export async function handleTool(caller: string, tool: string, a: any): Promise<unknown> {
  const me = sessions.get(caller)
  if (!me) throw new Error(`unknown session "${caller}"`)
  activity.set(caller, Date.now())
  if (ORCHESTRATOR_ONLY.has(tool) && me.role !== 'orchestrator') throw new Error(`${tool} is only available to the orchestrator`)

  switch (tool) {
    case 'reply':
      return say(caller, 'user', a.text, 'reply', a.in_reply_to, await importAll(a.files))
    case 'send_message':
      if (a.to === caller) throw new Error('a session cannot message itself')
      if (a.to !== 'user' && !sessions.get(String(a.to))) throw new Error(`no session "${a.to}"`)
      return say(caller, String(a.to), a.text, a.to === 'user' ? 'reply' : 'send_message', a.in_reply_to, await importAll(a.files))
    case 'list_sessions':
      return sessions.all().map(s => ({
        name: s.name, role: s.role, status: s.status, cwd: s.cwd, connected: Boolean(s.channel_connected), you: s.name === caller,
      }))
    case 'search_history':
      return searchAll(String(a.query ?? ''), { session: a.session, since: a.since, limit: a.limit })
    case 'get_thread': {
      const name = a.session ?? caller
      return messages.thread(name, { before: a.before, limit: Math.min(a.limit ?? 30, 200) })
        .map(m => ({ id: m.id, ts: m.ts, from: m.from_name, to: m.to_name, body: m.body }))
    }
    case 'spawn_session': {
      if (!validName(String(a.name))) throw new Error('name must be lowercase letters, digits, - or _ (up to 32 characters)')
      if (sessions.get(a.name) && (await mux.alive(a.name))) throw new Error(`"${a.name}" is already running`)
      await startSession(a.name, { cwd: a.cwd, role: 'worker' })
      if (a.initial_prompt) sendMessage({ from: caller, to: a.name, body: a.initial_prompt, source: 'send_message' })
      return { started: a.name, note: 'It takes a few seconds to become ready. Messages sent now are queued and delivered once it is.' }
    }
    case 'stop_session':
      if (a.name === caller) throw new Error('refusing to stop yourself')
      await stopSession(a.name)
      return { stopped: a.name }
    case 'restart_session':
      if (a.name === caller) throw new Error('refusing to restart yourself')
      await restartSession(a.name)
      return { restarted: a.name }
    case 'read_screen':
      return { screen: await mux.capture(String(a.name), Math.min(a.lines ?? 0, 2000)) }
    case 'wait_for': {
      const until = a.until === 'done' ? ['idle'] : a.until === 'exited' ? ['exited', 'stopped'] : [String(a.until ?? 'idle')]
      const status = await waitFor(String(a.name), until, Math.min(a.timeout_s ?? 300, 3600) * 1000)
      return { name: a.name, status }
    }
    default:
      throw new Error(`unknown tool ${tool}`)
  }
}

/** Copy files a session attached into storage. */
async function importAll(paths: unknown): Promise<number[]> {
  if (paths === undefined || paths === null) return []
  const list = Array.isArray(paths) ? paths : [paths]
  if (list.length > 10) throw new Error('attach at most 10 files per message')
  const ids: number[] = []
  for (const p of list) ids.push((await importFile(String(p))).id)
  return ids
}

function say(from: string, to: string, text: unknown, source: string, inReplyTo: unknown, attachments: number[] = []) {
  const replyTo = Number(inReplyTo) || null
  const m = sendMessage({ from, to, body: String(text ?? ''), source, in_reply_to: replyTo, attachments })
  const turn = turns.get(from)
  if (turn && to === 'user') turn.replied = true
  // Answering a message is the strongest evidence it was delivered.
  if (replyTo) ack(replyTo, 'reply')
  return to === 'user' ? { sent: true, id: m.id } : { queued: true, id: m.id, delivery: m.delivery }
}
