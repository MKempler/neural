// Fresh-context handoffs. A long-running session's context fills up, and Claude Code then compacts it into a
// summary, losing detail without warning. Instead, when the context passes a threshold (60% or 150K tokens,
// whichever comes first, by default), Neural asks the session to bring a state file up to date (the orchestrator's STATE.md, or a handoff note for a
// worker), and once it has and is quiet, restarts it fresh, not resumed, so it starts from its instructions and
// that file. On by default for the orchestrator; workers can opt in. It can also be started by hand.
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { sessions, outbox, questions, permissions, prefs, usage as usageStore, events, type Session } from './db.ts'
import { activity, sessionChanged } from './live.ts'

interface State { asked_at: number; mtime: number; reminded?: boolean; manual?: boolean }
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

/** Ask the session to write down its state; the restart follows once it has (see check). */
export async function ask(s: Session, manual: boolean, tokens: number | null = null) {
  if (stateOf(s.name)) return { already: true }
  const file = stateFile(s)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  setState(s.name, { asked_at: Date.now(), mtime: mtime(file), manual })
  events.add(s.name, 'handoff-asked', { file, manual })
  const used = sessionsContext(s.name)
  const why = manual ? 'A fresh context was asked for.'
    : `Your context is ${used != null ? `${used}% full` : 'filling up'}${tokens ? ` (about ${Math.round(tokens / 1000)}K tokens, re-read on every turn)` : ''}.`
  await send(s.name, `**Time for a fresh context.** ${why} Bring ${file} up to date so a fresh session can carry on from it: `
    + `what is running and where each piece of work stands, decisions made and why, open questions, and next steps. `
    + `When it's saved and you have nothing in progress, end your turn. Neural then restarts you with a fresh context `
    + `(not resumed) and you start from your instructions and that file. Keep the file accurate; it is all you will have.`)
  sessionChanged(s.name)
  return { asked: true, file }
}

/** On the reconcile timer, for a running session that was asked: restart it fresh once the file is updated and
 *  nothing would be interrupted. */
export async function check(s: Session) {
  const st = stateOf(s.name)
  if (!st) return
  const file = stateFile(s)
  const quietFor = Date.now() - Math.max(activity.get(s.name) ?? 0, Date.parse(s.updated_at))
  const updated = mtime(file) > st.mtime
  if (!updated) {
    // Asked a while ago and idle since, but nothing written: one reminder; never a restart without it.
    if (!st.reminded && s.status === 'idle' && Date.now() - st.asked_at > 10 * 60_000 && quietFor > 5 * 60_000) {
      setState(s.name, { ...st, reminded: true })
      await send(s.name, `Reminder: Neural is waiting for ${file} to be updated before restarting you with a fresh context. Update it, then end your turn.`)
    }
    return
  }
  if (s.status !== 'idle' || !s.channel_connected || quietFor < config.handoffIdleMs) return
  if (outbox.pending(s.name).length || outbox.pushed(s.name).length) return
  if (questions.openFor(s.name).length || permissions.open().some(p => p.session === s.name)) return
  const { mux, freshStart, backgroundWork } = await import('./spawner.ts')
  if (await mux.attached(s.name)) return // someone is looking at its terminal
  if (await backgroundWork(s)) return // a background shell or task would be killed
  setState(s.name, null)
  usageStore.remove(s.name) // the old context reading would ask again straight away
  events.add(s.name, 'handoff', { file })
  await freshStart(s.name)
  await send(s.name, `You were restarted with a fresh context (not resumed) to keep you sharp. Read ${file} first: it is where you left off. Then carry on.`)
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
