import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, config, hubUrl } from './config.ts'
import { sessions, events, permissions, outbox, type Session } from './db.ts'
import { channels, setStatus, sessionChanged, bus, turns } from './live.ts'
import { Tmux } from './mux/tmux.ts'
import type { Mux } from './mux/mux.ts'

export const mux: Mux = new Tmux(config.tmuxSocket)

// PostToolUse is only a heartbeat: it tells the hub a turn is still making progress.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd', 'PreCompact']
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const RESERVED = new Set(['user', 'system', 'all', 'hub', 'neural'])
const MAX_RESTARTS = 5

export function validName(name: string) {
  return NAME_RE.test(name) && !RESERVED.has(name)
}

let claudePath: string | undefined
function resolveClaude(): string {
  if (claudePath) return claudePath
  if (path.isAbsolute(config.claudeBin)) return (claudePath = config.claudeBin)
  // launchd starts the hub with a minimal PATH, so ask a login shell where claude lives.
  for (const cmd of [['/usr/bin/which', [config.claudeBin]], ['/bin/zsh', ['-lc', `command -v ${config.claudeBin}`]]] as const) {
    try {
      const out = execFileSync(cmd[0], cmd[1] as string[], { encoding: 'utf8' }).trim().split('\n').pop()
      if (out && path.isAbsolute(out)) return (claudePath = out)
    } catch {
      // try the next way
    }
  }
  throw new Error(`cannot find the claude binary (${config.claudeBin}); set NEURAL_CLAUDE_BIN to its full path`)
}

// Per-session config files: the hub's MCP server and hooks are passed on the command line,
// so nothing is added to the user's global Claude Code settings.
function writeRunFiles(s: Session) {
  fs.mkdirSync(config.uploadsDir, { recursive: true, mode: 0o700 })
  const mcpFile = path.join(config.runDir, `${s.name}.mcp.json`)
  const settingsFile = path.join(config.runDir, `${s.name}.settings.json`)
  const mcp = {
    mcpServers: {
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
  const settings = { hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, [hook(e)]])) }
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2), { mode: 0o600 })
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
  return { mcpFile, settingsFile }
}

export function launchArgv(s: Session, opts: { resume?: boolean } = {}) {
  const { mcpFile, settingsFile } = writeRunFiles(s)
  const argv = [
    resolveClaude(),
    '--name', s.name,
    '--permission-mode', 'auto',
    '--mcp-config', mcpFile,
    '--settings', settingsFile,
    // Attached files live here; this lets the session open them without asking.
    '--add-dir', config.uploadsDir,
    // Custom channels are not on the research-preview allowlist, so they load through the development flag.
    '--dangerously-load-development-channels', 'server:neural',
  ]
  if (opts.resume && s.claude_session_id) argv.push('--resume', s.claude_session_id)
  return argv
}

export async function startSession(
  name: string,
  opts: { cwd?: string; role?: 'orchestrator' | 'worker'; autostart?: boolean; resume?: boolean } = {},
): Promise<Session> {
  if (!validName(name)) throw new Error(`invalid session name "${name}" (lowercase letters, digits, - and _, up to 32 characters)`)
  const existing = sessions.get(name)
  const cwd = opts.cwd ?? existing?.cwd
  if (!cwd) throw new Error('cwd is required for a new session')
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`cwd does not exist: ${cwd}`)
  if (existing && (await mux.alive(name))) throw new Error(`session "${name}" is already running`)

  const role = opts.role ?? existing?.role ?? 'worker'
  sessions.create(name, role, cwd, opts.autostart ?? (existing ? Boolean(existing.autostart) : role === 'orchestrator'))
  const s = sessions.get(name)!
  turns.delete(name)
  permissions.expire(name)
  // Whatever was pushed to the previous process without confirmation goes out again once this one is ready.
  for (const row of outbox.pushed(name)) outbox.markPending(row.message_id, 'session restarted')

  // The channel server negotiates the earlier MCP handshake; newer revisions do not register channels.
  const env = { MCP_PROTOCOL_NEGOTIATION: 'legacy' }
  await mux.spawn(name, cwd, launchArgv(s, { resume: opts.resume }), env)
  events.add(name, 'spawn', { resume: Boolean(opts.resume && s.claude_session_id) })
  sessionChanged(name)
  void passStartupDialogs(name)
  return sessions.get(name)!
}

// Startup dialogs Claude Code can show before the session is usable, and the option to pick in each.
const DIALOGS: { name: string; when: RegExp; choose: RegExp }[] = [
  { name: 'development-channels', when: /development channels?|local development/i, choose: /local development/i },
  { name: 'folder-trust', when: /trust (this|the) (folder|files)|Do you trust/i, choose: /^\W*(\d+\.\s*)?Yes/i },
  { name: 'mcp-consent', when: /New MCP server found/i, choose: /Use this MCP server/i },
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

async function passStartupDialogs(name: string) {
  const deadline = Date.now() + 90_000
  const fired = new Map<string, number>()
  let screen = ''
  while (Date.now() < deadline) {
    await sleep(700)
    if (channels.has(name)) return // the channel server only starts once the dialogs are behind us
    const s = sessions.get(name)
    if (!s || s.status !== 'starting') return
    try {
      screen = await mux.capture(name)
    } catch {
      return
    }
    if (!(await mux.alive(name))) {
      setStatus(name, 'exited', tail(screen))
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
  }
  if (!channels.has(name) && sessions.get(name)?.status === 'starting') {
    // Don't guess at a screen we don't recognise: show it and let the user answer from the terminal view.
    events.add(name, 'startup-timeout', { screen })
    setStatus(name, 'attention', 'Startup did not finish. Open the terminal view to see what it is waiting for.\n' + tail(screen))
  }
}

export async function stopSession(name: string) {
  if (!sessions.get(name)) throw new Error(`no session "${name}"`)
  // Mark it stopped first, so the reconcile loop never mistakes the kill for a crash.
  setStatus(name, 'stopped')
  await mux.kill(name)
  sessions.update(name, { ended_at: new Date().toISOString(), channel_connected: 0 })
  permissions.expire(name)
  sessionChanged(name)
}

export async function restartSession(name: string) {
  const s = sessions.get(name)
  if (!s) throw new Error(`no session "${name}"`)
  await mux.kill(name)
  return startSession(name, { resume: true })
}

export async function removeSession(name: string) {
  await mux.kill(name)
  sessions.remove(name)
}

/** Resolves with the status once the session reaches one of `until`, or rejects on timeout. */
export function waitFor(name: string, until: string[], timeoutMs: number): Promise<string> {
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
    const cleanup = () => {
      clearTimeout(timer)
      bus.off(`status:${name}`, onStatus)
    }
    bus.on(`status:${name}`, onStatus)
  })
}

// On a timer: notice dead sessions and bring them back. A session is wanted until the user stops it
// (from the UI, or by exiting Claude in its terminal), so a crash or a reboot ends in a resumed session.
export async function reconcile() {
  for (const row of sessions.all()) {
    if (row.status === 'stopped') continue
    if (await mux.alive(row.name)) continue
    // Read the row again: it may have been stopped or restarted while tmux was being asked.
    const s = sessions.get(row.name)
    if (!s || s.status === 'stopped') continue
    if (s.status === 'starting' && Date.now() - Date.parse(s.updated_at) < 10_000) continue
    if (s.status !== 'exited') {
      let screen = ''
      try {
        screen = await mux.capture(s.name, 40)
      } catch {
        // the pane is gone entirely (for example after a reboot)
      }
      sessions.update(s.name, { channel_connected: 0 })
      permissions.expire(s.name)
      setStatus(s.name, 'exited', tail(screen) || null)
      events.add(s.name, 'exited', { screen: tail(screen) })
      continue // restart on a later pass, after the backoff below
    }
    if (!config.autostart || s.restarts >= MAX_RESTARTS) continue
    // Back off between attempts: 15s, 30s, 60s, …
    if (Date.now() - Date.parse(s.updated_at) < config.restartBackoffMs * 2 ** s.restarts) continue
    try {
      sessions.update(s.name, { restarts: s.restarts + 1 })
      await startSession(s.name, { resume: true })
    } catch (e) {
      events.add(s.name, 'restart-failed', { error: String(e) })
    }
  }
}

/** A session that has stayed up is healthy again, so later crashes get the full retry budget. */
export function markHealthy(name: string) {
  const s = sessions.get(name)
  if (s && s.restarts) sessions.update(name, { restarts: 0 })
}

function tail(screen: string, lines = 12) {
  return screen.split('\n').filter(l => l.trim()).slice(-lines).join('\n')
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
