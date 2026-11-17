import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config, hubUrl, ROOT } from '../server/src/config.ts'

const [cmd = 'help', ...args] = process.argv.slice(2)

const run = (bin: string, a: string[]) => {
  try {
    return execFileSync(bin, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}
const api = async (url: string) => {
  const res = await fetch(hubUrl + url, { signal: AbortSignal.timeout(3000) })
  return res.json()
}

const SERVICE = 'com.neural.server'
const SERVICE_FILE = path.join(process.env.HOME ?? '', 'Library/LaunchAgents', `${SERVICE}.plist`)
const SERVICE_TARGET = `gui/${process.getuid?.() ?? 0}/${SERVICE}`

const commands: Record<string, () => Promise<void> | void> = {
  async start() {
    const { start } = await import('../server/src/index.ts')
    await start()
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))
  },

  async status() {
    let rows: any[]
    try {
      rows = await api('/api/sessions')
    } catch {
      console.log(`The hub is not running on ${hubUrl}. Start it with: neural start`)
      process.exitCode = 1
      return
    }
    if (!rows.length) return console.log('No sessions.')
    for (const s of rows) {
      console.log(`${s.name.padEnd(16)} ${s.status.padEnd(10)} ${s.channel_connected ? 'channel up  ' : 'channel down'} ${s.role.padEnd(12)} ${s.cwd}`)
    }
  },

  attach() {
    if (!args[0]) return console.log('Usage: hub attach <session>')
    // Detach again with Ctrl+B then D; the session keeps running.
    spawnSync('tmux', ['-L', config.tmuxSocket, 'attach', '-t', `=${args[0]}`], { stdio: 'inherit' })
  },

  async doctor() {
    let failed = false
    const check = (ok: boolean, label: string, detail = '') => {
      if (!ok) failed = true
      console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`)
    }
    const note = (label: string, detail: string) => console.log(`note  ${label}: ${detail}`)

    const [major, minor] = process.versions.node.split('.').map(Number)
    check(major > 22 || (major === 22 && minor >= 18), 'Node 22.18 or newer', process.versions.node)
    const tmux = run('tmux', ['-V'])
    check(Boolean(tmux), 'tmux installed', tmux ?? 'not found (brew install tmux)')
    const claude = run(config.claudeBin, ['--version']) ?? run('/bin/zsh', ['-lc', `${config.claudeBin} --version`])
    check(Boolean(claude), 'Claude Code installed', claude ?? 'not found')
    const deps = fs.existsSync(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk'))
    check(deps, 'dependencies installed', deps ? '' : 'run npm install')

    const { db } = await import('../server/src/db.ts')
    const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
    check(true, 'database', `${config.dbPath} (${count('messages')} messages, ${count('transcript_entries')} transcript entries)`)

    try {
      const rows: any[] = await api('/api/sessions')
      check(true, 'neural running', hubUrl)
      for (const s of rows) {
        const healthy = ['idle', 'working', 'blocked'].includes(s.status) ? Boolean(s.channel_connected) : s.status === 'stopped'
        check(healthy, `session ${s.name}`, `${s.status}, channel ${s.channel_connected ? 'connected' : 'not connected'}`)
      }
    } catch {
      note('neural', `not running on ${hubUrl}`)
    }

    const { embeddingStatus } = await import('../server/src/embed.ts')
    const { listBackups } = await import('../server/src/backup.ts')
    const emb = embeddingStatus()
    note('semantic search', emb.enabled ? `${emb.chunks} chunks indexed` : 'off (keyword search only)')
    note('backups', listBackups().at(-1) ?? 'none yet')
    note('login service', run('launchctl', ['print', SERVICE_TARGET]) ? 'installed' : 'not installed (neural install-service)')

    const ts = run('tailscale', ['status', '--json']) ?? run('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['status', '--json'])
    if (!ts) note('Tailscale', 'not installed or not signed in; the UI is reachable from this Mac only')
    else {
      const self = JSON.parse(ts).Self
      note('Tailscale', `${self?.DNSName?.replace(/\.$/, '') ?? 'connected'}; publish the UI with: tailscale serve --bg ${config.port}`)
    }
    process.exitCode = failed ? 1 : 0
  },

  async backup() {
    const { backupNow, listBackups } = await import('../server/src/backup.ts')
    const file = backupNow({ force: true })
    console.log(`Wrote ${file}`)
    console.log(`Kept: ${listBackups().join(', ')}`)
  },

  // Run the hub as a login service, so it survives closed terminals and reboots.
  'install-service'() {
    const which = (bin: string) => run('/usr/bin/which', [bin]) ?? run('/bin/zsh', ['-lc', `command -v ${bin}`])
    const claude = path.isAbsolute(config.claudeBin) ? config.claudeBin : which(config.claudeBin)
    const tmux = which('tmux')
    if (!claude || !tmux) throw new Error('claude and tmux must be installed first (see: hub doctor)')
    const home = process.env.HOME!
    const plist = fs.readFileSync(path.join(ROOT, 'launchd/com.neural.server.plist'), 'utf8')
      .replaceAll('__NODE_DIR__', path.dirname(config.nodeBin))
      .replaceAll('__NODE__', config.nodeBin)
      .replaceAll('__TMUX_DIR__', path.dirname(tmux))
      .replaceAll('__ROOT__', ROOT)
      .replaceAll('__CLAUDE__', claude)
      .replaceAll('__HOME__', home)
    fs.mkdirSync(path.dirname(SERVICE_FILE), { recursive: true })
    fs.writeFileSync(SERVICE_FILE, plist)
    run('launchctl', ['bootout', SERVICE_TARGET])
    const out = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, SERVICE_FILE], { encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`launchctl could not load the service: ${out.stderr.trim()}`)
    console.log(`Installed ${SERVICE_FILE}\nNeural now starts at login and restarts if it stops. Log: ~/Library/Logs/neural.log`)
  },

  restart() {
    // The login service restarts Neural when it exits; kickstart does exactly that. Sessions keep running.
    const out = spawnSync('launchctl', ['kickstart', '-k', SERVICE_TARGET], { encoding: 'utf8' })
    if (out.status !== 0) {
      console.log('Neural is not installed as a login service. Stop it (Ctrl+C) and run: bin/neural start')
      process.exitCode = 1
      return
    }
    console.log('Restarted. Sessions keep running and reconnect in a few seconds.')
  },

  'uninstall-service'() {
    run('launchctl', ['bootout', SERVICE_TARGET])
    fs.rmSync(SERVICE_FILE, { force: true })
    console.log('Service removed. Sessions already running in tmux are left alone.')
  },

  migrate() {
    // Handled by bin/neural before this module (and its config) loads; see bin/migrate.ts.
    console.log('Run it as: bin/neural migrate')
  },

  /** neural notify [--to user|<session>] [--from <job>] [--file <path>]... <text…|->: a message from a script. */
  async notify() {
    let to = 'user'
    let from = 'script'
    const files: string[] = []
    const words: string[] = []
    const usage = 'usage: neural notify [--to user|<session>] [--from <job>] [--file <path>]... [--] <text, or - to read stdin>'
    let options = true
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (options && (a === '--help' || a === '-h')) return console.log(usage)
      if (options && a === '--') options = false
      else if (options && a === '--to') to = args[++i]
      else if (options && a === '--from') from = args[++i]
      else if (options && a === '--file') files.push(args[++i])
      else if (options && a.startsWith('-') && a !== '-') {
        // A mistyped option would otherwise be sent as the message.
        console.error(`neural notify: unknown option ${a} (put text that starts with - after --)\n${usage}`)
        process.exitCode = 2
        return
      } else words.push(a)
    }
    if ([to, from].some(v => v === undefined) || files.some(f => !f)) {
      console.error(`neural notify: an option is missing its value\n${usage}`)
      process.exitCode = 2
      return
    }
    files.splice(0, files.length, ...files.map(f => path.resolve(f)))
    let text = words.join(' ')
    if (text === '-' || (!text && !files.length && !process.stdin.isTTY)) text = fs.readFileSync(0, 'utf8')
    if (!text.trim() && !files.length) return console.log(usage) // nothing to send
    try {
      const res = await fetch(hubUrl + '/api/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret}` },
        body: JSON.stringify({ to, from, text, files }),
        signal: AbortSignal.timeout(15_000),
      })
      const body: any = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      console.log(`sent to ${to} (message ${body.id})`)
    } catch (e: any) {
      console.error(`neural notify: ${e.cause?.code === 'ECONNREFUSED' ? `the hub is not running on ${hubUrl}` : e.message}`)
      process.exitCode = 1
    }
  },

  help() {
    console.log(`Neural

  neural start             Run Neural (web UI on ${hubUrl}); starts the orchestrator session "main"
  neural status            List sessions and their state
  neural attach <session>  Open a session's terminal (detach with Ctrl+B then D)
  neural doctor            Check the installation
  neural backup            Write a database snapshot now
  neural install-service   Start the hub at login and keep it running (launchd)
  neural uninstall-service Remove the login service
  neural restart        Restart the login service (only needed if automatic reloading is off)
  neural notify [--to user|<session>] [--from <job>] [--file <path>]... <text | ->
                           Send a message from a script or job (push notification with --to user)
`)
  },
}

await (commands[cmd] ?? commands.help)()
