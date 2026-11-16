// Session health. When a session goes down, Neural works out why (a crash, or a broken Claude Code install),
// shows that in the app with whether it is bringing the session back, and tells the orchestrator, which looks
// after the other sessions: one message when something goes wrong, one if it keeps going wrong or Neural gives
// up, and one when the session is healthy again.
//
// A broken install is checked for before every start (`claude --version`), so it is reported as the cause
// instead of burning restart attempts on a program that cannot run. Neural never repairs the install itself:
// it says what is wrong and how to fix it, and restarts the sessions by itself once Claude Code runs again.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config } from './config.ts'
import { sessions, events, type Session } from './db.ts'
import { bus, channels } from './live.ts'
import { notify } from './push.ts'

/** Why a session is down, kept on its row (as JSON) for the app. */
export interface Down {
  /** crash: it exited and Neural restarts it; install: Claude Code can't run; gave-up: crashed too often */
  kind: 'crash' | 'install' | 'gave-up'
  reason: string
  hint?: string
  /** When Neural tries again by itself; null when it doesn't (install: once Claude Code works again). */
  retry_at: string | null
  attempt?: number
  max?: number
  since: string
}

export function downOf(s: Session | undefined): Down | null {
  if (!s?.down) return null
  try {
    return JSON.parse(s.down)
  } catch {
    return null
  }
}

export function setDown(name: string, down: Down | null) {
  sessions.update(name, { down: down ? JSON.stringify(down) : null })
}

// ---------------------------------------------------------------------------------------------
// Checking that Claude Code can run.

export type ClaudeCheck = { ok: true; version: string } | { ok: false; reason: string; hint: string }

let last: { key: string; at: number; result: ClaudeCheck } | null = null
const GOOD_FOR = 10 * 60_000
const BAD_FOR = 20_000

/** The program's identity on disk: a reinstall or chmod changes it, so the cached result is checked again. */
function fileKey(bin: string) {
  const real = fs.realpathSync(bin)
  const st = fs.statSync(real)
  return `${real}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`
}

/** Can `bin` run? A good result is reused for a while unless the file changes; `fresh` checks again regardless. */
export async function checkClaude(bin: string | null, opts: { fresh?: boolean } = {}): Promise<ClaudeCheck> {
  if (!bin) {
    return { ok: false, reason: `can't find the claude program (${config.claudeBin})`, hint: 'Install Claude Code, or set NEURAL_CLAUDE_BIN to its full path.' }
  }
  let key: string
  try {
    key = fileKey(bin)
  } catch {
    return { ok: false, reason: `${bin} points to a file that doesn't exist`, hint: installHint(bin) }
  }
  if (!opts.fresh && last && last.key === key && Date.now() - last.at < (last.result.ok ? GOOD_FOR : BAD_FOR)) return last.result
  const result = await probe(bin)
  last = { key, at: Date.now(), result }
  return result
}

const firstLine = (s: unknown) => String(s ?? '').trim().split('\n').find(l => l.trim())?.trim().slice(0, 200) ?? ''

function probe(bin: string): Promise<ClaudeCheck> {
  try {
    fs.accessSync(bin, fs.constants.X_OK)
  } catch {
    return Promise.resolve({ ok: false, reason: `${bin} is not executable`, hint: installHint(bin) })
  }
  return new Promise(resolve => {
    execFile(bin, ['--version'], { timeout: 20_000, maxBuffer: 2 ** 20 }, (err: any, stdout, stderr) => {
      if (!err) return resolve({ ok: true, version: firstLine(stdout) || 'unknown version' })
      const said = firstLine(stderr) || firstLine(stdout)
      const how = typeof err.code === 'string' ? `couldn't be run (${err.code})`
        : err.killed && err.signal === 'SIGTERM' ? 'did not answer within 20s'
          : err.signal ? `was killed by ${err.signal}${err.signal === 'SIGKILL' ? ' (macOS does that to a damaged or half-downloaded program)' : ''}`
            : `exited with status ${err.code}`
      resolve({ ok: false, reason: `\`claude --version\` ${how}${said ? `: "${said}"` : ''}`, hint: installHint(bin) })
    })
  })
}

/** How to fix the install, including the trace an npm update that failed partway leaves behind. */
export function installHint(bin: string): string {
  const fix = 'Reinstall Claude Code with `npm install -g @anthropic-ai/claude-code` (or `claude install` for the native build).'
  let target = bin
  try {
    target = fs.realpathSync(bin)
  } catch {
    try {
      target = path.resolve(path.dirname(bin), fs.readlinkSync(bin)) // a dangling link still says where it pointed
    } catch {
      // not a link
    }
  }
  const at = target.indexOf('/node_modules/@anthropic-ai/')
  const scope = at !== -1 ? target.slice(0, at + '/node_modules/@anthropic-ai'.length) : path.join(path.dirname(path.dirname(bin)), 'lib/node_modules/@anthropic-ai')
  let leftover: string | undefined
  try {
    leftover = fs.readdirSync(scope).find(f => /^\.claude-code-/.test(f))
  } catch {
    // not an npm install
  }
  if (!leftover) return fix
  // npm moves the old copy aside under a temporary name while it updates; when the update fails partway (an
  // ENOTEMPTY error), the package is left broken and the complete old copy is still there.
  return `An npm update seems to have failed partway: the previous install is still in ${path.join(scope, leftover)}. ${fix} `
    + `If npm fails with ENOTEMPTY, move ${path.join(scope, 'claude-code')} aside and rename ${leftover} to claude-code.`
}

// ---------------------------------------------------------------------------------------------
// Why a session exited.

const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' }

/** The screen's last lines, without tmux's own "Pane is dead" line. */
export function tail(screen: string, lines = 12) {
  return screen.split('\n').filter(l => l.trim() && !/^Pane is dead/.test(l.trim())).slice(-lines).join('\n')
}

/** Does the way it ended point at the program itself (not found, not executable, not installed)? */
export function looksLikeInstall(screen: string, code: number | null) {
  return code === 126 || code === 127
    || /permission denied|command not found|no such file or directory|native binary not installed|cannot execute|bad cpu type/i.test(tail(screen, 4))
}

/** One line on how the process ended. */
export function exitReason(exit: { code: number | null; signal: number | null } | null, screen: string): string {
  const said = tail(screen, 1).trim().slice(0, 200)
  if (!exit) return 'its terminal is gone (the terminal server stopped, or the Mac restarted)'
  const how = exit.signal ? `it was killed by ${SIGNALS[exit.signal] ?? `signal ${exit.signal}`}`
    : exit.code === null ? 'it exited'
      : exit.code === 0 ? 'Claude Code quit'
        : `it exited with status ${exit.code}`
  return said ? `${how}: "${said}"` : how
}

// ---------------------------------------------------------------------------------------------
// Telling the orchestrator. One incident per session, from the first sign of trouble until it has been healthy
// for a while; within it, each kind of news is sent once.

interface Incident { since: number; told: Set<string>; quiet: boolean; reason: string; crashes: number }
const incidents = new Map<string, Incident>()
/** When each session's channel last connected: "healthy again" means connected and settled for a while. */
const upSince = new Map<string, number>()
/** One message for a broken install, however many sessions it stops. */
let installTold: string | null = null
const startedAt = Date.now()

const quote = (text: string) => (text.trim() ? '\n```\n' + text.replace(/```/g, "'''") + '\n```' : '')
const inSecs = (iso: string | null | undefined) => (iso ? Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 1000)) : 0)

async function send(to: string, body: string) {
  const { sendMessage } = await import('./router.ts')
  sendMessage({ from: 'neural', to, body, source: 'health' })
}

async function tell(about: string, body: string) {
  for (const o of sessions.all()) {
    // A message to an orchestrator that is down waits in its queue and arrives once it's back.
    if (o.role !== 'orchestrator' || o.name === about || o.status === 'stopped') continue
    try {
      await send(o.name, body)
    } catch (e) {
      events.add(o.name, 'health-message-failed', { about, error: String(e) })
    }
  }
}

/** Is someone looking after this session (an orchestrator, other than itself, that is up)? */
export function watched(name: string) {
  return sessions.all().some(o => o.role === 'orchestrator' && o.name !== name && channels.has(o.name))
}

function open(name: string, reason: string, quiet = false): Incident {
  let i = incidents.get(name)
  if (!i) {
    i = { since: Date.now(), told: new Set(), quiet, reason, crashes: 0 }
    incidents.set(name, i)
  }
  upSince.delete(name)
  return i
}

/** The session's process ended without being asked to. `down` is what Neural does about it. */
export function exited(s: Session, down: Down, screen: string, exit: { code: number | null; signal: number | null } | null) {
  // Right after the hub starts, sessions whose terminals are gone are just being brought back (after a reboot,
  // say): nothing to report unless that fails.
  const quiet = !exit && Date.now() - startedAt < 120_000
  const i = open(s.name, down.reason, quiet)
  i.crashes++
  i.reason = down.reason
  events.add(s.name, 'health', { kind: down.kind, reason: down.reason })
  if (down.kind === 'install') return installBroken(s, down)
  if (down.kind === 'gave-up') return gaveUp(s, down, screen)
  if (i.quiet) return
  const retry = down.retry_at ? `Neural restarts it in ${inSecs(down.retry_at)}s (attempt ${down.attempt} of ${down.max}).` : 'Neural is not restarting it by itself (autostart is off).'
  if (!i.told.has('exited')) {
    i.told.add('exited')
    return void tell(s.name, `**${s.name} stopped unexpectedly**: ${down.reason}.\n${retry}${quote(tail(screen, 6))}`)
  }
  if (i.crashes >= 2 && !i.told.has('again')) {
    i.told.add('again')
    return void tell(s.name, `**${s.name} crashed again** soon after restarting: ${down.reason}.\nNeural keeps trying, waiting longer each time. ${retry}`)
  }
}

export function gaveUp(s: Session, down: Down, screen = '') {
  const i = open(s.name, down.reason)
  i.reason = down.reason
  if (i.told.has('gave-up')) return
  i.told.add('gave-up')
  i.quiet = false
  void tell(s.name, `**Neural gave up restarting ${s.name}**: ${down.reason}. Look at its terminal with read_screen, fix the cause if you can, then restart_session to try again.${quote(tail(screen, 8))}`)
  void notify({ title: `${s.name} keeps crashing`, body: `Neural stopped restarting it: ${down.reason}`, session: s.name, tag: `trouble-${s.name}` })
}

/** Claude Code can't run, so the session can't start; it waits until Claude Code works again. */
export function installBroken(s: Session, down: Down) {
  const i = open(s.name, down.reason)
  i.reason = down.reason
  i.quiet = false
  i.told.add('install')
  if (installTold === down.reason) return
  installTold = down.reason
  void tell(s.name, `**Claude Code's install is broken**, so ${s.name} can't start: ${down.reason}.\n${down.hint ?? ''}\n`
    + `Neural doesn't spend restart attempts on it. Once \`claude --version\` works again, it restarts the sessions waiting on it by itself. The fix changes the global install, so check with the user first.`)
  void notify({ title: 'Claude Code is broken', body: `${s.name} can't start: ${down.reason}`, session: s.name, tag: 'claude-install' })
}

/** Claude Code runs again. */
export function installFixed() {
  installTold = null
}

/** A status that needs someone (stuck at startup, a failed turn, messages not getting through). */
export function attention(name: string, detail: string | null) {
  const s = sessions.get(name)
  if (!s) return
  const i = open(name, detail ?? 'needs attention')
  if (i.told.has('attention')) return
  i.told.add('attention')
  i.quiet = false
  void tell(name, `**${name} needs attention**: ${(detail ?? 'no details').trim()}`.slice(0, 1500))
}

/** The channel connected: the session is up. */
export function connected(name: string) {
  upSince.set(name, Date.now())
}

/** On the reconcile timer, for a running session: after an incident, say once it has been healthy for a while. */
export function checkRecovered(s: Session) {
  const i = incidents.get(s.name)
  if (!i) return
  const up = upSince.get(s.name)
  if (!up || !s.channel_connected || !['idle', 'working', 'blocked'].includes(s.status)) return
  if (Date.now() - up < config.recoveredAfterMs) return
  incidents.delete(s.name)
  events.add(s.name, 'recovered', { down_ms: Date.now() - i.since })
  if (i.quiet || !i.told.size) return
  const secs = Math.max(1, Math.round((up - i.since) / 1000))
  const took = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`
  const restarts = s.restarts ? ` after ${s.restarts} restart${s.restarts === 1 ? '' : 's'}` : ''
  const body = `**${s.name} is healthy again**${restarts} (down for ${took}; it was: ${i.reason}).`
  if (s.role === 'orchestrator') {
    // It was the one that was down: let it know what happened, now that it can read it.
    void send(s.name, `**You are healthy again**${restarts} (down for ${took}; it was: ${i.reason}). Neural restarted you and resumed your conversation.`).catch(() => {})
  }
  void tell(s.name, body)
}

/** Stopped or removed on purpose: whatever was wrong is no longer news. */
export function forget(name: string) {
  incidents.delete(name)
  upSince.delete(name)
}

bus.on('trouble', (name: string, status: string, detail: string | null) => {
  if (status === 'attention') attention(name, detail)
})
