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

  'uninstall-service'() {
    run('launchctl', ['bootout', SERVICE_TARGET])
    fs.rmSync(SERVICE_FILE, { force: true })
    console.log('Service removed. Sessions already running in tmux are left alone.')
  },

  migrate() {
    // Handled by bin/neural before this module (and its config) loads; see bin/migrate.ts.
    console.log('Run it as: bin/neural migrate')
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
`)
  },
}

await (commands[cmd] ?? commands.help)()
