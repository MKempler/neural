import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import { ROOT, config } from './config.ts'
import { sessions, messages, permissions, events, reads } from './db.ts'
import { searchAll, embedPending, embeddingStatus } from './embed.ts'
import { channels, uiClients, broadcast, bus } from './live.ts'
import {
  sendMessage, handleHook, handleTool, channelConnected, channelDisconnected,
  permissionRequested, decidePermission, retryStale, flush,
} from './router.ts'
import { ingestAll } from './ingest.ts'
import * as push from './push.ts'
import * as terminal from './terminal.ts'
import { receiveUpload, publicView, getAttachment, serveFile, cleanUnsent } from './files.ts'
import { backupNow, listBackups } from './backup.ts'
import { spawn } from 'node:child_process'
import { mux, startSession, stopSession, restartSession, removeSession, reconcile, resumeStartup } from './spawner.ts'

const WEB = path.join(ROOT, 'web')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2',
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const secretOk = (given: string | null) =>
  typeof given === 'string' && given.length === config.secret.length &&
  crypto.timingSafeEqual(Buffer.from(given), Buffer.from(config.secret))

// The hub only listens on localhost. Browsers reach it directly or through `tailscale serve`, which adds
// identity headers. Rejecting foreign Origins stops other web pages from driving the API or the socket.
function checkBrowser(req: http.IncomingMessage) {
  const origin = req.headers.origin
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      // malformed Origin: treated as foreign below
    }
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    if (originHost !== host) throw new HttpError(403, 'cross-origin request refused')
  }
  const login = req.headers['tailscale-user-login']
  if (login && config.allowedLogins.length && !config.allowedLogins.includes(String(login))) {
    throw new HttpError(403, 'this Tailscale user is not allowed')
  }
}

function withSummary(s: ReturnType<typeof sessions.all>[number]) {
  return { ...s, last_message: reads.last(s.name), unread: reads.unread(s.name) }
}

/** First name for the greeting: config.json, then the Tailscale identity of the request, else nothing. */
function displayName(req: http.IncomingMessage): string {
  if (config.displayName) return config.displayName
  const fromTailscale = String(req.headers['tailscale-user-name'] ?? '').trim().split(/\s+/)[0]
  return fromTailscale
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4 << 20) throw new HttpError(413, 'body too large')
  }
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v))

async function api(req: http.IncomingMessage, url: URL): Promise<unknown> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent) // after /api
  const method = req.method ?? 'GET'
  const route = `${method} ${parts[0] ?? ''}`
  const name = parts[1]

  switch (route) {
    case 'GET state':
      return {
        user: { name: displayName(req) },
        sessions: sessions.all().map(withSummary),
        permissions: permissions.open(),
        liveTerminal: terminal.available,
        health: {
          semantic: embeddingStatus(),
          lastBackup: listBackups().at(-1) ?? null,
          pushSubscriptions: push.subscriptionCount(),
          tailnet: Boolean(req.headers['tailscale-user-login']),
        },
      }

    case 'POST read': {
      const { session, id } = await readJson(req)
      if (!sessions.get(String(session)) || !Number.isInteger(id)) throw new HttpError(400, 'session and id are required')
      reads.mark(String(session), id)
      broadcast({ type: 'read', session, id, unread: reads.unread(String(session)) })
      return { ok: true }
    }

    case 'GET sessions':
      return sessions.all().map(withSummary)
    case 'POST sessions': {
      if (name) {
        const action = parts[2]
        if (action === 'stop') return stopSession(name).then(() => sessions.get(name))
        if (action === 'restart') return restartSession(name)
        if (action === 'keys') {
          const { keys } = await readJson(req)
          if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string')) throw new HttpError(400, 'keys must be an array of strings')
          await mux.sendKeys(name, keys)
          return { ok: true }
        }
        if (action === 'type') {
          const { text } = await readJson(req)
          await mux.type(name, String(text ?? ''))
          return { ok: true }
        }
        throw new HttpError(404, 'unknown action')
      }
      const body = await readJson(req)
      const s = await startSession(String(body.name ?? ''), { cwd: body.cwd, role: body.role === 'orchestrator' ? 'orchestrator' : 'worker' })
      if (body.prompt) sendMessage({ from: 'user', to: s.name, body: String(body.prompt), source: 'ui' })
      return s
    }
    case 'DELETE sessions':
      await removeSession(name)
      broadcast({ type: 'session_removed', name })
      return { ok: true }
    case 'GET screen':
      return { screen: await mux.capture(name, num(url.searchParams.get('history')) ?? 0).catch(() => '') }
    case 'GET events':
      return events.recent(name)

    case 'GET messages': {
      const opts = { before: num(url.searchParams.get('before')), after: num(url.searchParams.get('after')), limit: num(url.searchParams.get('limit')) }
      const session = url.searchParams.get('session')
      return session ? messages.thread(session, opts) : messages.timeline(opts)
    }
    case 'POST messages': {
      const body = await readJson(req)
      const attachments = Array.isArray(body.attachments) ? body.attachments.map(Number).filter(Number.isInteger) : []
      return sendMessage({ from: 'user', to: String(body.to ?? ''), body: String(body.body ?? ''), source: 'ui', attachments })
    }

    case 'POST upload':
      return publicView(await receiveUpload(req))

    case 'GET search':
      return searchAll(url.searchParams.get('q') ?? '', {
        session: url.searchParams.get('session') ?? undefined,
        limit: num(url.searchParams.get('limit')),
      })

    case 'GET push':
      return { publicKey: push.publicKey, subscriptions: push.subscriptionCount() }
    case 'POST push': {
      const body = await readJson(req)
      if (name === 'subscribe') push.subscribe(body.subscription, req.headers['user-agent'])
      else if (name === 'unsubscribe') push.unsubscribe(String(body.endpoint ?? ''))
      else if (name === 'test') {
        const sent = await push.notify({ title: 'Neural', body: 'Notifications are working.', tag: 'test' }, { evenIfWatching: true })
        return { sent }
      } else throw new HttpError(404, 'not found')
      return { ok: true }
    }

    case 'POST permissions': {
      const { behavior } = await readJson(req)
      if (behavior !== 'allow' && behavior !== 'deny') throw new HttpError(400, 'behavior must be allow or deny')
      decidePermission(Number(name), behavior)
      return { ok: true }
    }
  }
  throw new HttpError(404, 'not found')
}

// Browser libraries and fonts served straight from node_modules, so the UI needs no build step and makes no
// requests outside this origin. Only these packages, and only these file types, are reachable.
const VENDOR_PACKAGES = new Set([
  'preact', 'htm', '@preact/signals', '@preact/signals-core', 'marked', 'dompurify',
  '@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono', '@xterm/xterm', '@xterm/addon-fit',
])
const VENDOR_TYPES = new Set(['.js', '.mjs', '.css', '.woff2'])
const NODE_MODULES = path.join(ROOT, 'node_modules')

function vendorFile(pathname: string): string | null {
  const rel = decodeURIComponent(pathname.slice('/vendor/'.length))
  const parts = rel.split('/')
  const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!VENDOR_PACKAGES.has(pkg) || !VENDOR_TYPES.has(path.extname(rel))) return null
  const file = path.resolve(NODE_MODULES, rel)
  return file.startsWith(path.join(NODE_MODULES, pkg) + path.sep) ? file : null
}

function serveStatic(url: URL, res: http.ServerResponse) {
  let file: string | null
  if (url.pathname.startsWith('/vendor/')) file = vendorFile(url.pathname)
  else {
    file = path.resolve(WEB, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(WEB + path.sep)) file = null
    // App routes such as /s/main or /timeline have no file of their own: they all load the app.
    else if (!path.extname(url.pathname) && !fs.existsSync(file)) file = path.join(WEB, 'index.html')
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not found')
  const headers: Record<string, string> = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }
  // Fonts and libraries only change when node_modules does; everything else is revalidated on each load.
  headers['cache-control'] = url.pathname.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache'
  res.writeHead(200, headers)
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://hub')
  try {
    if (url.pathname.startsWith('/hooks/')) {
      // Called by Claude Code itself, authenticated by the shared secret in the per-session settings file.
      if (!secretOk(url.searchParams.get('secret'))) throw new HttpError(403, 'bad secret')
      const payload = await readJson(req)
      handleHook(url.searchParams.get('session') ?? '', url.pathname.slice('/hooks/'.length), payload)
      res.writeHead(200).end()
      return
    }
    checkBrowser(req)
    // Attachments are streamed, not JSON: /api/files/<id>[/view|/poster|/download]
    const file = /^\/api\/files\/(\d+)(?:\/(\w+))?$/.exec(url.pathname)
    if (file && req.method === 'GET') {
      const a = getAttachment(Number(file[1]))
      if (!a) throw new HttpError(404, 'not found')
      serveFile(req, res, a, file[2])
      return
    }
    if (url.pathname.startsWith('/api/')) {
      const result = await api(req, url)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? null))
      return
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    serveStatic(url, res)
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : typeof e?.status === 'number' ? e.status : 400
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e?.message ?? String(e) }))
  }
})

// ---------------------------------------------------------------------------------------------
// WebSockets: /ui for browsers, /channel for the per-session channel MCP servers.

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://hub')
  try {
    if (url.pathname === '/channel') {
      if (!secretOk(url.searchParams.get('secret'))) throw new HttpError(403, 'bad secret')
      const name = url.searchParams.get('name') ?? ''
      if (!sessions.get(name)) throw new HttpError(404, 'unknown session')
      wss.handleUpgrade(req, socket, head, ws => onChannel(ws, name))
    } else if (url.pathname === '/term') {
      checkBrowser(req)
      const name = url.searchParams.get('name') ?? ''
      if (!sessions.get(name)) throw new HttpError(404, 'unknown session')
      wss.handleUpgrade(req, socket, head, ws =>
        terminal.attach(ws, name, Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows'))))
    } else if (url.pathname === '/ui') {
      checkBrowser(req)
      wss.handleUpgrade(req, socket, head, onUi)
    } else throw new HttpError(404, 'not found')
  } catch (e: any) {
    socket.end(`HTTP/1.1 ${e instanceof HttpError ? e.status : 400} Refused\r\n\r\n`)
  }
})

function onUi(ws: WebSocket) {
  uiClients.add(ws)
  // Each tab says whether it is in front, so notifications are skipped while someone is looking.
  ws.on('message', data => {
    try {
      const msg = JSON.parse(String(data))
      if (msg.type === 'presence') {
        ;(ws as any).hubVisible = Boolean(msg.visible)
        ;(ws as any).hubSeen = Date.now()
      }
    } catch {
      // ignore anything that is not JSON
    }
  })
  ws.on('close', () => uiClients.delete(ws))
  ws.on('error', () => uiClients.delete(ws))
}

function onChannel(ws: WebSocket, name: string) {
  // A restarted session replaces its old connection.
  channels.get(name)?.terminate()
  channels.set(name, ws)
  channelConnected(name)

  let alive = true
  ws.on('pong', () => (alive = true))
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, 20_000)

  ws.on('message', async data => {
    let msg: any
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg.type === 'tool') {
      try {
        const result = await handleTool(name, msg.tool, msg.args ?? {})
        ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, result }))
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'tool_result', id: msg.id, error: e?.message ?? String(e) }))
      }
    } else if (msg.type === 'permission_request') {
      permissionRequested(name, msg.params)
    }
  })

  const closed = () => {
    clearInterval(heartbeat)
    if (channels.get(name) === ws) {
      channels.delete(name)
      channelDisconnected(name)
    }
  }
  ws.on('close', closed)
  ws.on('error', closed)
}

// ---------------------------------------------------------------------------------------------

bus.on('trouble', (name: string, status: string, detail: string | null) => {
  const what = status === 'exited' ? 'stopped unexpectedly' : 'needs attention'
  void push.notify({ title: `${name} ${what}`, body: detail ?? 'Open the hub to see its terminal.', session: name, tag: `trouble-${name}` })
})

export async function start() {
  // After a hub restart no channel is connected yet; the channel servers reconnect on their own.
  for (const s of sessions.all()) if (s.channel_connected) sessions.update(s.name, { channel_connected: 0 })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  console.log(`neural listening on http://${config.host}:${config.port}`)

  if (config.autostart && !sessions.get('main')) {
    fs.mkdirSync(config.orchestratorCwd, { recursive: true })
    const guide = path.join(config.orchestratorCwd, 'CLAUDE.md')
    if (!fs.existsSync(guide)) fs.copyFileSync(path.join(ROOT, 'orchestrator/CLAUDE.md'), guide)
    await startSession('main', { cwd: config.orchestratorCwd, role: 'orchestrator', autostart: true })
      .catch(e => console.error('could not start the orchestrator:', e.message))
  }

  // Sessions that were mid-startup when the hub last stopped still need their dialogs answered.
  for (const s of sessions.all()) {
    if (['starting', 'attention'].includes(s.status) && (await mux.alive(s.name))) resumeStartup(s.name)
  }

  // Each job runs on a timer but never overlaps itself: a slow pass (a paste, a restart) finishes first.
  const tick = (fn: () => Promise<void>, ms: number) => {
    let running = false
    setInterval(async () => {
      if (running) return
      running = true
      try {
        await fn()
      } catch (e) {
        console.error(e)
      } finally {
        running = false
      }
    }, ms).unref()
  }
  tick(reconcile, config.reconcileMs)
  tick(retryStale, config.retryMs)
  tick(async () => void (await ingestAll()), config.ingestMs)
  tick(async () => void (await embedPending()), config.embedMs)
  tick(async () => void cleanUnsent(), 60 * 60_000)
  if (config.backups) {
    // Makes today's snapshot if there isn't one: shortly after start, then hourly.
    const snapshot = async () => void backupNow()
    setTimeout(() => snapshot().catch(e => console.error('backup failed:', e)), 60_000).unref()
    tick(snapshot, 60 * 60_000)
  }
  if (config.keepAwake) {
    // caffeinate holds off idle sleep for 45 seconds at a time, renewed while any session is working.
    tick(async () => {
      if (sessions.all().some(s => s.status === 'working')) {
        spawn('caffeinate', ['-i', '-t', '45'], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
      }
    }, 30_000)
  }
  for (const s of sessions.all()) flush(s.name)
  return server
}

export function stop() {
  for (const ws of wss.clients) ws.terminate() // browsers, channel servers and live terminals
  return new Promise(resolve => server.close(resolve))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start().catch(e => {
    console.error(e)
    process.exit(1)
  })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0))
}
