// End-to-end test of the hub with a scripted stand-in for Claude (test/fake-claude.ts) running in real tmux.
// Run with: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neural-test-'))
const port = 17000 + Math.floor(Math.random() * 2000)
const base = `http://127.0.0.1:${port}`
const SOCKET = 'neural-test'
// Reuse the embedding model if this machine already downloaded it (current or pre-rename data folder).
const models = ['neural', 'claude-hub'].map(d => path.join(os.homedir(), '.local/share', d, 'models'))
  .find(d => fs.existsSync(path.join(d, 'Xenova')))

Object.assign(process.env, {
  NEURAL_DATA_DIR: tmp,
  NEURAL_PORT: String(port),
  NEURAL_TMUX_SOCKET: SOCKET,
  NEURAL_CLAUDE_BIN: path.join(here, 'fake-claude'),
  NEURAL_TEST_NODE: process.execPath,
  NEURAL_ORCHESTRATOR_CWD: tmp,
  NEURAL_TRANSCRIPTS_DIR: path.join(tmp, 'transcripts'),
  NEURAL_INGEST_MS: '300',
  // Semantic search runs in the tests only when the embedding model is already on this machine.
  NEURAL_MODELS_DIR: models ?? '',
  NEURAL_EMBEDDINGS: models ? 'on' : 'off',
  NEURAL_EMBED_MS: '300',
  NEURAL_KEEP_AWAKE: 'off',
  NEURAL_AUTO_RELOAD: 'off',
  NEURAL_DISPLAY_NAME: 'Ada',
  NEURAL_MAX_UPLOAD_MB: '5',
  NEURAL_BACKUPS: 'off',
  NEURAL_ACK_TIMEOUT: '2',
  NEURAL_RETRY_MS: '300',
  NEURAL_RECONCILE_MS: '300',
  NEURAL_RESUME_GRACE_MS: '300',
  NEURAL_TEST_AGENTS: path.join(tmp, 'agents.json'),
  NEURAL_RESTART_BACKOFF_MS: '300',
})

const killTmux = () => {
  try {
    execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' })
  } catch {
    // no server running
  }
}

let hub: typeof import('../server/src/index.ts')
let ui: WebSocket
const seen: any[] = []

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) as any }
}
const get = async (url: string) => (await api('GET', url)).body
const say = async (to: string, body: string) => (await api('POST', '/api/messages', { to, body })).body

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}
const session = async (name: string) => (await get('/api/sessions')).find((s: any) => s.name === name)
const idle = (name: string) => until(`${name} idle`, async () => {
  const s = await session(name)
  return s?.status === 'idle' && s.channel_connected ? s : null
})
const messageWhere = (what: string, pred: (m: any) => boolean) =>
  until(what, async () => (await get('/api/messages?limit=500')).find(pred))

before(async () => {
  killTmux()
  hub = await import('../server/src/index.ts')
  await hub.start()
  ui = new WebSocket(`ws://127.0.0.1:${port}/ui`)
  ui.on('message', d => seen.push(JSON.parse(String(d))))
  await new Promise(r => ui.once('open', r))
})

after(async () => {
  ui?.close()
  await hub?.stop()
  killTmux()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the orchestrator starts on boot and reports its Claude session', async () => {
  const main = await idle('main')
  assert.equal(main.role, 'orchestrator')
  await until('session id from the SessionStart hook', async () => (await session('main')).claude_session_id)
})

test('a UI message is pushed through the channel, answered, and acknowledged', async () => {
  const sent = await say('main', 'hello there')
  assert.ok(['pending', 'pushed'].includes(sent.delivery))
  const reply = await messageWhere('reply', m => m.from_name === 'main' && m.body === 'echo: hello there')
  assert.equal(reply.in_reply_to, sent.id)
  assert.equal(reply.source, 'reply')
  const acked = await until('ack', async () => (await get('/api/messages?session=main')).find((m: any) => m.id === sent.id && m.delivery === 'acked'))
  assert.equal(acked.via, 'channel')
  await until('live events', () =>
    seen.some(e => e.type === 'message' && e.message.id === reply.id) && seen.some(e => e.type === 'delivery' && e.message_id === sent.id && e.state === 'acked'))
  await idle('main')
})

test('a send retried with the same key is stored and delivered once', async () => {
  const send = () => api('POST', '/api/messages', { to: 'main', body: 'only once please', client_key: 'k-retry-1' })
  const [a, b] = await Promise.all([send(), send()])
  const c = await send()
  assert.equal(a.status, 200)
  assert.equal(a.body.id, b.body.id)
  assert.equal(a.body.id, c.body.id)
  const copies = (await get('/api/messages?limit=500')).filter((m: any) => m.body === 'only once please')
  assert.equal(copies.length, 1)
  await messageWhere('reply', m => m.from_name === 'main' && m.body === 'echo: only once please')
  await idle('main')
  const replies = (await get('/api/messages?limit=500')).filter((m: any) => m.body === 'echo: only once please')
  assert.equal(replies.length, 1)
})

test('a request body with a character split across chunks arrives intact', async () => {
  const secret = fs.readFileSync(path.join(tmp, 'secret'), 'utf8').trim()
  const body = Buffer.from(JSON.stringify({ message: 'split 🎉 café' }))
  const cut = body.indexOf(Buffer.from('🎉')) + 2 // inside the emoji's four bytes
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/hooks/Notification?session=main&secret=${secret}`,
      headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject)
    req.write(body.subarray(0, cut))
    setTimeout(() => req.end(body.subarray(cut)), 50)
  })
  assert.equal(status, 200)
  const events = await get('/api/events/main')
  const hook = events.find((e: any) => e.event === 'hook:Notification' && e.payload.includes('split'))
  assert.equal(JSON.parse(hook.payload).message, 'split 🎉 café')
})

test('an answer given without the reply tool still reaches the user', async () => {
  const sent = await say('main', 'noreply please')
  const net = await messageWhere('stop-hook message', m => m.source === 'stop_hook' && m.body === `terminal answer to ${sent.id}`)
  assert.equal(net.from_name, 'main')
  await idle('main')
})

test('the orchestrator spawns a worker and the two exchange messages', async () => {
  await say('main', `tool spawn_session ${JSON.stringify({ name: 'w1', cwd: tmp, initial_prompt: 'hi from main' })}`)
  await idle('w1')
  const first = await messageWhere('main -> w1', m => m.from_name === 'main' && m.to_name === 'w1' && m.body === 'hi from main')
  const back = await messageWhere('w1 -> main', m => m.from_name === 'w1' && m.to_name === 'main' && m.body === 'echo: hi from main')
  assert.equal(back.in_reply_to, first.id)
  await until('both acked', async () => {
    const all = await get('/api/messages?limit=500')
    return [first.id, back.id].every(id => all.find((m: any) => m.id === id).delivery === 'acked')
  })
})

test('workers cannot use orchestrator tools', async () => {
  await idle('w1')
  await say('w1', `tool spawn_session ${JSON.stringify({ name: 'w2', cwd: tmp })}`)
  const reply = await messageWhere('refusal', m => m.from_name === 'w1' && m.to_name === 'user' && m.body.startsWith('ERROR'))
  assert.match(reply.body, /only available to the orchestrator/)
  assert.equal(await session('w2'), undefined)
})

test('history is searchable from a session and from the API', async () => {
  await idle('w1')
  await say('w1', 'the staging database password rotation is scheduled for friday')
  await messageWhere('echo', m => m.body.startsWith('echo: the staging database'))
  await idle('w1')
  await say('w1', `tool search_history ${JSON.stringify({ query: 'password rotation' })}`)
  const reply = await messageWhere('search result', m => m.from_name === 'w1' && m.body.includes('"kind": "message"'))
  assert.match(reply.body, /\[password\] \[rotation\]/)
  const hits = await get('/api/search?q=' + encodeURIComponent('rotation friday'))
  assert.ok(hits.length >= 1)
  assert.deepEqual(await get('/api/search?q=' + encodeURIComponent('"); DROP')), [])
})

test('search also matches by meaning', { skip: process.env.NEURAL_EMBEDDINGS === 'off' && 'embedding model not downloaded' }, async () => {
  // No keyword in common with "the staging database password rotation is scheduled for friday".
  const hit = await until('semantic hit', async () => {
    const hits = await get('/api/search?q=' + encodeURIComponent('when do we change the db credentials'))
    return hits.find((h: any) => h.snippet.includes('password rotation'))
  }, 30_000)
  assert.equal(hit.match, 'meaning')
  const both = await get('/api/search?q=' + encodeURIComponent('database password rotation'))
  assert.equal(both[0].match, 'both')
  assert.deepEqual(await get('/api/search?q=' + encodeURIComponent('zzqx vblorp')), [])
})

test('transcripts are archived, searchable, and not duplicated', async () => {
  const dir = path.join(tmp, 'transcripts', '-Users-someone-project')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'abc.jsonl')
  const line = (o: object) => JSON.stringify(o) + '\n'
  const entry = (uuid: string, type: string, content: unknown) =>
    line({ type, uuid, sessionId: 'abc', timestamp: '2026-10-01T10:00:00.000Z', message: { role: type, content } })
  fs.writeFileSync(file,
    line({ type: 'api-request-blob', sessionId: 'abc', message: { role: 'user', content: [{ type: 'text', text: 'kumquat bookkeeping' }] } }) +
    entry('u1', 'user', 'why does the kumquat exporter time out') +
    entry('a1', 'assistant', [{ type: 'thinking', thinking: 'hidden kumquat thoughts' }]) +
    entry('a2', 'assistant', [{ type: 'text', text: 'The exporter retries forever.' }, { type: 'tool_use', name: 'Bash', input: { command: 'grep -r kumquat .' } }]))
  const hits = await until('transcript hits', async () => {
    const h = await get('/api/search?q=kumquat')
    return h.length >= 2 ? h : null
  })
  assert.deepEqual(hits.map((h: any) => h.kind), ['transcript', 'transcript'])
  assert.ok(hits.every((h: any) => h.session === '-Users-someone-project'))
  // The original line is kept, compressed; rows stored as plain text before that are converted.
  const { db } = await import('../server/src/db.ts')
  const { rawLine, compressOldRaw } = await import('../server/src/ingest.ts')
  const stored = db.prepare("SELECT raw FROM transcript_entries WHERE uuid = 'u1'").get() as { raw: Uint8Array }
  assert.ok(stored.raw instanceof Uint8Array)
  assert.equal(JSON.parse(rawLine(stored.raw)).uuid, 'u1')
  db.prepare("UPDATE transcript_entries SET raw = ? WHERE uuid = 'u1'").run(rawLine(stored.raw))
  assert.ok(await compressOldRaw() >= 1)
  const again = db.prepare("SELECT raw FROM transcript_entries WHERE uuid = 'u1'").get() as { raw: Uint8Array }
  assert.equal(JSON.parse(rawLine(again.raw)).uuid, 'u1')
  assert.equal(await compressOldRaw(), 0)
  // A half-written line is ignored until it is complete, and re-reading never duplicates entries.
  fs.appendFileSync(file, entry('u2', 'user', 'second kumquat question').slice(0, 40))
  await new Promise(r => setTimeout(r, 800))
  assert.equal((await get('/api/search?q=kumquat')).length, 2)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, -40) + entry('u2', 'user', 'second kumquat question'))
  await until('appended entry', async () => (await get('/api/search?q=kumquat')).length === 3)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n')) // rewritten, shorter
  await new Promise(r => setTimeout(r, 800))
  assert.equal((await get('/api/search?q=kumquat')).length, 3)
})

test('a permission prompt is relayed to the UI and the verdict goes back', async () => {
  await idle('main')
  await say('main', 'perm check')
  const event = await until('permission event', () => seen.find(e => e.type === 'permission' && e.request.session === 'main'))
  assert.equal(event.request.tool_name, 'Bash')
  assert.equal((await session('main')).status, 'blocked')
  const res = await api('POST', `/api/permissions/${event.request.id}`, { behavior: 'allow' })
  assert.equal(res.status, 200)
  await messageWhere('verdict', m => m.from_name === 'main' && m.body === 'verdict: allow')
  assert.equal((await api('POST', `/api/permissions/${event.request.id}`, { behavior: 'deny' })).status, 400)
  await idle('main')
})

test('a push that is never read falls back to a paste into the terminal', async () => {
  await idle('w1')
  const sent = await say('w1', 'silent treatment')
  const reply = await messageWhere('pasted reply', m => m.from_name === 'w1' && m.body.startsWith('pasted:') && m.body.includes(`msg_id=${sent.id}`))
  assert.match(reply.body, /silent treatment/)
  const row = await until('ack', async () => (await get('/api/messages?session=w1')).find((m: any) => m.id === sent.id && m.delivery === 'acked'))
  assert.equal(row.via, 'paste')
  await idle('w1')
})

test('a crashed session is resumed and queued messages are delivered', async () => {
  const before = await idle('w1')
  await api('POST', '/api/sessions/w1/keys', { keys: ['C-c'] })
  await until('exit noticed', async () => (await session('w1')).status === 'exited')
  const queued = await say('w1', 'are you back')
  await messageWhere('reply after resume', m => m.from_name === 'w1' && m.body === 'echo: are you back' && m.in_reply_to === queued.id)
  const now = await idle('w1')
  assert.equal(now.claude_session_id, before.claude_session_id)
  assert.match((await get('/api/screen/w1')).screen, /resumed/)
})

test('startup dialogs are answered', async () => {
  const res = await api('POST', '/api/sessions', { name: 'dlg1', cwd: tmp, prompt: 'after the dialog' })
  assert.equal(res.status, 200)
  await messageWhere('reply', m => m.from_name === 'dlg1' && m.body === 'echo: after the dialog')
})

test('a stopped session stays stopped', async () => {
  await api('POST', '/api/sessions/w1/stop')
  assert.equal((await session('w1')).status, 'stopped')
  await new Promise(r => setTimeout(r, 1500))
  assert.equal((await session('w1')).status, 'stopped')
  const sent = await say('w1', 'queued while stopped')
  assert.equal(sent.delivery, 'pending')
})

test('the live terminal shows the session and accepts typing', async () => {
  await idle('main')
  assert.equal((await get('/api/state')).liveTerminal, true)
  const term = new WebSocket(`ws://127.0.0.1:${port}/term?name=main&cols=100&rows=30`)
  let output = ''
  term.on('message', d => (output += String(d)))
  await new Promise(r => term.once('open', r))
  // By now the screen has scrolled; any of the lines the stand-in prints will do.
  await until('terminal output', () => /hub:|pasted|fake claude/.test(output))
  // A swipe scrolls tmux back into its history; typing returns to the bottom and reaches Claude.
  const inMode = () => execFileSync('tmux', ['-L', SOCKET, 'display', '-p', '-t', '=main:', '#{pane_in_mode}'], { encoding: 'utf8' }).trim()
  term.send(JSON.stringify({ type: 'scroll', lines: 3 }))
  await until('copy mode', () => inMode() === '1')
  for (const ch of 'typed in the browser') term.send(JSON.stringify({ type: 'input', data: ch }))
  term.send(JSON.stringify({ type: 'input', data: '\r' }))
  await messageWhere('reply to typed text', m => m.from_name === 'main' && m.body === 'pasted: typed in the browser')
  term.close()
  await idle('main')
  // Closing the browser's terminal detaches it; the session keeps running.
  await new Promise(r => setTimeout(r, 300))
  assert.equal((await session('main')).status, 'idle')
  // Two viewers: the one leaving doesn't reset the size under the one still watching; the last one does.
  const width = () => execFileSync('tmux', ['-L', SOCKET, 'display', '-p', '-t', '=main:', '#{window_width}'], { encoding: 'utf8' }).trim()
  const open = (cols: number) => new Promise<WebSocket>(r => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/term?name=main&cols=${cols}&rows=30`)
    ws.once('open', () => r(ws))
  })
  const laptop = await open(120)
  const phone = await open(60)
  await until('phone size', () => width() === '60')
  phone.close()
  await new Promise(r => setTimeout(r, 800))
  assert.notEqual(width(), '200')
  laptop.close()
  await until('startup size', () => width() === '200')
  const refused = new WebSocket(`ws://127.0.0.1:${port}/term?name=nope`)
  await assert.rejects(new Promise((resolve, reject) => (refused.on('open', resolve), refused.on('error', reject))))
})

test('push notifications go out for replies and approvals, unless a tab is in front', async () => {
  const push = await import('../server/src/push.ts')
  const sent: any[] = []
  push.setSender(async (_sub, payload) => void sent.push(JSON.parse(payload)))
  const subscription = { endpoint: 'https://push.example/device-1', keys: { p256dh: 'p', auth: 'a' } }
  assert.equal((await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure.example/x', keys: subscription.keys } })).status, 400)
  assert.equal((await api('POST', '/api/push/subscribe', { subscription })).status, 200)
  assert.equal((await get('/api/push')).subscriptions, 1)

  await idle('main')
  await say('main', 'notify me')
  const first = await until('push for a reply', () => sent.find(n => n.body === 'echo: notify me'))
  assert.deepEqual([first.title, first.session], ['main', 'main'])

  const earlier = seen.filter(e => e.type === 'permission').length
  await say('main', 'perm again')
  const event = await until('permission event', () => seen.filter(e => e.type === 'permission')[earlier])
  await until('push for an approval', () => sent.find(n => n.title === 'main needs approval'))
  await api('POST', `/api/permissions/${event.request.id}`, { behavior: 'deny' })
  await messageWhere('verdict', m => m.from_name === 'main' && m.body === 'verdict: deny')
  await idle('main')

  // With the hub open and in front, nothing is pushed.
  ui.send(JSON.stringify({ type: 'presence', visible: true }))
  await new Promise(r => setTimeout(r, 200))
  const before = sent.length
  await say('main', 'no notification please')
  await messageWhere('reply', m => m.body === 'echo: no notification please')
  await new Promise(r => setTimeout(r, 300))
  assert.equal(sent.length, before)
  ui.send(JSON.stringify({ type: 'presence', visible: false }))

  // A subscription the push service reports as gone is forgotten.
  push.setSender(async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) })
  assert.equal((await api('POST', '/api/push/test')).body.sent, 0)
  assert.equal((await get('/api/push')).subscriptions, 0)
  await idle('main')
})

test('the reload trial loads the code against a snapshot, not the live database', async () => {
  const { newCodeLoads } = await import('../server/src/reload.ts')
  const trials = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`neural-reload-${process.pid}-`))
  assert.equal(await newCodeLoads(), null)
  assert.deepEqual(trials(), []) // the snapshot is removed afterwards
})

test('a backup is a complete, readable copy and old ones are rotated out', async () => {
  const { backupNow, listBackups } = await import('../server/src/backup.ts')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = path.join(tmp, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `neural-2020-01-0${d}.db`), 'old')
  const file = backupNow()
  assert.ok(file && fs.existsSync(file))
  assert.equal(backupNow(), null) // one per day
  assert.equal(listBackups().length, 7)
  assert.ok(!fs.existsSync(path.join(dir, 'neural-2020-01-03.db')))
  const copy = new DatabaseSync(file!, { readOnly: true })
  const live = (await get('/api/messages?limit=500')).length
  assert.equal((copy.prepare('SELECT count(*) AS n FROM messages').get() as any).n, live)
  copy.close()
})

test('state carries the greeting name, session summaries and health', async () => {
  const state = await get('/api/state')
  assert.equal(state.user.name, 'Ada')
  const main = state.sessions.find((s: any) => s.name === 'main')
  assert.ok(main.last_message && typeof main.last_message.body === 'string')
  assert.equal(typeof main.unread, 'number')
  assert.equal(typeof state.health.semantic.chunks, 'number')
  assert.ok('lastBackup' in state.health && 'pushSubscriptions' in state.health)
})

test('unread replies are counted on the server and cleared for every tab', async () => {
  await idle('main')
  const before = (await session('main')).unread
  await say('main', 'count me')
  const reply = await messageWhere('reply', m => m.body === 'echo: count me')
  const after = await until('unread count', async () => {
    const s = await session('main')
    return s.unread > before ? s : null
  })
  assert.equal(after.last_message.id, reply.id)
  assert.equal((await api('POST', '/api/read', { session: 'main', id: reply.id })).status, 200)
  assert.equal((await session('main')).unread, 0)
  assert.ok(seen.some(e => e.type === 'read' && e.session === 'main' && e.unread === 0))
  // Read position never moves backwards.
  await api('POST', '/api/read', { session: 'main', id: 1 })
  assert.equal((await session('main')).unread, 0)
  assert.equal((await api('POST', '/api/read', { session: 'nope', id: 1 })).status, 400)
  await idle('main')
})

test('app routes load the app; only listed packages are served from node_modules', async () => {
  for (const route of ['/', '/s/main', '/timeline', '/search']) {
    const res = await fetch(base + route)
    assert.equal(res.status, 200, route)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  }
  assert.equal((await fetch(base + '/vendor/preact/dist/preact.module.js')).status, 200)
  assert.equal((await fetch(base + '/vendor/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2')).status, 200)
  assert.equal((await fetch(base + '/vendor/ws/index.js')).status, 404) // not a browser package
  assert.equal((await fetch(base + '/vendor/preact/package.json')).status, 404) // not a served file type
  assert.equal((await fetch(base + '/vendor/preact/../ws/index.js')).status, 404)
  assert.equal((await fetch(base + '/missing.js')).status, 404)
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64')
const upload = async (name: string, data: Buffer, type: string) => {
  const res = await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) }, body: data })
  return { status: res.status, body: await res.json() as any }
}
const have = (bin: string) => { try { execFileSync('/usr/bin/which', [bin], { stdio: 'ignore' }); return true } catch { return false } }

test('a photo uploaded with a message reaches the session as a file it can open', async () => {
  await idle('main')
  const up = await upload('screen shot.png', PNG, 'image/png')
  assert.equal(up.status, 200)
  assert.equal(up.body.kind, 'image')
  assert.deepEqual([up.body.width, up.body.height], [2, 2])
  const sent = (await api('POST', '/api/messages', { to: 'main', body: 'what is this?', attachments: [up.body.id] })).body
  assert.equal(sent.attachments.length, 1)
  const reply = await messageWhere('echo with the file', m => m.from_name === 'main' && m.in_reply_to === sent.id)
  assert.match(reply.body, /1 attached file/)
  assert.match(reply.body, /Open images with the Read tool/)
  assert.match(reply.body, /screen shot\.png \(photo, 2×2/)
  const stored = reply.body.match(/\): (\/.+\.png)$/m)[1]
  assert.ok(stored.startsWith(path.join(tmp, 'uploads')) && fs.existsSync(stored))
  // The file is served to the app, including byte ranges for video seeking.
  const file = await fetch(base + up.body.url)
  assert.equal(file.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await file.arrayBuffer()).length, PNG.length)
  const part = await fetch(base + up.body.url, { headers: { range: 'bytes=0-3' } })
  assert.equal(part.status, 206)
  assert.equal((await part.arrayBuffer()).byteLength, 4)
  // An upload belongs to one message only.
  assert.equal((await api('POST', '/api/messages', { to: 'main', body: 'again', attachments: [up.body.id] })).status, 400)
  // A message can be just a photo.
  const only = await upload('b.png', PNG, 'image/png')
  assert.equal((await api('POST', '/api/messages', { to: 'main', body: '', attachments: [only.body.id] })).status, 200)
  await idle('main')
})

test('iPhone photos (HEIC) get a JPEG copy that Claude can read', { skip: !have('sips') && 'needs sips' }, async () => {
  const png = path.join(tmp, 'in.png')
  const heic = path.join(tmp, 'in.heic')
  fs.writeFileSync(png, PNG)
  execFileSync('sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' })
  const up = await upload('IMG_0001.HEIC', fs.readFileSync(heic), 'image/heic')
  assert.equal(up.status, 200)
  assert.ok(up.body.view)
  const view = await fetch(base + up.body.view)
  assert.equal(view.headers.get('content-type'), 'image/jpeg')
})

test('a video arrives with still frames, and the app gets a poster', { skip: !have('ffmpeg') && 'needs ffmpeg' }, async () => {
  await idle('main')
  const mp4 = path.join(tmp, 'clip.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=7:size=320x240:rate=10', '-pix_fmt', 'yuv420p', mp4])
  const up = await upload('clip.mp4', fs.readFileSync(mp4), 'video/mp4')
  assert.equal(up.status, 200)
  assert.equal(up.body.kind, 'video')
  assert.ok(up.body.duration > 6 && up.body.frames >= 3)
  assert.equal((await fetch(base + up.body.poster)).headers.get('content-type'), 'image/jpeg')
  const sent = (await api('POST', '/api/messages', { to: 'main', body: 'watch this', attachments: [up.body.id] })).body
  const reply = await messageWhere('echo with stills', m => m.from_name === 'main' && m.in_reply_to === sent.id)
  assert.match(reply.body, /clip\.mp4 \(video, 0:07, 320×240/)
  assert.match(reply.body, /stills from the video, in order/)
  await idle('main')
})

test('a session can attach a file to its reply', async () => {
  await idle('main')
  const shot = path.join(tmp, 'shot.png')
  fs.writeFileSync(shot, PNG)
  await say('main', `tool reply ${JSON.stringify({ text: 'here is the screenshot', files: [shot] })}`)
  const m = await messageWhere('reply with a file', m => m.from_name === 'main' && m.body === 'here is the screenshot')
  assert.equal(m.attachments.length, 1)
  assert.equal(m.attachments[0].name, 'shot.png')
  const bad = await messageWhere('refusal', m => m.from_name === 'main' && m.body.startsWith('ERROR') && m.body.includes('no such file')
    , 1).catch(() => null)
  assert.equal(bad, null)
  await idle('main')
  await say('main', `tool reply ${JSON.stringify({ text: 'x', files: ['/nope/missing.png'] })}`)
  await messageWhere('missing file refused', m => m.from_name === 'main' && m.body.startsWith('ERROR') && m.body.includes('no such file'))
  await idle('main')
})

test('unsent uploads are cleaned up; sent ones are kept', async () => {
  const { cleanUnsent } = await import('../server/src/files.ts')
  const { db } = await import('../server/src/db.ts')
  const up = await upload('forgotten.png', PNG, 'image/png')
  const file = db.prepare('SELECT path FROM attachments WHERE id = ?').get(up.body.id) as { path: string }
  assert.ok(fs.existsSync(file.path))
  assert.equal(cleanUnsent(24), 0) // too recent
  db.prepare("UPDATE attachments SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(up.body.id)
  const sentBefore = (db.prepare('SELECT count(*) AS n FROM attachments WHERE message_id IS NOT NULL').get() as any).n
  assert.equal(cleanUnsent(24), 1)
  assert.ok(!fs.existsSync(file.path))
  assert.equal((db.prepare('SELECT count(*) AS n FROM attachments WHERE message_id IS NOT NULL').get() as any).n, sentBefore)
})

test('a reconnect does not count as a failed delivery attempt', async () => {
  const { outbox, messages } = await import('../server/src/db.ts')
  const m = messages.insert({ from: 'user', to: 'w1', body: 'x', source: 'ui' })
  outbox.add(m.id, 'w1')
  outbox.markPushed(m.id, 'channel')
  outbox.requeue(m.id, 'channel reconnected')
  outbox.markPushed(m.id, 'channel')
  outbox.requeue(m.id, 'channel reconnected')
  const row = outbox.pending('w1').find(r => r.message_id === m.id)
  assert.equal(row?.attempts, 0)
})

test('the app sees what a session is doing, and Stop interrupts it', async () => {
  const { describeTool } = await import('../server/src/router.ts')
  assert.equal(describeTool('Edit', { file_path: '/repo/src/auth.ts' }), 'Editing auth.ts')
  assert.equal(describeTool('Bash', { command: 'ls -la\nrm x' }), 'Running ls -la')
  assert.equal(describeTool('mcp__neural__send_message', { to: 'api' }), 'Messaging api')
  assert.equal(describeTool('WebFetch', { url: 'https://example.com/a' }), 'Reading example.com')

  await idle('main')
  await say('main', 'slow please')
  const live = await until('activity event', () => seen.find(e => e.type === 'activity' && e.session === 'main' && e.activity?.text === 'Running the test suite'))
  assert.ok(live.activity.since > 0)
  assert.equal((await session('main')).activity.text, 'Running the test suite')
  assert.equal((await api('POST', '/api/sessions/main/interrupt')).status, 200)
  await until('activity cleared', () => seen.some(e => e.type === 'activity' && e.session === 'main' && e.activity === null && seen.indexOf(e) > seen.indexOf(live)))
  await idle('main')
  assert.equal((await session('main')).activity, null)
})

test('slash commands typed in the app run in the session terminal; paths and // do not', async () => {
  const { isCommand } = await import('../server/src/router.ts')
  assert.ok(isCommand('/model sonnet') && isCommand('/compact') && isCommand('/effort max'))
  assert.ok(!isCommand('/Users/me/notes.txt what is this') && !isCommand('//model') && !isCommand('hello /model'))

  await idle('main')
  const sent = (await api('POST', '/api/messages', { to: 'main', body: '/effort max' })).body
  assert.equal(sent.source, 'command')
  // The stand-in treats what is typed into its terminal as a prompt and echoes it.
  await messageWhere('typed into the terminal', m => m.from_name === 'main' && m.body === 'pasted: /effort max')
  await idle('main')
  const literal = (await api('POST', '/api/messages', { to: 'main', body: '//model is a word' })).body
  assert.equal(literal.body, '/model is a word')
  await messageWhere('sent to Claude', m => m.in_reply_to === literal.id && m.body === 'echo: /model is a word')
  await idle('main')
  assert.equal((await api('POST', '/api/messages', { to: 'w1', body: '/model' })).status, 400) // w1 is stopped
})

test('each session shows the model and effort it is using', async () => {
  await idle('main')
  assert.equal((await session('main')).effort, 'high') // from the Stop hook
  const { handleHook } = await import('../server/src/router.ts')
  handleHook('main', 'PostModelSwitch', { to_model: 'claude-sonnet-5-5' })
  assert.equal((await session('main')).model, 'claude-sonnet-5-5')
  assert.ok(seen.some(e => e.type === 'session' && e.session.name === 'main' && e.session.model === 'claude-sonnet-5-5'))
  // Transcripts carry the exact model of each reply.
  const id = (await session('main')).claude_session_id
  const dir = path.join(tmp, 'transcripts', 'main-project')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: 'm1', sessionId: id, timestamp: new Date().toISOString(), effort: 'max',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }] },
  }) + '\n')
  await until('model from transcript', async () => (await session('main')).model === 'claude-opus-5-5')
  // A /model or /effort run in the terminal records its result in the transcript.
  const { modelInfo } = await import('../server/src/ingest.ts')
  const cmd = (text: string) => ({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` } })
  assert.deepEqual(modelInfo(cmd('Set model to `Opus 5.5` and saved as your default for new sessions')), { model: 'Opus 5.5', effort: undefined })
  assert.deepEqual(modelInfo(cmd('Set effort level to xhigh (saved as your default for new sessions)')), { model: undefined, effort: 'xhigh' })
  assert.equal(modelInfo(cmd('Context left: 40%')), null)
  assert.equal(modelInfo({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } }), null)
  assert.equal((await session('main')).effort, 'max')
})

test('a usage limit is shown, not left spinning as "working"', async () => {
  const { resetTime, handleHook } = await import('../server/src/router.ts')
  const base = new Date(2026, 10, 12, 18, 55).getTime()
  assert.equal(new Date(resetTime('resets 8:20pm (America/New_York)', base)!).getHours(), 20)
  assert.equal(new Date(resetTime('resets 1am', base)!).getDate(), 13) // already past today: tomorrow
  assert.equal(resetTime('no time here'), null)

  await idle('main')
  await say('main', 'slow and long')
  // Wait for the stand-in's own tool report first; a real session reports nothing after its turn has failed.
  await until('working', async () => (await session('main')).activity?.text === 'Running the test suite')
  // Claude Code ends the turn with StopFailure and an error reply in the transcript, worded differently;
  // together they make one message, and the status keeps the wording that says when the limit resets.
  handleHook('main', 'StopFailure', { error: { type: 'rate_limit', message: 'Usage limit reached' } })
  const id = (await session('main')).claude_session_id
  const dir = path.join(tmp, 'transcripts', 'main-project')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: 'err1', sessionId: id, timestamp: new Date().toISOString(), isApiErrorMessage: true, error: 'rate_limit',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 8:20pm" }] },
  }) + '\n')
  const s = await until('limited', async () => {
    const x = await session('main')
    return x.status === 'limited' ? x : null
  })
  assert.equal(s.activity, null)
  assert.notEqual(s.model, '<synthetic>')
  await new Promise(r => setTimeout(r, 800)) // let the transcript copy be read too
  const notes = (await get('/api/messages?session=main')).filter((m: any) => m.source === 'error')
  assert.equal(notes.length, 1)
  assert.match(notes[0].body, /Usage limit reached/)
  assert.match((await session('main')).status_detail, /resets 8:20pm/)
  // A tool call after the reset means it is working again.
  handleHook('main', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/y.ts' } })
  assert.equal((await session('main')).status, 'working')
  await api('POST', '/api/sessions/main/interrupt')
  await idle('main')
})

test('a session cut off by a usage limit carries on by itself once the limit resets', async () => {
  const { turnFailed, limitReset } = await import('../server/src/router.ts')
  await idle('main')
  await turnFailed('main', "You've hit your 5-hour limit · resets 9:40pm", 'rate_limit')
  assert.equal((await session('main')).status, 'limited')
  const note = (await get('/api/messages?session=main')).filter((m: any) => m.source === 'error').at(-1)
  assert.match(note.body, /Neural tells the session to carry on/)
  // The reset passes (reconcile notices it from the status text; here it is triggered directly).
  limitReset('main', Date.now() - 1000)
  assert.equal((await session('main')).status, 'idle')
  const nudge = await messageWhere('the nudge', (m: any) => m.from_name === 'system' && m.to_name === 'main' && /usage limit has reset/.test(m.body))
  await messageWhere('the carried-on reply', (m: any) => m.from_name === 'main' && m.to_name === 'user' && m.body.startsWith('echo: Your usage limit has reset'))
  await messageWhere('the note to the user', (m: any) => m.from_name === 'main' && m.source === 'system' && /Neural told main to carry on/.test(m.body))
  // Exactly one nudge.
  await new Promise(r => setTimeout(r, 1000))
  const nudges = (await get('/api/messages?limit=500')).filter((m: any) => m.from_name === 'system' && m.to_name === 'main')
  assert.deepEqual(nudges.map((m: any) => m.id), [nudge.id])
  await idle('main')
})

test('the changes view and turn recaps read the session\'s repository', async () => {
  const git = await import('../server/src/git.ts')
  const { handleHook } = await import('../server/src/router.ts')
  const { sessions: rows, messages } = await import('../server/src/db.ts')
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo })
  run('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
  fs.writeFileSync(path.join(repo, 'left-alone.txt'), 'x\n')
  run('add', '.')
  run('commit', '-qm', 'First')
  fs.writeFileSync(path.join(repo, 'left-alone.txt'), 'dirty before the turn\n') // dirty, and not touched by the turn

  assert.equal(await git.changes(tmp + '/transcripts'), null) // not a repository
  const before = await git.changes(repo)
  assert.equal(before!.branch, 'main')
  assert.equal(before!.upstream, null)
  assert.deepEqual(before!.files, [{ path: 'left-alone.txt', code: 'M' }])
  assert.equal(before!.commits[0].subject, 'First')

  // A turn in a session working there: one commit, one new file, one edit left uncommitted.
  rows.create('repo-work', 'worker', repo, false)
  handleHook('repo-work', 'UserPromptSubmit', { prompt: 'do it' })
  await new Promise(r => setTimeout(r, 300)) // the snapshot is taken in the background
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n')
  run('commit', '-qm', 'Second', '--', 'a.txt')
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n')
  const reply = messages.insert({ from: 'repo-work', to: 'user', body: 'Done.', source: 'reply' })
  handleHook('repo-work', 'Stop', { last_assistant_message: 'Done.' })
  // The recap goes on the turn's last message to the user (here the reply, then the terminal-answer copy of it).
  const recap = await until('recap', () => {
    const meta = messages.thread('repo-work').filter(m => m.to_name === 'user' && m.id >= reply.id).at(-1)?.meta
    return meta ? JSON.parse(meta).recap : null
  })
  // left-alone.txt was dirty before and untouched, so it doesn't count; a.txt (committed) and new.txt do.
  assert.deepEqual(recap, { commits: 1, files: 2, insertions: 2, deletions: 1, unpushed: null, branch: 'main' })

  // Diffs: everything uncommitted (untracked files included), and one commit.
  const work = await git.diff(repo)
  assert.match(work!.diff, /left-alone\.txt/)
  assert.match(work!.diff, /\+hello/)
  const sha = (await git.changes(repo))!.commits[0].sha
  assert.match((await git.diff(repo, sha))!.diff, /\+TWO/)
  await assert.rejects(git.diff(repo, 'HEAD; rm -rf /'), /not a commit id/)

  // Over HTTP.
  assert.equal((await get('/api/changes/main')).changes, null)
  assert.equal((await get('/api/changes/repo-work')).changes.commits.length, 2)
  assert.equal((await api('GET', '/api/changes/repo-work/diff?ref=nope')).status, 400)
  await (await import('../server/src/spawner.ts')).removeSession('repo-work')
})

test('the status line feeds the usage and context meter', async () => {
  await idle('main')
  const reset = Math.floor(Date.now() / 1000) + 3600
  const reading = {
    context_window: { used_percentage: 41.4, context_window_size: 1_000_000 },
    cost: { total_cost_usd: 1.234 },
    rate_limits: { five_hour: { used_percentage: 62, resets_at: reset }, seven_day: { used_percentage: 41, resets_at: reset + 86400 } },
  }
  await say('main', `usage ${JSON.stringify(reading)}`)
  const m = await messageWhere('the status line output', (m: any) => m.from_name === 'main' && m.body.startsWith('status line: '))
  assert.match(m.body, /^status line: context 41% · 5-hour 62% \(resets \d\d:\d\d\) · week 41%$/)
  assert.deepEqual((await get('/api/state')).usage.five_hour, { used: 62, resets_at: reset })
  const ctx = (await session('main')).context
  assert.deepEqual([ctx.used, ctx.size, ctx.cost], [41, 1_000_000, 1.234])
  assert.ok(seen.some(e => e.type === 'usage' && e.account?.seven_day?.used === 41))
  assert.ok(seen.some(e => e.type === 'usage' && e.session === 'main' && e.context.used === 41))
  // A reading without limits (an API-key session, or before the first reply) keeps the last known ones.
  const usage = await import('../server/src/usage.ts')
  assert.match(usage.record('main', { context_window: { used_percentage: 50 } }), /^context 50% · 5-hour 62% \(resets .*\) · week 41%$/)
  assert.equal((await get('/api/state')).usage.five_hour.used, 62)
  assert.equal(usage.record('nobody', reading), '')
  // A window past its reset time is left out of the terminal line.
  assert.equal(usage.line(null, { five_hour: { used: 90, resets_at: 1 }, seven_day: null, at: '' }), '')
  await idle('main')
})

test('a stuck "working" status is settled by what Claude Code reports, busy or idle', async () => {
  const { settleIfIdle } = await import('../server/src/router.ts')
  const agents = process.env.NEURAL_TEST_AGENTS!
  await idle('main')
  await say('main', 'slow turn')
  await until('working', async () => (await session('main')).activity?.text === 'Running the test suite')
  const id = (await session('main')).claude_session_id
  const report = (status: string) => fs.writeFileSync(agents, JSON.stringify([{ pid: 1, cwd: tmp, kind: 'interactive', sessionId: id, name: 'main', status }]))
  report('busy')
  await settleIfIdle('main')
  assert.equal((await session('main')).status, 'working')
  await new Promise(r => setTimeout(r, 2100)) // past the cached answer
  report('idle')
  await settleIfIdle('main')
  assert.equal((await session('main')).status, 'idle')
  fs.rmSync(agents)
  await api('POST', '/api/sessions/main/interrupt') // end the stand-in's turn too
  await idle('main')
})

test('uploads over the size limit are refused', async () => {
  const res = await upload('big.bin', Buffer.alloc(6 * 2 ** 20), 'application/octet-stream')
  assert.equal(res.status, 413)
  assert.match(res.body.error, /too large/)
})

test('requests from other origins and without the secret are refused', async () => {
  assert.equal((await api('GET', '/api/sessions', undefined, { origin: 'http://evil.example' })).status, 403)
  // DNS rebinding: a page on a domain resolving to 127.0.0.1 sends matching Origin and Host headers.
  const rebound = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/sessions', headers }, res => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject)
  })
  assert.equal(await rebound({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), 403)
  assert.equal(await rebound({ host: `evil.example:${port}`, 'x-forwarded-host': `127.0.0.1:${port}` }), 403)
  assert.equal(await rebound({ host: `localhost:${port}`, origin: `http://localhost:${port}` }), 200)
  const { hostAllowed } = await import('../server/src/index.ts')
  assert.ok(hostAllowed('my-mac.tail1234.ts.net'))
  assert.ok(!hostAllowed('ts.net.evil.example'))
  assert.ok(!hostAllowed(undefined))
  assert.equal((await api('POST', '/hooks/Stop?session=main&secret=nope', {})).status, 403)
  assert.equal((await api('POST', '/api/sessions', { name: 'Bad Name', cwd: tmp })).status, 400)
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/channel?name=main&secret=wrong`)
    ws.on('open', resolve)
    ws.on('error', reject)
  }))
})

test('keysForOption picks the right keys for a select dialog', async () => {
  const { keysForOption } = await import('../server/src/spawner.ts')
  const want = /local development/i
  assert.deepEqual(keysForOption('❯ 1. Exit\n  2. I am using this for local development', want), ['Down', 'Enter'])
  assert.deepEqual(keysForOption('❯ 1. I am using this for local development\n  2. Exit', want), ['Enter'])
  assert.deepEqual(keysForOption('  1. Exit\n  2. I am using this for local development', want), ['2'])
  assert.deepEqual(keysForOption('❯ I am using this for local development\n  Exit', want), ['Enter'])
  assert.deepEqual(keysForOption('❯ Exit\n  I am using this for local development', want), ['Down', 'Enter'])
  const trust = [' Accessing workspace:', '', ' /Users/me/project', '', ' Quick safety check: Is this a project you created or one you trust?', '',
    ' Security guide', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n')
  const yes = /^\W*(\d+\.\s*)?Yes/i
  assert.deepEqual(keysForOption(trust, yes), ['Down', 'Enter'])
  assert.deepEqual(keysForOption(trust.replace(' ❯ No, exit', '   No, exit').replace('   Yes,', ' ❯ Yes,'), yes), ['Enter'])
  assert.equal(keysForOption(trust, /Maybe later/), null)
  assert.equal(keysForOption('nothing here', want), null)
})
