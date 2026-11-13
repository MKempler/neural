import { config } from './config.ts'
import { sessions, messages, outbox, events, permissions, questions, type Message } from './db.ts'
import { Driver, type PlanAnswer, type QuestionAnswer } from './dialogs.ts'
import { redact } from './redact.ts'
import { searchAll } from './embed.ts'
import { broadcast, channels, sendToChannel, setStatus, sessionChanged, turns, activity, setDoing } from './live.ts'
import { notify } from './push.ts'
import { claimFor, checkUnclaimed, describeForClaude, forMessages, importFile, summary } from './files.ts'
import { mux, startSession, stopSession, restartSession, waitFor, markHealthy, validName, claudeAgent } from './spawner.ts'
import * as projects from './projects.ts'
import { snapshot, recap, type Snapshot } from './git.ts'

const MAX_ATTEMPTS = 4
/** Message bodies as written, before redaction, until they are delivered. */
const original = new Map<number, string>()
const bodyFor = (m: Message) => original.get(m.id) ?? m.body

// ---------------------------------------------------------------------------------------------
// Sending: every message is stored first, then delivered.

export function sendMessage(m: { from: string; to: string; body: string; source: string; in_reply_to?: number | null; attachments?: number[]; client_key?: string | null }): Message {
  const body = m.body.trim()
  const files = [...new Set((m.attachments ?? []).map(Number))]
  if (!body && !files.length) throw new Error('empty message')
  if (m.to !== 'user' && !sessions.get(m.to)) throw new Error(`no session "${m.to}"`)
  checkUnclaimed(files)
  // A new message gives the session something to do after a usage limit, so it needs no nudge to carry on.
  if (m.to !== 'user') resumeDue.delete(m.to)
  // Secrets are kept out of the archive. A session the message is for still gets the original, held in memory
  // until it has been delivered (so after a hub restart it gets the redacted text).
  const safe = redact(body)
  const stored = messages.insert({
    from: m.from, to: m.to, body: safe.text, source: m.source, in_reply_to: m.in_reply_to, client_key: m.client_key,
    meta: safe.found.length ? { redacted: safe.found } : undefined,
  })
  if (safe.found.length && m.to !== 'user') original.set(stored.id, body)
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
      original.delete(row.message_id)
      outbox.markFailed(row.message_id, 'gave up after repeated delivery attempts')
      delivery(row.message_id)
      continue
    }
    const from = msg.from_name === 'user' || msg.from_name === 'system' ? msg.from_name : `session:${msg.from_name}`
    const ok = sendToChannel(target, { type: 'push', msg_id: String(msg.id), from, ts: msg.ts, body: forClaude(msg.id, bodyFor(msg)) })
    if (!ok) return
    outbox.markPushed(msg.id, 'channel')
    delivery(msg.id)
    // Neural's own messages (such as "carry on after the limit") continue the user's work, so they count as theirs.
    beginTurnIfIdle(target, msg.from_name === 'user' || msg.from_name === 'system')
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
  original.delete(messageId)
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
  // Working again after a usage limit (Claude Code's own auto-continue, or a prompt typed at the terminal).
  if (event === 'PreToolUse' || event === 'UserPromptSubmit') resumeDue.delete(name)
  noteModel(name, event === 'PostModelSwitch' ? payload?.to_model : payload?.model, payload?.effort?.level ?? payload?.effort)
  if (event === 'PreToolUse') {
    // Tool calls after a pause (the usage limit reset, or work started at the terminal) mean it's working again.
    if (['idle', 'limited', 'attention'].includes(s.status)) {
      if (!turns.has(name)) turns.set(name, { startedAt: Date.now(), replied: false, forUser: true })
      setStatus(name, 'working')
    }
    setDoing(name, describeTool(String(payload?.tool_name ?? ''), payload?.tool_input ?? {}))
    // A question or plan for the user; any other tool means an earlier one was answered (in the terminal, say).
    const tool = String(payload?.tool_name ?? '')
    if (ASKS[tool]) questionAsked(name, ASKS[tool], payload)
    else closeQuestions(name)
    return
  }
  if (event === 'PostToolUse') {
    // Heartbeat, and the end of a question: answered, here or in the terminal.
    if (closeQuestions(name) && sessions.get(name)?.status === 'blocked') setStatus(name, 'working')
    return
  }
  events.add(name, `hook:${event}`, payload)

  if (payload?.session_id && (payload.session_id !== s.claude_session_id || payload.transcript_path !== s.transcript_path)) {
    sessions.update(name, { claude_session_id: payload.session_id, transcript_path: payload.transcript_path ?? null })
    sessionChanged(name)
  }

  // A new prompt, the end of the turn or of the process: no dialog is open any more.
  if (['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionStart', 'SessionEnd'].includes(event)) closeQuestions(name)

  switch (event) {
    case 'SessionStart':
      recapFrom.delete(name) // a new process: any turn the old one was in is over
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
      setDoing(name, 'Thinking')
      startRecap(name)
      break
    }
    case 'Notification':
      // Claude is waiting on the user: a permission prompt or a question in the terminal.
      if (/permission|needs your|waiting for (your )?input|approval/i.test(String(payload?.message ?? ''))) {
        if (s.status === 'working') setStatus(name, 'blocked', String(payload.message))
      }
      break
    case 'Stop':
      setDoing(name, null)
      onTurnEnd(name, payload)
      void finishRecap(name)
      break
    case 'StopFailure':
      turnFailed(name, String(payload?.error?.message ?? payload?.error_message ?? payload?.message ?? payload?.error ?? 'The turn ended with an error'),
        String(payload?.error?.type ?? payload?.error_type ?? payload?.reason ?? ''))
      void finishRecap(name) // work done before the failure still counts
      break
    case 'SessionEnd':
      // The user quit Claude in its terminal: treat that as a deliberate stop, not a crash to recover from.
      setDoing(name, null)
      if (['prompt_input_exit', 'logout'].includes(payload?.reason)) {
        permissions.expire(name)
        setStatus(name, 'stopped', 'Exited from the terminal')
      }
      break
  }
}

/** Remember the model and effort level a session reports (hooks, transcripts) and tell the app when they change. */
export function noteModel(name: string, model: unknown, effort: unknown) {
  const s = sessions.get(name)
  if (!s) return
  const fields: { model?: string; effort?: string } = {}
  if (typeof model === 'string' && model && model !== s.model) fields.model = model
  if (typeof effort === 'string' && effort && effort !== s.effort) fields.effort = effort
  if (!Object.keys(fields).length) return
  sessions.update(name, fields)
  sessionChanged(name)
}

// ---------------------------------------------------------------------------------------------
// Slash commands typed in the app run in the session's terminal, as if typed there.

/** "/model sonnet" is a command; "/Users/me/file.txt" (a path) and "//literal" are not. */
export function isCommand(body: string) {
  return /^\/[a-z][\w:-]*(?:\s|$)/i.test(body) && !body.startsWith('//')
}

export async function runCommand(name: string, body: string, clientKey: string | null = null): Promise<Message> {
  const s = sessions.get(name)
  if (!s) throw new Error(`no session "${name}"`)
  if (!(await mux.alive(name))) throw new Error(`${name} isn't running. Start it first, then send the command.`)
  const command = body.trim().split('\n')[0]
  // Inserted before typing: a duplicate retry fails on the unique key here instead of running the command twice.
  const m = messages.insert({ from: 'user', to: name, body: command, source: 'command', client_key: clientKey })
  events.add(name, 'command', { command })
  await mux.type(name, command)
  await new Promise(r => setTimeout(r, 120))
  await mux.sendKeys(name, ['Enter'])
  // /effort takes effect at once; show it now rather than after the next reply.
  const effort = /^\/effort\s+(low|medium|high|xhigh|max)\b/i.exec(command)?.[1]
  if (effort) noteModel(name, null, effort.toLowerCase())
  const fresh = messages.get(m.id)!
  broadcast({ type: 'message', message: fresh })
  return fresh
}

// ---------------------------------------------------------------------------------------------
// Failed turns: the usage limit, or an API error. Claude Code ends these with StopFailure (not Stop) and
// writes the error into the transcript, so either one can report it; the second report is ignored.

const lastFailure = new Map<string, { text: string; at: number }>()

/** "… resets 8:20pm …" → that time today (or tomorrow, if already past when the limit was hit). */
export function resetTime(text: string, from = Date.now()): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text)
  if (!m) return null
  let h = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'pm') h += 12
  const d = new Date(from)
  d.setHours(h, Number(m[2] ?? 0), 0, 0)
  if (d.getTime() < from - 60_000) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export async function turnFailed(name: string, text: string, kind = '') {
  const s = sessions.get(name)
  if (!s) return
  const prev = lastFailure.get(name)
  if (prev && Date.now() - prev.at < 10 * 60_000) {
    // Still stopped on the failure already reported: this is the other source (hook or transcript) telling the
    // same story, usually in different words. One message is enough; keep the text that says when it resets.
    if (['limited', 'attention'].includes(s.status)) {
      if (resetTime(text) && !resetTime(s.status_detail ?? '')) setStatus(name, s.status, text)
      return
    }
    if (prev.text === text) return
  }
  lastFailure.set(name, { text, at: Date.now() })
  setDoing(name, null)
  turns.delete(name)
  const limit = /rate.?limit|usage.?limit/i.test(kind) || /hit your .*limit|usage limit|limit reached/i.test(text)
  setStatus(name, limit ? 'limited' : 'attention', text)
  events.add(name, limit ? 'usage-limit' : 'turn-failed', { text, kind })
  // Claude Code may offer to continue by itself at the reset; say so only if its terminal shows that.
  let screen = ''
  try {
    screen = await mux.capture(name)
  } catch {
    // no terminal to read
  }
  const auto = /continuing automatically/i.test(screen) && !/continue cancelled/i.test(screen)
  const after = limit
    ? auto
      ? 'Claude Code carries on by itself when it resets.'
      : config.autoContinue
        ? 'When it resets, Neural tells the session to carry on with the task.'
        : 'Send a message after it resets and the session picks up where it left off.'
    : 'Send a message to try again.'
  sendMessage({
    from: name, to: 'user', source: 'error',
    body: `**${limit ? 'Usage limit reached.' : 'This turn stopped with an error.'}** ${text}\n\n${after}`,
  })
}

// ---------------------------------------------------------------------------------------------
// After a usage limit resets: a session whose turn was cut off is told to carry on, so long work finishes
// without the user having to notice the reset and type "continue".

/** Sessions whose limit has reset, with when it reset, waiting to be told to carry on. */
const resumeDue = new Map<string, number>()
let lastResume = 0
const RESUME_SPACING_MS = 60_000 // one session at a time, so they don't all spend the fresh window at once
const RESUME_MAX_AGE_MS = 6 * 3600_000 // a limit found long after it reset (hub was down) is stale; leave it

/** The limit reset at `at`: the session can take messages again, and is due a nudge if it stays quiet. */
export function limitReset(name: string, at: number) {
  const s = sessions.get(name)
  if (!s || s.status !== 'limited') return
  setStatus(name, 'idle')
  events.add(name, 'limit-reset', { at: new Date(at).toISOString() })
  // A weekly limit's reset is days away; by then the user may want to choose what runs first.
  const weekly = /week/i.test(s.status_detail ?? '')
  if (config.autoContinue && !weekly && Date.now() - at < RESUME_MAX_AGE_MS) resumeDue.set(name, at)
  flush(name)
}

/** On the reconcile timer: nudge the next session that is still quiet a grace period after its reset. */
export function resumeInterrupted(now = Date.now()) {
  if (now - lastResume < RESUME_SPACING_MS) return
  const due = [...resumeDue.entries()]
    .filter(([, at]) => now - at >= config.resumeGraceMs)
    .map(([name]) => sessions.get(name))
    .filter(s => s != null)
    // The orchestrator first: it may be coordinating the others.
    .sort((a, b) => Number(b.role === 'orchestrator') - Number(a.role === 'orchestrator'))
  for (const s of due) {
    resumeDue.delete(s.name)
    // Busy, gone or stopped since: nothing to resume. A message waiting for it will restart the work instead.
    if (s.status !== 'idle' || !channels.has(s.name) || outbox.pending(s.name).length || outbox.pushed(s.name).length) continue
    lastResume = now
    events.add(s.name, 'auto-continue', null)
    sendMessage({
      from: 'system', to: s.name, source: 'system',
      body: "Your usage limit has reset. Carry on with the task you were working on when the limit was reached, and don't repeat work that is already done. (Sent automatically by Neural.)",
    })
    sendMessage({ from: s.name, to: 'user', source: 'system', body: `**Usage limit reset.** Neural told ${s.name} to carry on with the task it was doing.` })
    return
  }
}

// ---------------------------------------------------------------------------------------------
// Turn recaps: what a turn changed in the session's repository ("2 commits · 5 files · +180 −42"), shown under
// the turn's last reply so the user can see what was done without asking.

const recapFrom = new Map<string, { since: string; snap: Promise<Snapshot | null> }>()

function startRecap(name: string) {
  // A prompt that arrives mid-turn continues the same piece of work: keep the earlier starting point.
  if (recapFrom.has(name)) return
  const s = sessions.get(name)
  if (!s) return
  recapFrom.set(name, { since: new Date().toISOString(), snap: snapshot(s.cwd).catch(() => null) })
}

async function finishRecap(name: string) {
  const start = recapFrom.get(name)
  recapFrom.delete(name)
  if (!start) return
  const snap = await start.snap
  if (!snap) return
  const r = await recap(snap).catch(() => null)
  if (!r) return
  events.add(name, 'turn-recap', r)
  const id = messages.lastToUser(name, start.since)
  if (!id) return
  messages.addMeta(id, { recap: r })
  broadcast({ type: 'message', message: messages.get(id) })
}

// ---------------------------------------------------------------------------------------------
// Is a turn really running? Used when a session has been silent for a while, and after Esc, so a status can't
// stay stuck on "working". Claude Code's own session list says busy or idle; without it, the terminal is read.

export async function settleIfIdle(name: string) {
  const s = sessions.get(name)
  if (!s || s.status !== 'working') return
  const agent = await claudeAgent(s)
  if (agent) {
    if (agent.status !== 'idle') return
  } else if (!(await screenIdle(name))) return
  if (sessions.get(name)?.status !== 'working') return // a hook moved it on meanwhile
  events.add(name, 'settled', { reason: 'no turn running', via: agent ? 'claude agents' : 'screen' })
  setDoing(name, null)
  turns.delete(name)
  setStatus(name, 'idle')
}

/** The terminal shows no turn running: the full footer is there (a phone-width view can cut it off), with
 *  neither "esc to interrupt" nor the spinner's elapsed time ("· Whirlpooling… (5s · ↓ 14 tokens)").
 *  A status line replaces the "esc to interrupt" hint, so the spinner is the sign that counts. */
async function screenIdle(name: string) {
  let screen = ''
  try {
    screen = await mux.capture(name)
  } catch {
    return false
  }
  return /shift\+tab to cycle/i.test(screen) && !/esc to interrupt/i.test(screen) && !/…\s*\(\d+[hms]/.test(screen)
}

const base = (p: unknown) => String(p ?? '').split('/').filter(Boolean).pop() ?? ''
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/** One short line for the live activity display, from a tool call as Claude Code reports it to PreToolUse. */
export function describeTool(tool: string, input: any): string {
  const neural: Record<string, string> = {
    reply: 'Replying', send_message: `Messaging ${input?.to ?? 'a session'}`, list_sessions: 'Checking sessions',
    search_history: 'Searching history', get_thread: 'Reading a conversation', spawn_session: `Starting ${input?.name ?? 'a session'}`,
    stop_session: `Stopping ${input?.name ?? 'a session'}`, restart_session: `Restarting ${input?.name ?? 'a session'}`,
    read_screen: `Looking at ${input?.name ?? 'a terminal'}`, wait_for: `Waiting for ${input?.name ?? 'a session'}`,
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool)
  if (mcp && (mcp[1] === 'neural' || mcp[1] === 'hub')) return neural[mcp[2]] ?? 'Using Neural'
  if (mcp) return `Using ${mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')}`
  switch (tool) {
    case 'Bash':
      return clip(input?.description ? String(input.description) : `Running ${String(input?.command ?? '').split('\n')[0]}`)
    case 'Read': return `Reading ${base(input?.file_path)}`
    case 'Edit': case 'MultiEdit': return `Editing ${base(input?.file_path)}`
    case 'Write': return `Writing ${base(input?.file_path)}`
    case 'NotebookEdit': return `Editing ${base(input?.notebook_path)}`
    case 'Grep': return clip(`Searching for ${input?.pattern ?? 'text'}`)
    case 'Glob': return clip(`Finding ${input?.pattern ?? 'files'}`)
    case 'WebFetch': {
      try { return `Reading ${new URL(String(input?.url)).host}` } catch { return 'Reading a web page' }
    }
    case 'WebSearch': return clip(`Searching the web for ${input?.query ?? ''}`)
    case 'Task': case 'Agent': return clip(input?.description ? String(input.description) : 'Running a subagent')
    case 'TodoWrite': return 'Planning'
    case 'AskUserQuestion': return 'Asking you a question'
    case 'ExitPlanMode': return 'Waiting for you to approve its plan'
    case 'ToolSearch': return 'Loading tools'
    default: return tool ? `Using ${tool}` : 'Working'
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
    // Down, starting, or at its usage limit: hold the message; it goes through when the session can take it.
    if (!s || ['stopped', 'exited', 'starting', 'limited'].includes(s.status)) continue
    // The clock starts when the message could first have been read: when it was pushed, or when the turn
    // it is waiting behind ended. Any hook or tool call since then means the session is busy, not deaf.
    const basis = Math.max(Date.parse(row.pushed_at ?? ''), turns.get(row.target)?.startedAt ?? 0)
    if (Date.now() - basis < config.ackTimeoutSec * 1000) continue
    if ((activity.get(row.target) ?? 0) > basis + 250) continue
    const msg = messages.get(row.message_id)
    if (!msg) continue
    if (row.attempts >= MAX_ATTEMPTS) {
      original.delete(row.message_id)
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
      await mux.paste(row.target, `[Neural message from ${from}, msg_id=${msg.id}; answer with the neural reply tool]\n${forClaude(msg.id, bodyFor(msg))}`)
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
// Questions (AskUserQuestion) and plan approvals (ExitPlanMode), answered from the app.

const ASKS: Record<string, 'question' | 'plan'> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }
const answering = new Set<string>()

function questionAsked(name: string, kind: 'question' | 'plan', payload: any) {
  closeQuestions(name)
  const input = payload?.tool_input ?? {}
  if (kind === 'question' && !(Array.isArray(input.questions) && input.questions.length)) return
  const q = questions.add(name, kind, payload?.tool_use_id ?? null, kind === 'plan' ? { plan: String(input.plan ?? '') } : { questions: input.questions })
  const qs: any[] = input.questions ?? []
  const first = String(qs[0]?.question ?? '')
  setStatus(name, 'blocked', kind === 'plan' ? 'Waiting for you to approve its plan' : `Asking: ${first}`)
  broadcast({ type: 'question', question: q })
  const planLine = String(input.plan ?? '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? ''
  void notify({
    title: kind === 'plan' ? `${name} has a plan for you` : `${name} asks`,
    body: kind === 'plan' ? planLine : first + (qs.length > 1 ? ` (and ${qs.length - 1} more)` : ''),
    session: name, tag: `ask-${name}`,
  })
}

/** Close a session's open questions (answered or gone); returns how many there were. */
export function closeQuestions(name: string): number {
  let n = 0
  for (const q of questions.openFor(name)) {
    if (!questions.close(q.id, 'closed')) continue
    n++
    broadcast({ type: 'question_closed', id: q.id })
  }
  return n
}

/** Answer a question or plan from the app, by typing into the dialog in the session's terminal. */
export async function answerQuestion(id: number, body: any) {
  const q = questions.get(id)
  if (!q || q.state !== 'open') throw new Error('that has already been answered')
  if (answering.has(q.session)) throw new Error('already answering this one')
  answering.add(q.session)
  try {
    const driver = new Driver(mux, q.session)
    if (q.kind === 'plan') {
      const a: PlanAnswer = body?.approve ? { approve: true, manual: body.manual === true } : { approve: false, feedback: String(body?.feedback ?? '') }
      await driver.answerPlan(a)
    } else {
      await driver.answerQuestions(q.payload.questions, body?.answers as QuestionAnswer[])
    }
  } catch (e: any) {
    events.add(q.session, 'answer-failed', { id, error: e.message })
    throw e
  } finally {
    answering.delete(q.session)
  }
  events.add(q.session, 'answered', { id, kind: q.kind })
  if (questions.close(id, 'answered', body)) broadcast({ type: 'question_closed', id, answered: true })
  if (sessions.get(q.session)?.status === 'blocked') setStatus(q.session, 'working')
  return { ok: true }
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
      // A new project or a clone gets its folder in the projects folder first.
      let cwd = a.cwd
      if (a.clone) cwd = (await projects.clone(String(a.clone))).path
      else if (a.new_project) cwd = (await projects.create(String(a.name), { github: a.github_repo === true })).path
      if (!cwd) throw new Error('cwd is required (or new_project, or clone)')
      await startSession(a.name, { cwd, role: 'worker' })
      if (a.initial_prompt) sendMessage({ from: caller, to: a.name, body: a.initial_prompt, source: 'send_message' })
      return { started: a.name, cwd, note: 'It takes a few seconds to become ready. Messages sent now are queued and delivered once it is.' }
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
