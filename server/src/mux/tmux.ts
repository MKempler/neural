import { execFile } from 'node:child_process'
import type { Mux } from './mux.ts'

// Runs on its own tmux server (`tmux -L <socket>`), so a personal tmux setup is never touched.
// Attach from a terminal with: tmux -L neural attach -t <name>
export class Tmux implements Mux {
  socket: string
  constructor(socket: string) {
    this.socket = socket
  }

  private run(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('tmux', ['-L', this.socket, ...args], { maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`tmux ${args[0]}: ${stderr.trim() || err.message}`))
        else resolve(stdout)
      })
      if (input !== undefined) child.stdin?.end(input)
    })
  }

  // `=name` is tmux's exact-match form; without it `-t api` would also match `api-2`.
  private target(name: string) {
    return `=${name}:`
  }

  async spawn(name: string, cwd: string, argv: string[], env: Record<string, string>) {
    await this.kill(name)
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    const command = argv.map(shellQuote).join(' ')
    await this.run([
      'new-session', '-d', '-s', name, '-x', '200', '-y', '50', '-c', cwd, ...envArgs, command,
      // Keep the pane after the process exits so its last output can still be read.
      ';', 'set-option', '-t', name, 'remain-on-exit', 'on',
      ';', 'set-option', '-t', name, 'history-limit', '20000',
      // Claude Code uses focus events to tell whether its terminal is being watched.
      ';', 'set-option', '-s', 'focus-events', 'on',
    ])
  }

  async alive(name: string) {
    try {
      const out = await this.run(['list-panes', '-t', this.target(name), '-F', '#{pane_dead}'])
      return out.trim().split('\n')[0] === '0'
    } catch {
      return false
    }
  }

  async capture(name: string, history = 0) {
    const out = await this.run(['capture-pane', '-p', '-J', '-t', this.target(name), '-S', String(-history)])
    return out.replace(/\s+$/, '')
  }

  async sendKeys(name: string, keys: string[]) {
    if (keys.length) await this.run(['send-keys', '-t', this.target(name), ...keys])
  }

  async type(name: string, text: string) {
    if (text) await this.run(['send-keys', '-l', '-t', this.target(name), '--', text])
  }

  async paste(name: string, text: string) {
    const buffer = `hub-${name}`
    await this.run(['load-buffer', '-b', buffer, '-'], text)
    // -p uses bracketed paste, so newlines in the text don't submit it early; -d drops the buffer afterwards.
    await this.run(['paste-buffer', '-p', '-d', '-b', buffer, '-t', this.target(name)])
    await new Promise(r => setTimeout(r, 300))
    await this.sendKeys(name, ['Enter'])
  }

  async kill(name: string) {
    try {
      await this.run(['kill-session', '-t', `=${name}`])
    } catch {
      // not running
    }
  }

  async list() {
    try {
      const out = await this.run(['list-sessions', '-F', '#{session_name}'])
      return out.trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
}

function shellQuote(s: string) {
  return /^[A-Za-z0-9_\/:=.,@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
