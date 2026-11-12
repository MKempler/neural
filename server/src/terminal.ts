import type { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { config } from './config.ts'

// Live terminal: a browser tab becomes a real tmux client for a session, through a pseudo-terminal.
// node-pty is a native module; if it cannot load, the UI falls back to screen snapshots.

let pty: typeof import('node-pty') | undefined
try {
  pty = await import('node-pty')
} catch (e: any) {
  console.error('live terminal unavailable (node-pty did not load):', e?.message ?? e)
}

export const available = Boolean(pty)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo))

export function attach(ws: WebSocket, name: string, cols: number, rows: number) {
  if (!pty) return ws.close(1011, 'live terminal unavailable')
  // The status bar is noise in a small browser pane.
  execFile('tmux', ['-L', config.tmuxSocket, 'set-option', '-g', 'status', 'off'], () => {})

  const term = pty.spawn('tmux', ['-L', config.tmuxSocket, 'attach-session', '-t', `=${name}`], {
    name: 'xterm-256color',
    cols: clamp(cols, 20, 400),
    rows: clamp(rows, 5, 200),
    cwd: config.dataDir,
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'en_US.UTF-8' } as Record<string, string>,
  })

  term.onData(data => {
    if (ws.readyState === 1) ws.send(data)
  })
  term.onExit(() => ws.close())

  ws.on('message', raw => {
    let msg: any
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'input' && typeof msg.data === 'string') term.write(msg.data)
    else if (msg.type === 'resize') term.resize(clamp(msg.cols, 20, 400), clamp(msg.rows, 5, 200))
  })

  // Killing the pty detaches this client only; the session itself keeps running in tmux.
  const end = () => {
    try {
      term.kill()
    } catch {
      // already gone
    }
  }
  ws.on('close', end)
  ws.on('error', end)
}
