import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { ROOT, config, hubUrl, findBin } from './config.ts'
import { sessions, events, permissions, outbox, usage, questions, type Session } from './db.ts'
import { channels, setStatus, sessionChanged, bus, turns, activity, lifecycle, setBackground } from './live.ts'
import { Tmux } from './mux/tmux.ts'
import type { Mux } from './mux/mux.ts'
import * as health from './health.ts'
import * as handoff from './handoff.ts'
import * as worktree from './worktree.ts'

export const mux: Mux = new Tmux(config.tmuxSocket)

// PostToolUse is only a heartbeat: it tells the hub a turn is still making progress.
// PreToolUse feeds the live activity line; PostToolUse is a heartbeat that says a turn is still making progress.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd', 'PreCompact', 'PostModelSwitch', 'StopFailure']
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const RESERVED = new Set(['user', 'system', 'all', 'hub', 'neural'])
const MAX_RESTARTS = 5

export function validName(name: string) {
  return NAME_RE.test(name) && !RESERVED.has(name)
}

let claudePath: string | undefined
function resolveClaude(): string {
  claudePath ??= findBin(config.claudeBin) ?? undefined
  if (!claudePath) throw new Error(`cannot find the claude binary (${config.claudeBin}); set NEURAL_CLAUDE_BIN to its full path`)
  return claudePath
}

/** Can Claude Code run? Checked before every start, so a broken install is named as the cause. */
export async function checkClaude(opts: { fresh?: boolean } = {}) {
  let bin: string | null = null
  try {
    bin = resolveClaude()
  } catch {
    // reported as not found
  }
  return health.checkClaude(bin, opts)
}

/** Throws, with the cause and the fix, when Claude Code can't run. */
export async function ensureClaude() {
  const check = await checkClaude()
  if (!check.ok) throw new Error(`Claude Code's install is broken: ${check.reason}. ${check.hint}`)
}

// Per-session config files: the hub's MCP server and hooks are passed on the command line,
// so nothing is added to the user's global Claude Code settings.
function runConfig(s: Session) {
  const mcpFile = path.join(config.runDir, `${s.name}.mcp.json`)
  const settingsFile = path.join(config.runDir, `${s.name}.settings.json`)
  const mcp = {
    mcpServers: {
      ...extraServers(s),
      neural: {
        command: config.nodeBin,
        args: ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'channel/neural-channel.ts')],
        env: {
          NEURAL_URL: hubUrl,
          NEURAL_SECRET: config.secret,
          NEURAL_SESSION_NAME: s.name,
          NEURAL_ROLE: s.role,
        },
      },
    },
  }
  const hook = (event: string) => ({
    hooks: [{
      type: 'http',
      url: `${hubUrl}/hooks/${event}?session=${encodeURIComponent(s.name)}&secret=${config.secret}`,
      timeout: 5,
    }],
  })
  // The status line feeds the usage and context meter; a status line of the user's own still shows in the terminal.
  const ownFile = path.join(config.runDir, `${s.name}.statusline.sh`)
  const own = ownStatusLine(s.cwd)
  const statusUrl = `${hubUrl}/hooks/statusline?session=${encodeURIComponent(s.name)}&secret=${config.secret}`
  const settings = {
    hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, [hook(e)]])),
    statusLine: { type: 'command', command: ['/bin/sh', path.join(ROOT, 'channel/statusline.sh'), statusUrl, ownFile].map(shellQuote).join(' ') },
  }
  return { mcpFile, settingsFile, mcp, settings, own, ownFile }
}

// Each launch gets a token its channel server presents when it connects. The previous process's channel server
// outlives it for a moment and reconnects; without the token the hub took it for the new process, marked the session
// ready while the new one still sat at a startup dialog, and stopped answering that dialog. Kept out of runConfig, so
// it doesn't change the launch fingerprint.
const launchTokens = new Map<string, string>()
/** The token the session's current process was launched with, if this hub launched it. */
export const launchToken = (name: string) => launchTokens.get(name)

function writeRunFiles(s: Session, token: string) {
  fs.mkdirSync(config.uploadsDir, { recursive: true, mode: 0o700 })
  const c = runConfig(s)
  ;(c.mcp.mcpServers.neural.env as Record<string, string>).NEURAL_LAUNCH = token
  if (c.own) fs.writeFileSync(c.ownFile, c.own + '\n', { mode: 0o600 })
  else fs.rmSync(c.ownFile, { force: true })
  fs.writeFileSync(c.mcpFile, JSON.stringify(c.mcp, null, 2), { mode: 0o600 })
  fs.writeFileSync(c.settingsFile, JSON.stringify(c.settings, null, 2), { mode: 0o600 })
  return c
}

/** A fingerprint of what a session gets at launch: its channel server and settings (hooks, status line), the
 *  flags, and the code of the channel server and status line script, whose changes only reach a session when it
 *  starts. A session launched with a different one is out of date. */
export function launchRev(s: Session): string {
  const { mcp, settings, own } = runConfig(s)
  const h = crypto.createHash('sha256').update(JSON.stringify({ mcp, settings, own, flags: [...FLAGS, ...sessionFlags(s)] }))
  for (const f of ['channel/neural-channel.ts', 'channel/statusline.sh']) h.update(fs.readFileSync(path.join(ROOT, f)))
  // The orchestrator's guide is read at launch too.
  if (s.role === 'orchestrator') {
    try {
      h.update(fs.readFileSync(path.join(s.cwd, 'CLAUDE.md')))
    } catch {
      // no guide
    }
  }
  return h.digest('hex').slice(0, 16)
}

const FLAGS = [
  '--permission-mode', 'auto',
  // Attached files live here; this lets the session open them without asking.
  '--add-dir', config.uploadsDir,
  // Custom channels are not on the research-preview allowlist, so they load through the development flag.
  '--dangerously-load-development-channels', 'server:neural',
]

/** The model and effort chosen for this session, if any. */
function sessionFlags(s: Session) {
  return [...(s.launch_model ? ['--model', s.launch_model] : []), ...(s.launch_effort ? ['--effort', s.launch_effort] : [])]
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// ---------------------------------------------------------------------------------------------
// Extra MCP servers for one session, besides Neural's own: written into its --mcp-config at launch.

const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/

function extraServers(s: Session): Record<string, unknown> {
  try {
    return s.mcp_servers ? JSON.parse(s.mcp_servers) : {}
  } catch {
    return {}
  }
}

/** Check one server's config: a command to run (stdio), or an http/sse URL. */
export function checkServer(name: string, c: any) {
  if (!SERVER_NAME.test(name) || name === 'neural') throw new Error(`bad MCP server name "${name}" (letters, digits, - and _; not "neural")`)
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`MCP server "${name}" needs a config object`)
  const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'))
  const stringMap = (v: unknown) => v === undefined || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string'))
  if (c.type === 'http' || c.type === 'sse') {
    if (typeof c.url !== 'string' || !/^https?:\/\//.test(c.url)) throw new Error(`MCP server "${name}" needs an http(s) url`)
    if (!stringMap(c.headers)) throw new Error(`headers of "${name}" must map names to strings`)
    return { type: c.type, url: c.url, ...(c.headers ? { headers: c.headers } : {}) }
  }
  if (c.type !== undefined && c.type !== 'stdio') throw new Error(`MCP server "${name}": type must be stdio, http or sse`)
  if (typeof c.command !== 'string' || !c.command.trim()) throw new Error(`MCP server "${name}" needs a command (or type http with a url)`)
  if (!strings(c.args)) throw new Error(`args of "${name}" must be a list of strings`)
  if (!stringMap(c.env)) throw new Error(`env of "${name}" must map names to strings`)
  return { command: c.command, ...(c.args ? { args: c.args } : {}), ...(c.env ? { env: c.env } : {}) }
}

/** Merge changes into a session's extra servers (a null config removes that server); returns the new JSON. */
export function mergeServers(current: string | null, changes: unknown): string | null {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('mcp_servers must map server names to configs')
  const next: Record<string, unknown> = (() => {
    try {
      return current ? JSON.parse(current) : {}
    } catch {
      return {}
    }
  })()
  for (const [name, c] of Object.entries(changes as Record<string, unknown>)) {
    if (c === null) delete next[name]
    else next[name] = checkServer(name, c)
  }
  return Object.keys(next).length ? JSON.stringify(next) : null
}

/** Add, change or remove (null) extra MCP servers on a session; it restarts onto them like setLaunch. */
export async function setServers(name: string, changes: unknown) {
  const s = sessions.get(name)
  if (!s) throw new Error(`no session "${name}"`)
  return applyLaunch(name, { mcp_servers: mergeServers(s.mcp_servers, changes) })
}

/** Checked launch_model / launch_effort fields from a request ('' or 'default' clears one). */
export function launchFields(opts: { model?: unknown; effort?: unknown }): Partial<Session> {
  const clear = (v: unknown) => v === '' || v === 'default' || v === null
  const fields: Partial<Session> = {}
  if (opts.model !== undefined) {
    if (!clear(opts.model) && !/^[A-Za-z0-9._\[\]-]{1,64}$/.test(String(opts.model))) throw new Error('model must be an alias like sonnet or opus, or a full model name')
    fields.launch_model = clear(opts.model) ? null : String(opts.model)
  }
  if (opts.effort !== undefined) {
    if (!clear(opts.effort) && !EFFORTS.includes(String(opts.effort))) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`)
    fields.launch_effort = clear(opts.effort) ? null : String(opts.effort)
  }
  return fields
}

/** Choose the model and effort a session starts with ('' or 'default' for Claude Code's default). It takes
 *  effect at the next start: now, if the session is idle; otherwise once it has finished and been idle a
 *  little while (the change makes it out of date, so it is refreshed like after a Neural update). */
export async function setLaunch(name: string, opts: { model?: unknown; effort?: unknown }): Promise<'restarted' | 'when idle' | 'next start'> {
  if (!sessions.get(name)) throw new Error(`no session "${name}"`)
  return applyLaunch(name, launchFields(opts))
}

/** Store launch settings and bring the session onto them: now if idle, else once it is (see setLaunch). */
async function applyLaunch(name: string, fields: Partial<Session>): Promise<'restarted' | 'when idle' | 'next start'> {
  sessions.update(name, fields)
  sessionChanged(name)
  const now = sessions.get(name)!
  if (now.status === 'stopped' || now.status === 'exited') return 'next start'
  if (now.status === 'idle' && now.channel_connected && !(await backgroundWork(now))) {
    await restartSession(name)
    return 'restarted'
  }
  return config.autoRefresh ? 'when idle' : 'next start'
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The status line command the user set up for Claude Code (local project, project, then user settings), if any. */
function ownStatusLine(cwd: string): string | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  for (const file of [path.join(cwd, '.claude/settings.local.json'), path.join(cwd, '.claude/settings.json'), path.join(configDir, 'settings.json')]) {
    try {
      const line = JSON.parse(fs.readFileSync(file, 'utf8'))?.statusLine
      if (line?.type === 'command' && typeof line.command === 'string' && line.command.trim()) return line.command
    } catch {
      // missing or unreadable: try the next
    }
  }
  return null
}

export function launchArgv(s: Session, opts: { resume?: boolean } = {}) {
  const token = crypto.randomUUID()
  launchTokens.set(s.name, token)
  const { mcpFile, settingsFile } = writeRunFiles(s, token)
  const argv = [resolveClaude(), '--name', s.name, '--mcp-config', mcpFile, '--settings', settingsFile, ...FLAGS, ...sessionFlags(s)]
  if (opts.resume && canResume(s)) argv.push('--resume', s.claude_session_id!)
  return argv
}

/** Is there a conversation to resume? Claude Code saves one only from its first prompt, and `--resume` of an id
 *  it never saved exits at once ("No conversation found"), which would turn a session that died before its first
 *  prompt into a crash loop. Without a resume it starts afresh and its queued first prompt is delivered then. */
function canResume(s: Session) {
  if (!s.claude_session_id) return false
  return !s.transcript_path || fs.existsSync(s.transcript_path)
}

export async function startSession(
  name: string,
  opts: { cwd?: string; role?: 'orchestrator' | 'worker'; autostart?: boolean; resume?: boolean; model?: unknown; effort?: unknown; mcpServers?: unknown } = {},
): Promise<Session> {
  const launch = launchFields(opts)
  if (opts.mcpServers !== undefined) launch.mcp_servers = mergeServers(sessions.get(name)?.mcp_servers ?? null, opts.mcpServers)
  if (!validName(name)) throw new Error(`invalid session name "${name}" (lowercase letters, digits, - and _, up to 32 characters)`)
  const existing = sessions.get(name)
  const cwd = opts.cwd ?? existing?.cwd
  if (!cwd) throw new Error('cwd is required for a new session')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    if (cwd.endsWith(path.join('.claude', 'worktrees', name))) throw new Error(`its worktree ${cwd} was removed when it stopped; spawn it again with worktree set to its branch`)
    throw new Error(`cwd does not exist: ${cwd}`)
  }
  if (existing && (await mux.alive(name))) throw new Error(`session "${name}" is already running`)
  await ensureClaude()

  const role = opts.role ?? existing?.role ?? 'worker'
  sessions.create(name, role, cwd, opts.autostart ?? (existing ? Boolean(existing.autostart) : role === 'orchestrator'))
  if (Object.keys(launch).length) sessions.update(name, launch)
  const s = sessions.get(name)!
  turns.delete(name)
  permissions.expire(name)
  // The previous process is dead, but its channel socket can take a moment to close. Drop it now: a message sent
  // in that moment (such as the note that follows a fresh-context restart) would be pushed into it and lost.
  const old = channels.get(name)
  if (old) {
    channels.delete(name)
    old.terminate()
    sessions.update(name, { channel_connected: 0 })
  }
  // Whatever was pushed to the previous process without confirmation goes out again once this one is ready.
  for (const row of outbox.pushed(name)) outbox.requeue(row.message_id, 'session restarted')

  // The channel server negotiates the earlier MCP handshake; newer revisions do not register channels.
  const env: Record<string, string> = { MCP_PROTOCOL_NEGOTIATION: 'legacy' }
  if (config.autoCompactWindow > 0) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(config.autoCompactWindow)
  await mux.spawn(name, cwd, launchArgv(s, { resume: opts.resume }), env)
  sessions.update(name, { launch_rev: launchRev(s) })
  spawnedAt.set(name, Date.now())
  events.add(name, 'spawn', { resume: Boolean(opts.resume && canResume(s)) })
  sessionChanged(name)
  void passStartupDialogs(name)
  return sessions.get(name)!
}

// Startup dialogs Claude Code can show before the session is usable, and the option to pick in each.
const DIALOGS: { name: string; when: RegExp; choose: RegExp }[] = [
  { name: 'development-channels', when: /development channels?|local development/i, choose: /local development/i },
  { name: 'folder-trust', when: /trust (this|the) (folder|files)|Do you trust/i, choose: /^\W*(\d+\.\s*)?Yes/i },
  { name: 'mcp-consent', when: /New MCP server found/i, choose: /Use this MCP server/i },
  // Claude Code 2.1.326 asks before a session may use an --add-dir folder it hasn't worked in. The only one
  // Neural adds is its own uploads folder, so only that one is accepted.
  {
    name: 'add-directory',
    when: new RegExp(`Adding a new directory[\\s\\S]*${path.basename(config.uploadsDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
    choose: /Yes, add it/i,
  },
]

/** Keys that select the option matching `want` in a Claude Code select dialog, or null if it isn't on screen. */
export function keysForOption(screen: string, want: RegExp): string[] | null {
  const lines = screen.split('\n')
  const options = lines
    .map((line, i) => ({ line, i, m: line.match(/^\s*(❯|>)?\s*(\d+)\.\s+(.*)$/) }))
    .filter(o => o.m)
  const numbered = options.find(o => want.test(o.m![3]) || want.test(o.line))
  if (numbered) {
    const selected = options.find(o => o.m![1])
    if (!selected) return [numbered.m![2]]
    const delta = options.indexOf(numbered) - options.indexOf(selected)
    return [...Array(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'), 'Enter']
  }
  // Unnumbered list (the folder-trust dialog): the options are the run of adjacent lines around the cursor.
  const cursorRe = /^\s*(❯|>)\s+/
  const at = lines.findLastIndex(l => cursorRe.test(l))
  if (at === -1) return null
  let start = at
  let end = at
  while (start > 0 && lines[start - 1].trim()) start--
  while (end < lines.length - 1 && lines[end + 1].trim()) end++
  for (let i = start; i <= end; i++) {
    if (!want.test(lines[i].replace(cursorRe, ''))) continue
    return [...Array(Math.abs(i - at)).fill(i > at ? 'Down' : 'Up'), 'Enter']
  }
  return null
}

/** Pick up a session whose terminal is still at a startup dialog, for example after the hub restarted. */
export function resumeStartup(name: string) {
  if (channels.has(name)) return
  setStatus(name, 'starting')
  void passStartupDialogs(name)
}

/** Sessions whose startup dialogs are being watched right now. */
const watchingStartup = new Set<string>()

async function passStartupDialogs(name: string) {
  if (watchingStartup.has(name)) return
  watchingStartup.add(name)
  try {
    await watchStartup(name)
  } finally {
    watchingStartup.delete(name)
  }
}

async function watchStartup(name: string) {
  // After 90 seconds the session is shown as needing attention, but the watch goes on (more slowly): once
  // someone answers a prompt Neural doesn't know, the ones it does know that follow are still answered.
  const attentionAt = Date.now() + config.startupAttentionMs
  const giveUpAt = Date.now() + 30 * 60_000
  const fired = new Map<string, number>()
  let screen = ''
  let flagged = false
  while (Date.now() < giveUpAt) {
    await sleep(flagged ? 3000 : 700)
    if (channels.has(name)) return // the channel server only starts once the dialogs are behind us
    const s = sessions.get(name)
    if (!s || !['starting', 'attention'].includes(s.status)) return
    if (flagged && s.status !== 'attention') return
    try {
      screen = await mux.capture(name)
    } catch {
      return
    }
    if (!(await mux.alive(name))) {
      await noteExit(name)
      return
    }
    for (const d of DIALOGS) {
      if (!d.when.test(screen)) continue
      const count = fired.get(d.name) ?? 0
      if (count >= 3) continue
      const keys = keysForOption(screen, d.choose)
      if (!keys) continue
      fired.set(d.name, count + 1)
      events.add(name, 'dialog', { dialog: d.name, keys })
      // One key at a time: a TUI can read several keys arriving together as a paste.
      for (const key of keys) {
        await mux.sendKeys(name, [key])
        await sleep(150)
      }
      await sleep(1500)
      break
    }
    if (!flagged && Date.now() > attentionAt && !channels.has(name) && sessions.get(name)?.status === 'starting') {
      // Don't guess at a screen we don't recognise: show it and let the user answer from the terminal view.
      flagged = true
      events.add(name, 'startup-timeout', { screen })
      setStatus(name, 'attention', 'Startup did not finish. Open the terminal view to see what it is waiting for.\n' + tail(screen))
    }
  }
}

export async function stopSession(name: string) {
  if (!sessions.get(name)) throw new Error(`no session "${name}"`)
  // Mark it stopped first, so the reconcile loop never mistakes the kill for a crash.
  setStatus(name, 'stopped')
  health.forget(name)
  health.setDown(name, null)
  handoff.forget(name)
  await mux.kill(name)
  sessions.update(name, { ended_at: new Date().toISOString(), channel_connected: 0 })
  permissions.expire(name)
  sessionChanged(name)
  // A worktree spawn_session made for it goes once nothing in it is uncommitted (the branch stays).
  return worktree.release(sessions.get(name)!.cwd, name).catch(e => ({ worktree: sessions.get(name)!.cwd, removed: false, reason: String(e.message ?? e) }))
}

export async function restartSession(name: string) {
  const s = sessions.get(name)
  if (!s) throw new Error(`no session "${name}"`)
  await ensureClaude() // before the kill, so a broken install doesn't take a running session down with it
  await mux.kill(name)
  // Asked for (by the user, the orchestrator or a refresh): a fresh start, with the full budget for later crashes.
  sessions.update(name, { restarts: 0 })
  return startSession(name, { resume: true })
}

/** Restart without resuming: a fresh context (a handoff). */
export async function freshStart(name: string) {
  await ensureClaude()
  await mux.kill(name)
  sessions.update(name, { restarts: 0 })
  return startSession(name, { resume: false })
}

export async function removeSession(name: string) {
  health.forget(name)
  handoff.forget(name)
  await mux.kill(name)
  sessions.remove(name)
  usage.remove(name)
}

// ---------------------------------------------------------------------------------------------
// Claude Code's own list of running sessions (`claude agents --json`), each "busy" or "idle". Shared by the
// sessions checked in one pass; null when it can't be had (an older Claude Code, or the test stand-in).

export interface Agent { pid: number; cwd: string; kind: string; sessionId: string; name?: string; status: string }
let agentsCache: { at: number; list: Promise<Agent[] | null> } | null = null

export function claudeAgents(): Promise<Agent[] | null> {
  if (agentsCache && Date.now() - agentsCache.at < 2000) return agentsCache.list
  const list = new Promise<Agent[] | null>(resolve => {
    let bin: string
    try {
      bin = resolveClaude()
    } catch {
      return resolve(null)
    }
    execFile(bin, ['agents', '--json'], { timeout: 10_000, maxBuffer: 4 * 2 ** 20 }, (err, out) => {
      if (err) return resolve(null)
      try {
        const v = JSON.parse(String(out))
        resolve(Array.isArray(v) ? v : null)
      } catch {
        resolve(null)
      }
    })
  })
  agentsCache = { at: Date.now(), list }
  return list
}

/** Claude Code's entry for a session: by its conversation id, else by the name and folder Neural started it with. */
export async function claudeAgent(s: Session): Promise<Agent | null> {
  const list = await claudeAgents()
  if (!list) return null
  return list.find(a => s.claude_session_id && a.sessionId === s.claude_session_id)
    ?? list.find(a => a.name === s.name && a.cwd === s.cwd) ?? null
}

/** Resolves with the status once the session reaches one of `until`; rejects on timeout or when `signal` aborts. */
export function waitFor(name: string, until: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const now = sessions.get(name)
  if (!now) return Promise.reject(new Error(`no session "${name}"`))
  if (until.includes(now.status)) return Promise.resolve(now.status)
  return new Promise((resolve, reject) => {
    const onStatus = (status: string) => {
      if (!until.includes(status)) return
      cleanup()
      resolve(status)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out; "${name}" is still ${sessions.get(name)?.status}`))
    }, timeoutMs)
    const onAbort = () => {
      cleanup()
      reject(new Error('stopped waiting'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      bus.off(`status:${name}`, onStatus)
      signal?.removeEventListener('abort', onAbort)
    }
    bus.on(`status:${name}`, onStatus)
    signal?.addEventListener('abort', onAbort)
  })
}

// On a timer: notice dead sessions and bring them back. A session is wanted until the user stops it
// (from the UI, or by exiting Claude in its terminal), so a crash or a reboot ends in a resumed session.
export async function reconcile() {
  // Shutting down: a restart begun now would lose its startup watcher when the process exits.
  if (lifecycle.stopping) return
  let refreshedThisPass = false
  for (const row of sessions.all()) {
    if (row.status === 'stopped') continue
    const alive = await mux.alive(row.name)
    // Read the row again: it may have been stopped or restarted while tmux was being asked.
    const s = sessions.get(row.name)
    if (!s || s.status === 'stopped') continue
    if (alive) {
      // "Starting" with nobody answering its startup dialogs: the watcher was lost (the hub restarted while
      // the session was being launched, say). Pick it up again rather than leave it waiting forever.
      if (s.status === 'starting' && !watchingStartup.has(s.name) && !channels.has(s.name) && Date.now() - Date.parse(s.updated_at) > 2000) {
        events.add(s.name, 'startup-resumed', null)
        void passStartupDialogs(s.name)
        continue
      }
      // Ten minutes up since the last (re)start: it's healthy again, so later crashes get the full retry budget.
      // (Timed from the spawn, not updated_at, which every status change moves, so a busy session never got there.)
      if (s.restarts && s.channel_connected) markHealthy(s.name)
      // Past the usage limit's reset time: ready again, and due to carry on with the task the limit cut off.
      if (s.status === 'limited') {
        const r = await import('./router.ts')
        const at = r.resetTime(s.status_detail ?? '', Date.parse(s.updated_at))
        if (at && Date.now() > at) r.limitReset(s.name, at)
      }
      await noteBackground(sessions.get(s.name) ?? s)
      // Started with an older Neural setup: restart it, once it's idle, to pick up the new one. One per pass.
      if (!refreshedThisPass && (await refreshIfOutdated(s))) {
        refreshedThisPass = true
        continue
      }
      // "Working" but silent for a while: check the terminal in case the turn ended without telling us.
      if (s.status === 'working' && Date.now() - Math.max(activity.get(s.name) ?? 0, Date.parse(s.updated_at)) > 90_000) {
        await import('./router.ts').then(r => r.settleIfIdle(s.name)).catch(() => {})
      }
      health.checkRecovered(sessions.get(s.name) ?? s)
      // Asked to write down its state for a fresh context: restart it once it has and is quiet.
      if (!refreshedThisPass) await handoff.check(sessions.get(s.name) ?? s).catch(e => events.add(s.name, 'handoff-failed', { error: String(e) }))
      continue
    }
    if (s.status === 'starting' && Date.now() - Date.parse(s.updated_at) < 10_000) continue
    if (s.status !== 'exited') {
      await noteExit(s.name)
      continue // restart on a later pass, after the backoff
    }
    await bringBack(s)
  }
  ;(await import('./router.ts')).resumeInterrupted()
  ;(await import('./usage.ts')).checkReset() // a window that reached an alert level has reset: tell the orchestrators
}

const backoff = (restarts: number) => config.restartBackoffMs * 2 ** restarts // 15s, 30s, 60s, …
const later = (ms: number) => new Date(Date.now() + ms).toISOString()

/** The process ended without being asked to: record why, and what Neural will do about it. */
const noting = new Set<string>()
async function noteExit(name: string) {
  if (noting.has(name)) return // the startup watcher and the reconcile pass can both notice the same exit
  noting.add(name)
  try {
    await recordExit(name)
  } finally {
    noting.delete(name)
  }
}

async function recordExit(name: string) {
  const s = sessions.get(name)
  if (!s || s.status === 'exited' || s.status === 'stopped') return // already noted, or stopped on purpose
  const exit = await mux.exitStatus(name)
  let screen = ''
  try {
    screen = await mux.capture(name, 40)
  } catch {
    // the pane is gone entirely (for example after a reboot)
  }
  const now = new Date().toISOString()
  let down: health.Down
  // Not found, not executable, not installed: check the program itself, and if that's it, say so instead of
  // restarting a session that can't start.
  const check = health.looksLikeInstall(screen, exit?.code ?? null) ? await checkClaude({ fresh: true }) : null
  if (check && !check.ok) down = { kind: 'install', reason: `Claude Code's install is broken: ${check.reason}`, hint: check.hint, retry_at: null, since: now }
  else {
    const reason = health.exitReason(exit, screen)
    if (!config.autostart) down = { kind: 'crash', reason, retry_at: null, since: now }
    else if (s.restarts >= MAX_RESTARTS) down = { kind: 'gave-up', reason: `crashed ${s.restarts + 1} times in a row; last time ${reason}`, retry_at: null, since: now }
    else down = { kind: 'crash', reason, retry_at: later(backoff(s.restarts)), attempt: s.restarts + 1, max: MAX_RESTARTS, since: now }
  }
  // Written before the status, so the notification the status change sends can see it.
  sessions.update(name, { channel_connected: 0, down: JSON.stringify(down) })
  permissions.expire(name)
  setStatus(name, 'exited', health.tail(screen) || null)
  events.add(name, 'exited', { screen: health.tail(screen), exit, kind: down.kind })
  health.exited(sessions.get(name)!, down, screen, exit)
}

/** An exited session: restart it when it is due, unless it can't start or has crashed too often. */
async function bringBack(s: Session) {
  if (!config.autostart) return
  const down = health.downOf(s)
  if (down?.kind === 'gave-up') return
  if (down?.kind === 'install') {
    // Waiting for the install to be fixed; checked again every so often, without spending an attempt.
    const check = await checkClaude()
    if (!check.ok) return
    health.installFixed()
    events.add(s.name, 'install-fixed', { version: check.version })
    return tryStart(s, false)
  }
  if (s.restarts >= MAX_RESTARTS) {
    const d: health.Down = { kind: 'gave-up', reason: down?.reason ?? `crashed ${s.restarts} times in a row`, retry_at: null, since: new Date().toISOString() }
    health.setDown(s.name, d)
    sessionChanged(s.name)
    return health.gaveUp(s, d)
  }
  const due = down?.retry_at ? Date.parse(down.retry_at) : Date.parse(s.updated_at) + backoff(s.restarts)
  if (Date.now() < due) return
  const check = await checkClaude()
  if (!check.ok) {
    const d: health.Down = { kind: 'install', reason: `Claude Code's install is broken: ${check.reason}`, hint: check.hint, retry_at: null, since: new Date().toISOString() }
    health.setDown(s.name, d)
    sessionChanged(s.name)
    events.add(s.name, 'health', { kind: d.kind, reason: d.reason })
    return health.installBroken(s, d)
  }
  return tryStart(s, true)
}

async function tryStart(s: Session, counts: boolean) {
  try {
    if (counts) sessions.update(s.name, { restarts: s.restarts + 1 })
    await startSession(s.name, { resume: true })
  } catch (e) {
    events.add(s.name, 'restart-failed', { error: String(e) })
    const restarts = sessions.get(s.name)?.restarts ?? s.restarts
    health.setDown(s.name, {
      kind: 'crash', reason: `it couldn't be started: ${(e as Error).message}`, since: new Date().toISOString(),
      retry_at: restarts < MAX_RESTARTS ? later(backoff(restarts)) : null, attempt: restarts + 1, max: MAX_RESTARTS,
    })
    sessionChanged(s.name)
  }
}

/** Background shells, tasks or agents still running in the session's terminal, as Claude Code's footer shows
 *  them ("auto mode on · 1 shell · ↓ to manage", "done 3:25 PM · 1 shell still running"). A turn can be over
 *  while they run, and a restart kills them, so a session with any is busy, not idle. Claude Code reporting
 *  the session as busy counts too. */
export async function backgroundWork(s: Session): Promise<string | null> {
  let screen = ''
  try {
    screen = await mux.capture(s.name)
  } catch {
    return null
  }
  const found = footerWork(screen)
  if (found) return found
  if ((await claudeAgent(s))?.status === 'busy') return 'busy according to Claude Code'
  return null
}

/** What Claude Code's footer says is still running in the background ("1 shell"), or null. */
export function footerWork(screen: string): string | null {
  const lines = screen.split('\n').filter(l => l.trim())
  const footer = lines.slice(-3).join('\n')
  const m = /·\s*(\d+\s+(?:shells?|background tasks?|tasks?|agents?|monitors?))\b/i.exec(footer)
    ?? /\b(\d+\s+(?:shells?|background tasks?|tasks?|agents?)) still running\b/i.exec(lines.slice(-10).join('\n'))
  return m ? m[1] : null
}

/** Idle, but with background work still running: shown as "idle · 1 shell running" in the app and list_sessions. */
async function noteBackground(s: Session) {
  if (s.status !== 'idle' || !s.channel_connected) return setBackground(s.name, null)
  try {
    setBackground(s.name, footerWork(await mux.capture(s.name)))
  } catch {
    // can't read the terminal this pass: keep what was shown
  }
}

const refreshedAt = new Map<string, number>()

/** Restart a session launched with an older setup, when that interrupts nothing: idle for a while, connected,
 *  nothing waiting to be delivered, no question or approval open, and nobody looking at its terminal.
 *  The conversation is resumed. At most once every half hour per session, in case something keeps changing. */
async function refreshIfOutdated(s: Session): Promise<boolean> {
  if (!config.autoRefresh || s.status !== 'idle' || !s.channel_connected) return false
  if (Date.now() - Math.max(activity.get(s.name) ?? 0, Date.parse(s.updated_at)) < config.refreshIdleMs) return false
  if (Date.now() - (refreshedAt.get(s.name) ?? 0) < 30 * 60_000) return false
  let rev: string
  try {
    rev = launchRev(s)
  } catch {
    return false
  }
  if (s.launch_rev === rev) return false
  if (outbox.pending(s.name).length || outbox.pushed(s.name).length) return false
  if (questions.openFor(s.name).length || permissions.open().some(p => p.session === s.name)) return false
  if (await mux.attached(s.name)) return false
  if (await backgroundWork(s)) return false // a background shell would be killed
  refreshedAt.set(s.name, Date.now())
  events.add(s.name, 'refresh', { from: s.launch_rev, to: rev })
  try {
    await restartSession(s.name)
  } catch (e) {
    events.add(s.name, 'refresh-failed', { error: String(e) }) // Claude Code can't run: leave this one running
    return false
  }
  return true
}

/** When each session's current process was started (since this hub started), to tell a stable session from a crash loop. */
const spawnedAt = new Map<string, number>()
const HEALTHY_AFTER = 10 * 60_000

/** A session that has stayed up is healthy again, so later crashes get the full retry budget. One that finishes
 *  a turn and then crashes straight away is not: its restarts keep counting toward the limit. */
export function markHealthy(name: string) {
  const s = sessions.get(name)
  if (!s?.restarts) return
  if (Date.now() - (spawnedAt.get(name) ?? 0) < HEALTHY_AFTER) return
  sessions.update(name, { restarts: 0 })
}

const tail = health.tail

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
