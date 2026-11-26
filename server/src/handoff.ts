// Fresh-context handoffs. A long-running session's context fills up, and Claude Code then compacts it into a
// summary, losing detail without warning. Instead, when the context passes a threshold (60% or 150K tokens,
// whichever comes first, by default), Neural asks the session to bring a state file up to date (the orchestrator's STATE.md, or a handoff note for a
// worker), and once it has and is quiet, restarts it fresh, not resumed, so it starts from its instructions and
// that file. On by default for the orchestrator; workers can opt in. It can also be started by hand.
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { sessions, outbox, messages, questions, permissions, prefs, usage as usageStore, events, type Session } from './db.ts'
import { activity, sessionChanged } from './live.ts'

interface State { asked_at: number; mtime: number; reminded?: boolean; manual?: boolean; told?: boolean }
const key = (name: string) => `handoff:${name}`
const stateOf = (name: string) => prefs.get<State>(key(name))
const setState = (name: string, st: State | null) => prefs.set(key(name), st)

export const enabled = (s: Session) => (s.handoff ?? (s.role === 'orchestrator' ? 1 : 0)) === 1

/** Where the session keeps its state: STATE.md in the orchestrator's folder, else a note in Neural's uploads
 *  folder (which every session can read and write without asking). */
export function stateFile(s: Session) {
  return s.role === 'orchestrator' ? path.join(s.cwd, 'STATE.md') : path.join(config.uploadsDir, 'handoff', `${s.name}.md`)
}

const mtime = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

async function send(to: string, body: string) {
  const { sendMessage } = await import('./router.ts')
  sendMessage({ from: 'neural', to, body, source: 'handoff' })
}

/** When the session should hand off: its own threshold (percent or tokens), else its role's default. */
export function threshold(s: Session): { percent: number | null; tokens: number | null } {
  if (s.handoff_at != null || s.handoff_tokens != null) return { percent: s.handoff_at, tokens: s.handoff_tokens }
  const orch = s.role === 'orchestrator'
  return {
    percent: (orch ? config.handoffAt : config.handoffWorkerAt) || null,
    tokens: (orch ? config.handoffTokens : config.handoffWorkerTokens) || null,
  }
}

/** A context reading came in: past the threshold, ask once for the handoff. */
export function onContext(name: string, used: number | null, size: number | null = null) {
  const s = sessions.get(name)
  if (!s || used == null || !config.handoffAt || !enabled(s) || stateOf(name)) return
  const t = threshold(s)
  const tokens = size ? (used / 100) * size : null
  if ((t.percent && used >= t.percent) || (t.tokens && tokens != null && tokens >= t.tokens)) void ask(s, false, tokens)
}

/** A state file the fresh session reads in full should stay small; past about 8K tokens, ask for history to be
 *  archived. Tokens are estimated at 4 bytes each. */
const ARCHIVE_TOKENS = 8000
export function sizeNote(file: string) {
  let bytes = 0
  try { bytes = fs.statSync(file).size } catch { return '' }
  const tokens = Math.round(bytes / 4)
  if (tokens <= ARCHIVE_TOKENS) return ''
  const archive = file.replace(/(\.md)?$/, '-archive.md')
  return `It is about ${Math.round(tokens / 1000)}K tokens now, and a fresh session reads all of it: move finished work, `
    + `old logs and settled history into ${archive} (append; nothing needs to read it) to bring it under about `
    + `${ARCHIVE_TOKENS / 1000}K. `
}

/** Ask the session to write down its state; the restart follows once it has (see check). */
export async function ask(s: Session, manual: boolean, tokens: number | null = null) {
  const st = stateOf(s.name)
  if (st) {
    // Asked again by hand while one is pending: push it through now if only soft things hold it up.
    const waiting = manual ? await check(s, true) : null
    if (!stateOf(s.name)) return { restarted: true, file: stateFile(s) }
    return { already: true, pending_min: Math.round((Date.now() - st.asked_at) / 60_000), waiting_on: waiting ?? undefined }
  }
  const file = stateFile(s)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  setState(s.name, { asked_at: Date.now(), mtime: mtime(file), manual })
  events.add(s.name, 'handoff-asked', { file, manual })
  const used = sessionsContext(s.name)
  const why = manual ? 'A fresh context was asked for.'
    : `Your context is ${used != null ? `${used}% full` : 'filling up'}${tokens ? ` (about ${Math.round(tokens / 1000)}K tokens, re-read on every turn)` : ''}.`
  await send(s.name, `**Time for a fresh context.** ${why} Bring ${file} up to date so a fresh session can carry on from it: `
    + `what is running and where each piece of work stands, decisions made and why, open questions, and next steps. `
    + sizeNote(file)
    + `When it's saved and you have nothing in progress, end your turn. Neural then restarts you with a fresh context `
    + `(not resumed) and you start from your instructions and that file. Keep the file accurate; it is all you will have.`)
  sessionChanged(s.name)
  return { asked: true, file }
}

/** When the session last started a turn (persisted, so it survives a hub restart). */
const lastPromptAt = (name: string) => {
  const e = events.recent(name, 200).find(e => e.event === 'hook:UserPromptSubmit')
  return e ? Date.parse(e.ts) : 0
}

const tellMain = async (about: string, body: string) => (await import('./health.ts')).tell(about, body, true)
const restarting = new Set<string>()

/** On the reconcile timer, for a running session that was asked: restart it fresh once the file is updated and
 *  nothing would be interrupted. A saved handoff stuck idle past handoffStuckMs (or forced by hand) restarts past
 *  the soft holds; a non-idle session or background work always waits. Returns what it is waiting on, or null. */
export async function check(s: Session, force = false): Promise<string | null> {
  const st = stateOf(s.name)
  if (!st || restarting.has(s.name)) return null
  const file = stateFile(s)
  const quietFor = Date.now() - Math.max(activity.get(s.name) ?? 0, Date.parse(s.updated_at))
  const saved = mtime(file)
  // A turn that started after the save may have changed what the file should say: wait for a new save.
  if (saved > st.mtime && lastPromptAt(s.name) > saved + 1000) {
    setState(s.name, { ...st, mtime: saved, asked_at: Date.now(), reminded: false })
    return 'its handoff file, saved again after later work'
  }
  if (saved <= st.mtime) {
    // Asked a while ago and idle since, but nothing written: one reminder, then the orchestrator is told; never a
    // restart without it.
    const idleLong = s.status === 'idle' && quietFor > 5 * 60_000
    if (!st.reminded && idleLong && Date.now() - st.asked_at > 10 * 60_000) {
      setState(s.name, { ...st, reminded: true })
      await send(s.name, `Reminder: Neural is waiting for ${file} to be updated before restarting you with a fresh context. Update it, then end your turn.`)
    } else if (st.reminded && !st.told && idleLong && Date.now() - st.asked_at > 20 * 60_000) {
      setState(s.name, { ...st, told: true })
      await tellMain(s.name, `${s.name}'s fresh-context restart has waited ${Math.round((Date.now() - st.asked_at) / 60_000)} min: it hasn't updated ${file}. It is idle.`)
    }
    return 'its handoff file to be updated'
  }
  // Hard holds: never restart through these.
  const { mux, freshStart, backgroundWork } = await import('./spawner.ts')
  const hard = s.status !== 'idle' ? `it is ${s.status}` : !s.channel_connected ? 'its channel is down' : await backgroundWork(s)
  // Soft holds: they only delay it. Quiet messages (fyi, acks) wait for the next real message, which the
  // restart notice is, so they don't hold it up.
  const real = [...outbox.pending(s.name), ...outbox.pushed(s.name)].some(r => !quietMessage(r.message_id))
  const soft = hard ? null
    : quietFor < config.handoffIdleMs ? 'a quiet moment'
    : real ? 'a message being delivered'
    : questions.openFor(s.name).length || permissions.open().some(p => p.session === s.name) ? 'an open question'
    : (await mux.attached(s.name)) ? 'someone watching its terminal'
    : null
  const stuck = s.status === 'idle' && Date.now() - Math.max(saved, Date.parse(s.updated_at)) > config.handoffStuckMs
  if (hard || (soft && !stuck && !force)) {
    if (hard && stuck && !st.told) {
      setState(s.name, { ...st, told: true })
      await tellMain(s.name, `${s.name}'s fresh-context restart is waiting on ${hard}. It restarts once that's done.`)
    }
    return hard || soft
  }
  restarting.add(s.name)
  try {
    setState(s.name, null)
    usageStore.remove(s.name) // the old context reading would ask again straight away
    events.add(s.name, 'handoff', { file, ...(soft ? { forced: soft } : {}) })
    await freshStart(s.name)
    await send(s.name, `You were restarted with a fresh context (not resumed) to keep you sharp. Read ${file} first: it is where you left off. Then carry on.`)
    if (soft && !force) await tellMain(s.name, `Restarted ${s.name} with a fresh context: its saved handoff had waited over ${Math.round(config.handoffStuckMs / 60_000)} min on ${soft}.`)
  } finally {
    restarting.delete(s.name)
  }
  return null
}

const quietMessage = (id: number) => {
  try {
    return Boolean(JSON.parse(messages.get(id)?.meta ?? 'null')?.quiet)
  } catch {
    return false
  }
}

const sessionsContext = (name: string) => usageStore.get<{ used: number | null }>(name)?.used ?? null

/** Turn handoffs on or off for a session (null: the default for its role), and optionally set its threshold:
 *  a context percent, or a token count (0 clears it, back to the default). */
export function setEnabled(name: string, on: boolean | null, at?: { percent?: unknown; tokens?: unknown }) {
  if (!sessions.get(name)) throw new Error(`no session "${name}"`)
  const fields: Partial<Session> = { handoff: on === null ? null : on ? 1 : 0 }
  if (at?.percent !== undefined) {
    const p = Number(at.percent)
    if (!Number.isFinite(p) || p < 0 || p > 95) throw new Error('at_percent must be between 5 and 95 (0 for the default)')
    if (p && p < 5) throw new Error('at_percent must be between 5 and 95 (0 for the default)')
    fields.handoff_at = p ? Math.round(p) : null
    if (p) fields.handoff_tokens = null
  }
  if (at?.tokens !== undefined) {
    const t = Number(at.tokens)
    if (!Number.isFinite(t) || t < 0 || (t && t < 20_000)) throw new Error('at_tokens must be at least 20000 (0 for the default)')
    fields.handoff_tokens = t ? Math.round(t) : null
    if (t) fields.handoff_at = null
  }
  sessions.update(name, fields)
  if (!on) setState(name, null)
  sessionChanged(name)
}

export const pending = (name: string) => Boolean(stateOf(name))
export const forget = (name: string) => setState(name, null)
