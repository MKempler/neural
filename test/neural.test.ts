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
// The claude program the hub runs: a wrapper around the stand-in, so a test can break the install and fix it.
const claudeBin = path.join(tmp, 'bin/claude')
const workingClaude = () => {
  fs.mkdirSync(path.dirname(claudeBin), { recursive: true })
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec '${path.join(here, 'fake-claude')}' "$@"\n`, { mode: 0o755 })
}
workingClaude()
const models = ['neural', 'claude-hub'].map(d => path.join(os.homedir(), '.local/share', d, 'models'))
  .find(d => fs.existsSync(path.join(d, 'Xenova')))

Object.assign(process.env, {
  NEURAL_DATA_DIR: tmp,
  NEURAL_PORT: String(port),
  NEURAL_TMUX_SOCKET: SOCKET,
  NEURAL_CLAUDE_BIN: claudeBin,
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
  NEURAL_PROJECTS_ROOT: path.join(tmp, 'projects'),
  NEURAL_REFRESH_IDLE_MS: '500',
  NEURAL_RESTART_BACKOFF_MS: '300',
  NEURAL_RECOVERED_MS: '500',
  NEURAL_JOBS_MS: '300',
  NEURAL_HANDOFF_IDLE_MS: '300',
  NEURAL_JOB_POLL_MS: '100',
  NEURAL_STARTUP_ATTENTION_MS: '2000',
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
  assert.match(m.body, /^status line: context 41% · 5-hour 62% \(resets (?:\w{3} )?\d{1,2}:\d\d [ap]m\) · week 41%$/)
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

test('quick replies are shared by every device, and suggested from what the user often sends', async () => {
  assert.deepEqual((await get('/api/state')).quickReplies.slice(0, 2), ['Continue', 'Go ahead'])
  const saved = await api('PUT', '/api/prefs/quickReplies', { replies: [' Ship it ', 'Ship it', '', 'Keep going'] })
  assert.deepEqual(saved.body.quickReplies, ['Ship it', 'Keep going'])
  assert.deepEqual((await get('/api/state')).quickReplies, ['Ship it', 'Keep going'])
  assert.ok(seen.some(e => e.type === 'prefs' && e.quickReplies?.[0] === 'Ship it'))
  assert.equal((await api('PUT', '/api/prefs/quickReplies', { replies: 'nope' })).status, 400)
  assert.equal((await api('PUT', '/api/prefs/somethingElse', { replies: [] })).status, 404)
  const { messages } = await import('../server/src/db.ts')
  for (const body of ['go ahead', 'Go ahead.', 'go ahead!']) messages.insert({ from: 'user', to: 'main', body, source: 'ui' })
  const { replies } = await get('/api/prefs/suggestions')
  assert.ok(replies.some((r: any) => /^go ahead/i.test(r.body) && r.n >= 3))
})

test('new projects are created in the projects folder, from the app and by the orchestrator', async () => {
  const root = path.join(tmp, 'projects')
  assert.deepEqual((await get('/api/projects')).folders, [])
  const made = await api('POST', '/api/projects', { name: 'alpha' })
  assert.equal(made.body.path, path.join(root, 'alpha'))
  assert.ok(fs.existsSync(path.join(root, 'alpha/.git')))
  fs.mkdirSync(path.join(root, 'plain'))
  const { folders } = await get('/api/projects')
  assert.deepEqual(folders.map((f: any) => [f.name, f.git, f.branch]).sort(), [['alpha', true, 'main'], ['plain', false, null]])
  // Never outside the projects folder, never over an existing folder.
  assert.match((await api('POST', '/api/projects', { name: 'alpha' })).body.error, /already exists/)
  for (const name of ['../evil', 'Up', '', '.hidden', 'a/b']) assert.equal((await api('POST', '/api/projects', { name })).status, 400, name)
  for (const repo of ['nope', '../x/y', 'a/b/c', 'owner/..']) assert.equal((await api('POST', '/api/projects/clone', { repo })).status, 400, repo)
  assert.ok(!fs.existsSync(path.join(tmp, 'evil')))
  const { sessionName } = await import('../server/src/projects.ts')
  assert.equal(sessionName('My.Cool_Project'), 'my-cool_project')

  // The orchestrator starts a session in a new project.
  await idle('main')
  await say('main', 'tool spawn_session {"name":"beta","new_project":true}')
  const started = await messageWhere('spawned', (m: any) => m.from_name === 'main' && /"started":\s*"beta"/.test(m.body))
  assert.ok(started.body.includes(path.join(root, 'beta')), started.body)
  assert.equal((await session('beta')).cwd, path.join(root, 'beta'))
  assert.ok(fs.existsSync(path.join(root, 'beta/.git')))
  await (await import('../server/src/spawner.ts')).removeSession('beta')
  await idle('main')
})

test('dialogs: options are read from below the question, not from the plan or the prompt above', async () => {
  const { dialogOptions, showsQuestion, showsPlan, checkAnswers } = await import('../server/src/dialogs.ts')
  const ask = [
    '❯ Use the AskUserQuestion tool: (1) "Which color?" options 1. Red 2. Green',
    '←  ☐ Color  ☐ Size  ✔ Submit  →', 'Which color?', '❯ 1. Red', '     Red', '  2. Green', '     Green', '  3. Type something.',
    '────', '  4. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n')
  assert.ok(showsQuestion(ask, 'Which color?'))
  assert.ok(!showsQuestion(ask, 'Which sizes?'))
  assert.deepEqual(dialogOptions(ask, 'Which color?').map(o => [o.n, o.label, o.cursor]),
    [['1', 'Red', true], ['2', 'Green', false], ['3', 'Type something.', false], ['4', 'Chat about this', false]])
  const multi = 'Which sizes?\n❯ 1. [ ] Small\n  2. [✔] Large\n  3. [ ] Type something\n     Submit\nEsc to cancel'
  assert.deepEqual(dialogOptions(multi, 'Which sizes?').map(o => o.label), ['Small', 'Large', 'Type something'])
  const plan = [' Ready to code?', ' 1. Create hello.txt', ' 2. Check it', ' Would you like to proceed?', ' ❯ 1. Yes, and use auto mode', '   2. Yes, manually approve edits', '   3. Tell Claude what to change'].join('\n')
  assert.ok(showsPlan(plan))
  assert.deepEqual(dialogOptions(plan, /would you like to proceed\?/i).map(o => o.label), ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'])
  const qs = [{ question: 'A?', options: [{ label: 'x' }, { label: 'y' }] }, { question: 'B?', multiSelect: true, options: [{ label: 'p' }] }]
  checkAnswers(qs, [{ choose: [1] }, { choose: [0] }])
  checkAnswers(qs, [{ text: 'my own' }, { choose: [0] }])
  assert.throws(() => checkAnswers(qs, [{ choose: [1] }]), /every question/)
  assert.throws(() => checkAnswers(qs, [{ choose: [5] }, { choose: [0] }]), /no such option/)
  assert.throws(() => checkAnswers(qs, [{ choose: [0], text: 'both' }, { choose: [0] }]), /pick one option/)
  assert.throws(() => checkAnswers(qs, [{ choose: [0] }, { choose: [] }]), /at least one/)
})

test("Claude's questions and plans are answered from the app", async () => {
  const open = () => until('an open question', async () => (await get('/api/state')).questions.find((q: any) => q.session === 'main'))
  await idle('main')
  const questions = [
    { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'warm' }, { label: 'Green' }, { label: 'Blue' }] },
    { question: 'Which sizes?', header: 'Size', multiSelect: true, options: [{ label: 'Small' }, { label: 'Large' }] },
  ]
  await say('main', `ask ${JSON.stringify({ questions })}`)
  let q = await open()
  assert.equal(q.kind, 'question')
  assert.equal((await session('main')).status, 'blocked')
  assert.ok(seen.some(e => e.type === 'question' && e.question.id === q.id))
  assert.equal((await api('POST', `/api/questions/${q.id}`, { answers: [{ choose: [1] }] })).status, 400) // one answer short
  assert.deepEqual((await api('POST', `/api/questions/${q.id}`, { answers: [{ choose: [1] }, { choose: [0, 1] }] })).body, { ok: true })
  await messageWhere('the answers', (m: any) => m.from_name === 'main' && m.body === 'answered: Green | Small, Large')
  assert.ok(seen.some(e => e.type === 'question_closed' && e.id === q.id))
  assert.equal((await api('POST', `/api/questions/${q.id}`, { answers: [{ choose: [1] }, { choose: [0] }] })).status, 400) // already answered
  await idle('main')

  // A typed answer.
  await say('main', `ask ${JSON.stringify({ questions: [{ question: 'Pick a fruit?', header: 'Fruit', options: [{ label: 'Apple' }, { label: 'Pear' }] }] })}`)
  q = await open()
  await api('POST', `/api/questions/${q.id}`, { answers: [{ text: 'Mango, ripe' }] })
  await messageWhere('the typed answer', (m: any) => m.from_name === 'main' && m.body === 'answered: Mango, ripe')
  await idle('main')

  // A plan whose own numbered steps must not be mistaken for the dialog's options.
  await say('main', 'plan 1. Create hi.txt\n2. Check it')
  q = await open()
  assert.equal(q.kind, 'plan')
  assert.match(q.payload.plan, /Create hi\.txt/)
  await api('POST', `/api/questions/${q.id}`, { approve: false, feedback: 'Name it hello.txt' })
  await messageWhere('the feedback', (m: any) => m.from_name === 'main' && m.body === 'plan feedback: Name it hello.txt')
  await idle('main')
  await say('main', 'plan 1. Create hello.txt')
  q = await open()
  await api('POST', `/api/questions/${q.id}`, { approve: true })
  await messageWhere('the approval', (m: any) => m.from_name === 'main' && m.body === 'plan: approved, auto')
  await idle('main')

  // Answered in the terminal instead: the card goes away, and a late answer from the app is refused.
  await say('main', `ask ${JSON.stringify({ questions: [{ question: 'Terminal or app?', header: 'Where', options: [{ label: 'Terminal' }, { label: 'App' }] }] })}`)
  q = await open()
  await (await import('../server/src/spawner.ts')).mux.sendKeys('main', ['1'])
  await messageWhere('answered in the terminal', (m: any) => m.from_name === 'main' && m.body === 'answered: Terminal')
  await until('closed', async () => !(await get('/api/state')).questions.length)
  assert.equal((await api('POST', `/api/questions/${q.id}`, { answers: [{ choose: [1] }] })).status, 400)
  await idle('main')
})

test('secrets are kept out of the archive, but reach the session they were sent to', async () => {
  const { redact } = await import('../server/src/redact.ts')
  const hf = 'hf_' + 'Q7'.repeat(17)
  const cases: [string, string][] = [
    [`my token is ${hf} ok`, 'my token is [redacted Hugging Face token] ok'],
    ['OPENAI_API_KEY=sk-proj-' + 'Ab1'.repeat(15), 'OPENAI_API_KEY=[redacted OpenAI key]'],
    ['sk-ant-api03-' + 'x9'.repeat(20), '[redacted Anthropic key]'],
    ['https://bob:hunter2long@github.com/x', 'https://bob:[redacted password]@github.com/x'],
    ['{"password":"' + 'Zx9'.repeat(7) + '"}', '{"password":"[redacted secret]"}'],
    ['ghp_' + 'A1'.repeat(18), '[redacted GitHub token]'],
    ['aws AKIAIOSFODNN7EXAMPLE here', 'aws [redacted AWS key] here'],
    ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '[redacted private key]'],
  ]
  for (const [input, want] of cases) assert.equal(redact(input).text, want)
  // Ordinary text and code are left alone.
  for (const keep of ['const token = process.env.GITHUB_TOKEN', 'max_tokens: 1000000', 'commit 3f2a9c1e5b7d9f0a1c3e5b7d9f0a1c3e5b7d9f0a', 'the secret sauce'])
    assert.equal(redact(keep).text, keep)

  // A message with a token: stored and shown redacted, delivered to the session as written.
  await idle('main')
  const sent = await say('main', `use ${hf} please`)
  assert.equal(sent.body, 'use [redacted Hugging Face token] please')
  assert.deepEqual(JSON.parse(sent.meta).redacted, ['Hugging Face token'])
  const reply = await messageWhere('the echo', (m: any) => m.in_reply_to === sent.id)
  assert.equal(reply.body, 'echo: use [redacted Hugging Face token] please') // the session's own copy is redacted when stored
  const { mux } = await import('../server/src/spawner.ts')
  assert.ok((await mux.capture('main', 200)).includes(hf), 'the session received the token')
  const { db, events } = await import('../server/src/db.ts')
  assert.ok(!JSON.stringify(events.recent('main', 200)).includes(hf), 'hook payloads are redacted')
  await idle('main')

  // Archived transcripts: the text and the original line.
  const id = (await session('main')).claude_session_id
  const dir = path.join(tmp, 'transcripts', 'main-project')
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({
    type: 'user', uuid: 'secret-1', sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: `here: ${hf}` },
  }) + '\n')
  const { rawLine } = await import('../server/src/ingest.ts')
  const entry = await until('archived', () => db.prepare("SELECT text, raw FROM transcript_entries WHERE uuid = 'secret-1'").get() as any)
  assert.equal(entry.text, 'here: [redacted Hugging Face token]')
  assert.ok(!rawLine(entry.raw).includes(hf) && rawLine(entry.raw).includes('[redacted Hugging Face token]'))

  // What was stored before redaction existed is cleaned once, search indexes included.
  const { messages, prefs } = await import('../server/src/db.ts')
  const old = db.prepare("INSERT INTO messages (from_name, to_name, body, source) VALUES ('user', 'main', ?, 'ui')").run(`old ${hf}`)
  db.prepare("INSERT INTO transcript_entries (claude_session_id, uuid, role, text, raw) VALUES ('x', 'secret-2', 'user', ?, ?)").run(`older ${hf}`, `{"t":"${hf}"}`)
  const hits = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(`"${hf.slice(3)}"`) as any).n
  assert.equal(hits('messages_fts'), 1)
  assert.equal(hits('transcript_fts'), 1)
  prefs.set('scrubVersion', 0)
  const { scrubArchive } = await import('../server/src/scrub.ts')
  const counts = await scrubArchive()
  assert.equal(counts!.messages, 1)
  assert.equal(counts!.transcripts, 1)
  assert.equal(messages.get(Number(old.lastInsertRowid))!.body, 'old [redacted Hugging Face token]')
  assert.equal(hits('messages_fts'), 0)
  assert.equal(hits('transcript_fts'), 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'redacted'").get() as any).n > 0, true)
  const raw2 = (db.prepare("SELECT raw FROM transcript_entries WHERE uuid = 'secret-2'").get() as any).raw
  assert.ok(!rawLine(raw2).includes(hf))
  assert.equal(await scrubArchive(), null) // once
})

test('a session started with an older setup is restarted once idle, and resumes its conversation', async () => {
  const { sessions: rows, events } = await import('../server/src/db.ts')
  const { launchRev } = await import('../server/src/spawner.ts')
  await idle('main')
  const before = await session('main')
  assert.equal(before.launch_rev, launchRev(rows.get('main')!)) // recorded at launch, so nothing restarts by itself
  rows.update('main', { launch_rev: 'older' })
  const refresh = await until('the refresh', () => events.recent('main', 50).find((e: any) => e.event === 'refresh'), 20_000)
  assert.equal(JSON.parse(refresh.payload).from, 'older')
  const after = await until('back up with the new setup', async () => {
    const s = await session('main')
    return s.status === 'idle' && s.channel_connected && s.launch_rev !== 'older' ? s : null
  }, 20_000)
  assert.equal(after.claude_session_id, before.claude_session_id) // resumed, not a new conversation
  assert.equal(after.launch_rev, launchRev(rows.get('main')!))
})

test('why a session exited: the cause, and how to fix a broken install', async () => {
  const health = await import('../server/src/health.ts')
  assert.equal(health.looksLikeInstall('zsh:1: permission denied: /x/bin/claude\n\nPane is dead (status 126, Mon Nov 16)', 126), true)
  assert.equal(health.looksLikeInstall('zsh:1: command not found: claude', null), true)
  assert.equal(health.looksLikeInstall('Goodbye!', 0), false)
  assert.match(health.exitReason({ code: 1, signal: null }, 'No conversation found with session ID: abc\nPane is dead (status 1)'), /status 1: "No conversation found/)
  assert.match(health.exitReason({ code: null, signal: 9 }, ''), /SIGKILL/)
  assert.match(health.exitReason(null, ''), /terminal is gone/)
  // An npm update that failed partway: a stub where the program should be, and the old copy beside it.
  const prefix = path.join(tmp, 'npm-prefix')
  const scope = path.join(prefix, 'lib/node_modules/@anthropic-ai')
  fs.mkdirSync(path.join(scope, 'claude-code/bin'), { recursive: true })
  fs.mkdirSync(path.join(scope, '.claude-code-1L0AhRWa/bin'), { recursive: true })
  fs.writeFileSync(path.join(scope, 'claude-code/bin/claude.exe'), 'claude native binary not installed\n')
  fs.mkdirSync(path.join(prefix, 'bin'))
  fs.symlinkSync('../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', path.join(prefix, 'bin/claude'))
  const check = await health.checkClaude(path.join(prefix, 'bin/claude'))
  assert.equal(check.ok, false)
  if (check.ok) return
  assert.match(check.reason, /not executable/)
  assert.match(check.hint, /\.claude-code-1L0AhRWa/)
  assert.match(check.hint, /npm install -g @anthropic-ai\/claude-code/)
  assert.equal((await health.checkClaude(claudeBin)).ok, true)
})

const fromNeural = async (about: string) => (await get('/api/messages?limit=500'))
  .filter((m: any) => m.from_name === 'neural' && m.to_name === 'main' && m.body.includes(`${about}`))

test('a broken Claude Code install is named as the cause, costs no restarts, and the session returns once fixed', async () => {
  await api('POST', '/api/sessions', { name: 'hw', cwd: tmp, prompt: 'hello hw' })
  await messageWhere('hw answers', m => m.from_name === 'hw' && m.body === 'echo: hello hw')
  await idle('hw')
  // The install breaks under it (an update left a stub that can't run), then the session crashes.
  fs.writeFileSync(claudeBin, '#!/bin/sh\necho "claude native binary not installed" >&2\nexit 126\n', { mode: 0o755 })
  await api('POST', '/api/sessions/hw/keys', { keys: ['C-c'] })
  const crashed = await messageWhere('main told of the crash', m => m.from_name === 'neural' && /\*\*hw stopped unexpectedly\*\*/.test(m.body))
  assert.equal(crashed.to_name, 'main')
  assert.match(crashed.body, /status 130/)
  const broken = await messageWhere('main told the cause', m => m.from_name === 'neural' && /install is broken\*\*, so hw/.test(m.body))
  assert.match(broken.body, /status 126: "claude native binary not installed"/)
  const s = await session('hw')
  assert.equal(s.status, 'exited')
  const down = JSON.parse(s.down)
  assert.equal(down.kind, 'install')
  assert.equal(down.retry_at, null)
  await new Promise(r => setTimeout(r, 1500)) // a few reconcile passes
  assert.equal((await session('hw')).restarts, 0)
  assert.equal((await fromNeural('hw')).length, 2) // nothing repeated
  // Starting it by hand says why it can't.
  const res = await api('POST', '/api/sessions/hw/restart')
  assert.notEqual(res.status, 200)
  assert.match(res.body.error, /install is broken/)
  // Fixed: it comes back by itself, and main hears so once.
  workingClaude()
  await idle('hw')
  await messageWhere('main told it is healthy', m => m.from_name === 'neural' && /\*\*hw is healthy again\*\*/.test(m.body))
  assert.equal((await session('hw')).down, null)
  assert.equal((await fromNeural('hw')).length, 3)
})

test('a new session that dies before its first prompt starts afresh, and still gets the prompt', async () => {
  const { events } = await import('../server/src/db.ts')
  fs.writeFileSync(path.join(tmp, 'crash-once-crashy1'), '')
  await api('POST', '/api/sessions', { name: 'crashy1', cwd: tmp, prompt: 'first words' })
  await messageWhere('the first prompt answered', m => m.from_name === 'crashy1' && m.body === 'echo: first words', 20_000)
  const spawns = events.recent('crashy1', 50).filter((e: any) => e.event === 'spawn').map((e: any) => JSON.parse(e.payload))
  assert.equal(spawns.length, 2)
  // There was no saved conversation to resume (resuming one would fail and crash again).
  assert.deepEqual(spawns.map((p: any) => p.resume), [false, false])
  await messageWhere('main told of the crash', m => m.from_name === 'neural' && /\*\*crashy1 stopped unexpectedly\*\*/.test(m.body))
  await messageWhere('main told it recovered', m => m.from_name === 'neural' && /\*\*crashy1 is healthy again\*\* after 1 restart/.test(m.body))
  assert.equal((await fromNeural('crashy1')).length, 2)
})

test('a wait ends as soon as a message arrives, and notify: true does not block at all', async () => {
  await idle('main')
  await idle('hw')
  await say('hw', 'slow and steady')
  await until('hw working', async () => (await session('hw')).status === 'working')
  await say('main', `tool wait_for ${JSON.stringify({ name: 'hw', until: 'idle', timeout_s: 60 })}`)
  await until('main waiting', async () => /^Waiting for hw/.test((await session('main')).activity?.text ?? ''))
  await new Promise(r => setTimeout(r, 300))
  const t0 = Date.now()
  await say('main', 'are you there')
  const r = await messageWhere('the wait returned', m => m.from_name === 'main' && /"interrupted"/.test(m.body))
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`)
  assert.match(r.body, /"from": "user"/)
  assert.match(r.body, /"status": "working"/)
  await messageWhere('the message answered', m => m.from_name === 'main' && m.body === 'echo: are you there')
  await idle('main')

  const t1 = Date.now()
  await say('main', `tool wait_for ${JSON.stringify({ name: 'hw', until: 'idle', notify: true })}`)
  const w = await messageWhere('the watch set', m => m.from_name === 'main' && /"watching": true/.test(m.body))
  assert.ok(Date.now() - t1 < 1500)
  assert.match(w.body, /"status": "working"/)
  await api('POST', '/api/sessions/hw/interrupt')
  await messageWhere('told when hw is done', m => m.from_name === 'neural' && m.to_name === 'main' && /\*\*hw finished its turn/.test(m.body))
  await idle('main')
})

test('the quota guard: alerts at 80% and 95% with who used it, and low-priority sessions held near the limit', async () => {
  const usage = await import('../server/src/usage.ts')
  await idle('main')
  await idle('hw')
  const resets = Math.floor(Date.now() / 1000) + 3600
  const reading = (cost: number, used: number, at = resets) => ({
    cost: { total_cost_usd: cost },
    rate_limits: { five_hour: { used_percentage: used, resets_at: at }, seven_day: { used_percentage: 40, resets_at: at + 86400 } },
  })
  const alerts = async (re: RegExp) => (await get('/api/messages?limit=500')).filter((m: any) => m.from_name === 'neural' && m.to_name === 'main' && re.test(m.body))
  usage.record('hw', reading(0.5, 50))
  usage.record('hw', reading(4.5, 70)) // hw spent 4.50 in this window
  usage.record('main', reading(0.5, 81))
  const first = await messageWhere('the 80% alert', m => m.from_name === 'neural' && /5-hour usage is at 81%/.test(m.body))
  assert.match(first.body, /hw \d+%/)
  assert.match(first.body, /set_priority/)
  usage.record('main', reading(0.6, 84)) // the same level again: no new alert
  assert.equal((await api('POST', '/api/sessions/hw/priority', { priority: 'low' })).body.priority, 'low')
  usage.record('main', reading(0.7, 96))
  const second = await messageWhere('the 95% alert', m => m.from_name === 'neural' && /5-hour usage is at 96%/.test(m.body))
  assert.match(second.body, /Low priority: hw\. Neural now holds/)
  assert.equal((await alerts(/5-hour usage is at/)).length, 2)
  const shares = (await get('/api/usage')).shares.five_hour
  assert.ok(shares.find((x: any) => x.name === 'hw').share > shares.find((x: any) => x.name === 'main').share)

  // Held: a message from main waits; one from the user goes straight through.
  await say('main', `tool send_message ${JSON.stringify({ to: 'hw', text: 'echo: held for later' })}`)
  const held = await messageWhere('the held message', m => m.from_name === 'main' && m.to_name === 'hw' && m.body === 'echo: held for later')
  await say('hw', 'are you still there')
  await messageWhere('the user is answered', m => m.from_name === 'hw' && m.body === 'echo: are you still there')
  assert.equal((await get('/api/messages?session=hw')).find((m: any) => m.id === held.id).delivery, 'pending')
  const listed = await say('main', 'tool list_sessions {}')
  const out = await messageWhere('list_sessions', m => m.from_name === 'main' && m.in_reply_to === listed.id)
  assert.match(out.body, /"priority": "low"/)
  assert.match(out.body, /"usage_share"/)
  // The window resets: the held message goes out.
  usage.record('main', reading(0.8, 3, resets + 5 * 3600))
  await until('delivered after the reset', async () =>
    (await get('/api/messages?session=hw')).find((m: any) => m.id === held.id).delivery !== 'pending')
  await api('POST', '/api/sessions/hw/priority', { priority: 'normal' })
  await idle('main')
})

test('a session can be started on a model and effort, kept across restarts, and switched later', async () => {
  await idle('main')
  const tool = async (name: string, args: unknown) => {
    const sent = await say('main', `tool ${name} ${JSON.stringify(args)}`)
    return (await messageWhere(`${name} result`, m => m.from_name === 'main' && m.in_reply_to === sent.id)).body as string
  }
  assert.match(await tool('spawn_session', { name: 'cheap', cwd: tmp, model: 'haiku', effort: 'max2' }), /^ERROR effort must be one of/)
  assert.equal(await session('cheap'), undefined) // nothing started
  await tool('spawn_session', { name: 'cheap', cwd: tmp, model: 'haiku', effort: 'low', initial_prompt: 'hi cheap' })
  await messageWhere('cheap answers', m => m.from_name === 'cheap' && m.body === 'echo: hi cheap')
  await idle('cheap')
  assert.match((await get('/api/screen/cheap')).screen, /started .* model=haiku effort=low/)
  const listed = await tool('list_sessions', {})
  assert.match(listed, /"launch": \{\s*"model": "haiku",\s*"effort": "low"/)
  // Switched while idle: restarted at once with the new model, the effort kept, the conversation resumed.
  assert.match(await tool('set_model', { name: 'cheap', model: 'sonnet' }), /Restarted with it now/)
  await until('restarted on sonnet', async () => /resumed .* model=sonnet effort=low/.test((await get('/api/screen/cheap')).screen))
  await idle('cheap')
  // From the app: back to the default model.
  const r = await api('POST', '/api/sessions/cheap/launch', { model: 'default' })
  assert.equal(r.body.launch_model, null)
  await until('restarted on the default', async () => /resumed .* model=default effort=low/.test((await get('/api/screen/cheap')).screen))
  await idle('cheap')
  await (await import('../server/src/spawner.ts')).removeSession('cheap')
  await idle('main')
})

test('scripts and jobs send messages with `neural notify`, which needs the secret', async () => {
  const { execFile } = await import('node:child_process')
  const cli = (args: string[], input?: string) => new Promise<{ code: number; out: string; err: string }>(resolve => {
    const child = execFile(path.join(here, '../bin/neural'), ['notify', ...args], { env: process.env }, (e: any, out, err) => resolve({ code: e?.code ?? 0, out, err }))
    child.stdin!.end(input ?? '')
  })
  assert.equal((await api('POST', '/api/notify', { from: 'x', to: 'user', text: 'hi' })).status, 403)
  const report = path.join(tmp, 'digest.txt')
  fs.writeFileSync(report, 'all good\n')
  const r = await cli(['--from', 'daily-digest', '--file', report, 'Digest is ready'])
  assert.equal(r.code, 0, r.err)
  const m = await messageWhere('the job message', m => m.from_name === 'job:daily-digest' && m.to_name === 'user')
  assert.equal(m.body, 'Digest is ready')
  assert.equal(m.attachments.length, 1)
  // To a session, text from stdin: it arrives marked as a job, not as the user.
  await idle('main')
  assert.equal((await cli(['--to', 'main', '--from', 'pipeline', '-'], 'run 41 failed: exit 1')).code, 0)
  const toMain = await messageWhere('to main', m => m.from_name === 'job:pipeline' && m.to_name === 'main')
  await messageWhere('main got it', m => m.from_name === 'main' && m.in_reply_to === toMain.id)
  const bad = await cli(['--to', 'nobody', 'hello'])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /no session "nobody"/)
  await idle('main')
})

test('clock times read as 12-hour, the same on the server and in the app', async () => {
  const server = await import('../server/src/clock.ts')
  const web = await import('../web/src/clock.js')
  const now = new Date(2026, 10, 18, 9, 30) // a Wednesday
  const cases: [Date, string][] = [
    [new Date(2026, 10, 18, 13, 50), '1:50 pm'],
    [new Date(2026, 10, 18, 0, 5), '12:05 am'],
    [new Date(2026, 10, 18, 12, 0), '12:00 pm'],
    [new Date(2026, 10, 20, 9, 0), 'Fri 9:00 am'],
    [new Date(2026, 10, 16, 21, 15), 'Mon 9:15 pm'],
    [new Date(2026, 10, 30, 8, 0), 'Nov 30 8:00 am'],
  ]
  for (const [d, want] of cases) {
    assert.equal(server.when(d, now), want)
    assert.equal(web.when(d, now), want)
    assert.equal(server.when(d.getTime(), now), want)
  }
  assert.equal(server.clock(new Date(2026, 0, 1, 23, 59)), '11:59 pm')
  assert.equal(web.clock(new Date(2026, 0, 1, 23, 59).toISOString()), '11:59 pm')
})

test('job schedules: intervals, daily and weekday times, and cron', async () => {
  const { nextRun, parseSchedule } = await import('../server/src/jobs.ts')
  const fri = new Date(2026, 10, 13, 10, 0).getTime() // a Friday, 10:00
  const at = (t: number) => { const d = new Date(t); return [d.getDay(), d.getHours(), d.getMinutes()] }
  assert.equal(nextRun('every 30m', fri) - fri, 30 * 60_000)
  assert.deepEqual(at(nextRun('daily 08:00', fri)), [6, 8, 0])
  assert.deepEqual(at(nextRun('weekdays 09:30', fri)), [1, 9, 30])
  assert.deepEqual(at(nextRun('mon,thu 18:00', fri)), [1, 18, 0])
  assert.deepEqual(at(nextRun('*/15 * * * *', fri)), [5, 10, 15])
  assert.deepEqual(at(nextRun('0 8 * * 1-5', fri)), [1, 8, 0])
  assert.throws(() => parseSchedule('sometimes'), /schedule must be like/)
  assert.throws(() => parseSchedule('every 10s'), /schedule must be like|at most once a minute/)
  assert.throws(() => parseSchedule('61 * * * *'), /bad schedule field/)
})

test('scheduled jobs run with a proper PATH, keep their output, and report failures to main', async () => {
  await idle('main')
  const tool = async (name: string, args: unknown) => {
    const sent = await say('main', `tool ${name} ${JSON.stringify(args)}`)
    return (await messageWhere(`${name} result`, m => m.from_name === 'main' && m.in_reply_to === sent.id)).body as string
  }
  const told = async (re: RegExp) => (await get('/api/messages?limit=500')).filter((m: any) => m.from_name === 'neural' && m.to_name === 'main' && re.test(m.body))
  // claude is found, as in a terminal (the stand-in lives outside the hub's own PATH).
  assert.match(await tool('add_job', { name: 'flaky', schedule: 'daily 03:00', command: 'command -v claude; echo nope >&2; exit 3', cwd: tmp }), /"next_run_at"/)
  const first = await tool('run_job', { name: 'flaky' })
  assert.match(first, /"status": "failed"/)
  assert.match(first, /"exit_code": 3/)
  assert.ok(first.includes(claudeBin), first)
  const failed = await messageWhere('main told', m => m.from_name === 'neural' && /\*\*Job flaky failed\*\*: exited with status 3/.test(m.body))
  assert.match(failed.body, /nope/)
  await tool('run_job', { name: 'flaky' })
  assert.equal((await told(/Job flaky/)).length, 1) // the second failure in a row adds nothing
  await tool('run_job', { name: 'flaky' })
  await messageWhere('keeps failing', m => m.from_name === 'neural' && /\*\*Job flaky keeps failing\*\*: 3 runs in a row/.test(m.body))
  // Fixed (same name replaces it), and due: the timer runs it.
  await tool('add_job', { name: 'flaky', schedule: 'daily 03:00', command: 'echo fine', cwd: tmp })
  const { db } = await import('../server/src/db.ts')
  db.prepare("UPDATE jobs SET next_run_at = '2000-01-01T00:00:00.000Z' WHERE name = 'flaky'").run()
  await messageWhere('works again', m => m.from_name === 'neural' && /\*\*Job flaky works again\*\* after 3 failed runs/.test(m.body))
  const listed = (await get('/api/jobs')).find((j: any) => j.name === 'flaky')
  assert.equal(listed.last_run.status, 'ok')
  assert.equal(listed.last_run.output_tail, 'fine')
  assert.ok(Date.parse(listed.next_run_at) > Date.now())
  const detail = await get('/api/jobs/flaky')
  assert.equal(detail.runs.length, 4)
  assert.equal(detail.runs[0].trigger, 'schedule')
  // A prompt job: a message to a session, from the job.
  await tool('add_job', { name: 'nudge', schedule: 'every 6h', session: 'hw', prompt: 'echo: from the nudge job' })
  await tool('run_job', { name: 'nudge' })
  await messageWhere('the prompt sent', m => m.from_name === 'job:nudge' && m.to_name === 'hw' && m.body === 'echo: from the nudge job')
  assert.match(await tool('add_job', { name: 'bad', schedule: 'daily 03:00' }), /^ERROR give either command, or session and prompt/)
  await tool('pause_job', { name: 'nudge' })
  assert.equal((await get('/api/jobs')).find((j: any) => j.name === 'nudge').enabled, false)
  await tool('remove_job', { name: 'nudge' })
  assert.equal((await api('DELETE', '/api/jobs/flaky')).status, 200)
  assert.deepEqual(await get('/api/jobs'), [])
  await idle('main')
})

test('a session sets a status note that main and Home can see', async () => {
  await idle('hw')
  const sent = await say('hw', `tool set_status ${JSON.stringify({ note: '  waiting on Max:\n save the place file ' })}`)
  await messageWhere('set', m => m.from_name === 'hw' && m.in_reply_to === sent.id)
  const s = await session('hw')
  assert.equal(s.note, 'waiting on Max: save the place file')
  assert.ok(s.note_at)
  assert.ok(seen.some(e => e.type === 'session' && e.session.name === 'hw' && e.session.note === s.note))
  await idle('main')
  const asked = await say('main', 'tool list_sessions {}')
  const out = await messageWhere('listed', m => m.from_name === 'main' && m.in_reply_to === asked.id)
  assert.match(out.body, /"text": "waiting on Max: save the place file"/)
  const cleared = await say('hw', 'tool set_status {"note":""}')
  await messageWhere('cleared', m => m.from_name === 'hw' && m.in_reply_to === cleared.id)
  assert.equal((await session('hw')).note, null)
  await idle('main')
  await idle('hw')
})

test('a session can get extra MCP servers, at the start or later, and the app sees only their names', async () => {
  await idle('main')
  const tool = async (name: string, args: unknown) => {
    const sent = await say('main', `tool ${name} ${JSON.stringify(args)}`)
    return (await messageWhere(`${name} result`, m => m.from_name === 'main' && m.in_reply_to === sent.id)).body as string
  }
  assert.match(await tool('spawn_session', { name: 'studio', cwd: tmp, mcp_servers: { neural: { command: 'x' } } }), /^ERROR bad MCP server name "neural"/)
  assert.match(await tool('spawn_session', { name: 'studio', cwd: tmp, mcp_servers: { s: { args: ['x'] } } }), /^ERROR MCP server "s" needs a command/)
  await tool('spawn_session', { name: 'studio', cwd: tmp, initial_prompt: 'hi studio', mcp_servers: { roblox: { command: 'node', args: ['server.js'], env: { TOKEN: 'abc123' } } } })
  await messageWhere('studio answers', m => m.from_name === 'studio' && m.body === 'echo: hi studio')
  await idle('studio')
  assert.match((await get('/api/screen/studio')).screen, /servers=neural,roblox/)
  const s = await session('studio')
  assert.deepEqual(s.mcp_servers, ['roblox']) // names only: env can hold keys
  assert.match(await tool('list_sessions', {}), /"mcp_servers": \[\s*"roblox"\s*\]/)
  // Swap one for another while idle: restarted with them, conversation resumed.
  assert.match(await tool('set_mcp_servers', { name: 'studio', mcp_servers: { roblox: null, docs: { type: 'http', url: 'https://example.com/mcp' } } }), /Restarted with them now/)
  await until('restarted with docs', async () => /resumed .* servers=docs,neural$/m.test((await get('/api/screen/studio')).screen))
  await idle('studio')
  await (await import('../server/src/spawner.ts')).removeSession('studio')
  await idle('main')
})

test('near a full context the orchestrator writes STATE.md and is restarted fresh, not resumed', async () => {
  const usage = await import('../server/src/usage.ts')
  const { events } = await import('../server/src/db.ts')
  const before = await idle('main')
  usage.record('main', { context_window: { used_percentage: 64, context_window_size: 200_000 } })
  const asked = await messageWhere('the handoff request', m => m.from_name === 'neural' && m.to_name === 'main' && /Time for a fresh context/.test(m.body))
  assert.ok(asked.body.includes(path.join(tmp, 'STATE.md')))
  usage.record('main', { context_window: { used_percentage: 66, context_window_size: 200_000 } }) // asked once
  // Nothing happens until the state is written down.
  await new Promise(r => setTimeout(r, 1200))
  assert.equal((await session('main')).claude_session_id, before.claude_session_id)
  fs.writeFileSync(path.join(tmp, 'STATE.md'), '# State\n- hw: waiting on review\n')
  const told = await messageWhere('told after the restart', m => m.from_name === 'neural' && m.to_name === 'main' && /restarted with a fresh context \(not resumed\)/.test(m.body), 20_000)
  const after = await until('a new conversation', async () => {
    const s = await session('main')
    return s.status === 'idle' && s.channel_connected && s.claude_session_id !== before.claude_session_id ? s : null
  })
  assert.equal(after.context, null) // the old reading is gone
  // Read by the new process as its first prompt, not pushed into the old one as it went away.
  const { outbox } = await import('../server/src/db.ts')
  await until('the note read by the new process', () => outbox.get(told.id)?.acked_by === 'prompt' || null)
  assert.equal(JSON.parse(events.recent('main', 50).find((e: any) => e.event === 'spawn').payload).resume, false)
  assert.equal((await get('/api/messages?limit=500')).filter((m: any) => m.from_name === 'neural' && /Time for a fresh context/.test(m.body)).length, 1)
})

test('a fresh context can be asked for by hand, for a worker too', async () => {
  const before = await idle('hw')
  await api('POST', '/api/sessions/hw/handoff')
  const asked = await messageWhere('asked', m => m.from_name === 'neural' && m.to_name === 'hw' && /A fresh context was asked for/.test(m.body))
  const file = path.join(tmp, 'uploads/handoff/hw.md')
  assert.ok(asked.body.includes(file))
  fs.writeFileSync(file, 'hw state\n')
  await until('hw restarted fresh', async () => {
    const s = await session('hw')
    return s.status === 'idle' && s.channel_connected && s.claude_session_id !== before.claude_session_id
  }, 20_000)
  const told = await messageWhere('told', m => m.from_name === 'neural' && m.to_name === 'hw' && m.body.includes(`Read ${file} first`))
  const { outbox } = await import('../server/src/db.ts')
  await until('the note read by the new process', () => outbox.get(told.id)?.acked_by === 'prompt' || null)
  await idle('main')
})

test('a message pushed to a session in the moment its old process goes away reaches the new one', async () => {
  const { outbox } = await import('../server/src/db.ts')
  const { restartSession } = await import('../server/src/spawner.ts')
  const { sendMessage } = await import('../server/src/router.ts')
  await idle('hw')
  await restartSession('hw')
  // As if the push had gone into the old process's socket before it closed: marked pushed, never read.
  const m = sendMessage({ from: 'neural', to: 'hw', body: 'sent during the restart', source: 'test' })
  if (outbox.get(m.id)?.state === 'pending') outbox.markPushed(m.id, 'channel')
  await until('read by the new process', () => outbox.get(m.id)?.acked_by === 'prompt' || null, 20_000)
  await idle('hw')
})

test('a session left at a startup prompt with nobody answering it is picked up again', async () => {
  // As if the hub had restarted between launching it and answering its prompt.
  const { sessions: rows, events } = await import('../server/src/db.ts')
  const sp = await import('../server/src/spawner.ts')
  rows.create('dlg2', 'worker', tmp, false)
  await sp.mux.spawn('dlg2', tmp, sp.launchArgv(rows.get('dlg2')!), { MCP_PROTOCOL_NEGOTIATION: 'legacy' })
  await idle('dlg2')
  assert.ok(events.recent('dlg2', 50).some((e: any) => e.event === 'startup-resumed'))
  assert.ok(events.recent('dlg2', 50).some((e: any) => e.event === 'dialog'))
  await sp.removeSession('dlg2')
})

test('a session with a background shell still running is not restarted until it finishes', async () => {
  const { sessions: rows, events } = await import('../server/src/db.ts')
  const sp = await import('../server/src/spawner.ts')
  await idle('hw')
  await say('hw', 'bgshell render')
  await until('footer shows the shell', async () => /1 shell · ↓ to manage/.test((await get('/api/screen/hw')).screen))
  await idle('hw')
  assert.equal(await sp.backgroundWork(rows.get('hw')!), '1 shell')
  // The app and list_sessions show it as idle with a shell running, not just idle.
  await until('shown with its shell', async () => (await session('hw')).background === '1 shell')
  const before = events.recent('hw', 200).filter((e: any) => e.event === 'refresh').length
  rows.update('hw', { launch_rev: 'older' })
  await new Promise(r => setTimeout(r, 2000)) // several reconcile passes, idle well past the refresh delay
  assert.equal(events.recent('hw', 200).filter((e: any) => e.event === 'refresh').length, before)
  // Switching its model waits too, instead of restarting now.
  assert.equal(await sp.setLaunch('hw', { effort: 'low' }), 'when idle')
  await say('hw', 'bgdone')
  await until('refreshed once the shell is done', () => events.recent('hw', 200).filter((e: any) => e.event === 'refresh').length > before, 20_000)
  await until('restarted with low effort', async () => /model=default effort=low/.test((await get('/api/screen/hw')).screen))
  await idle('hw')
  await until('no longer shown with a shell', async () => (await session('hw')).background === null)
  await sp.setLaunch('hw', { effort: 'default' })
  await idle('hw')
})

test('a job still running when the hub restarts is picked up again and its result recorded', async () => {
  const { db } = await import('../server/src/db.ts')
  const jobs = await import('../server/src/jobs.ts')
  const { spawn } = await import('node:child_process')
  jobs.addJob('main', { name: 'long', schedule: 'daily 03:00', command: 'true', cwd: tmp })
  const job = jobs.jobs.get('long')!
  // As an earlier hub process would have left it: a run in the database, its process still going.
  const runId = Number(db.prepare('INSERT INTO job_runs (job_id) VALUES (?)').run(job.id).lastInsertRowid)
  const dir = path.join(tmp, 'jobs')
  fs.mkdirSync(dir, { recursive: true })
  const out = fs.openSync(path.join(dir, `${runId}.out`), 'a')
  const child = spawn('/bin/sh', ['-c', '/bin/sh -c "$1"; echo $? > "$2"', 'x', 'sleep 0.5; echo rendered; exit 4', path.join(dir, `${runId}.exit`)], { detached: true, stdio: ['ignore', out, out] })
  child.unref()
  db.prepare('UPDATE job_runs SET pid = ? WHERE id = ?').run(child.pid, runId)
  // And one whose process is gone with no result: that one really was cut off.
  const lost = Number(db.prepare("INSERT INTO job_runs (job_id, pid) VALUES (?, 999999)").run(job.id).lastInsertRowid)
  jobs.adoptRunning()
  const run = await until('the adopted run finished', () => {
    const r: any = db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId)
    return r.status !== 'running' ? r : null
  })
  assert.deepEqual([run.status, run.exit_code], ['failed', 4])
  assert.match(run.output, /rendered/)
  assert.equal((db.prepare('SELECT status FROM job_runs WHERE id = ?').get(lost) as any).status, 'interrupted')
  await messageWhere('main told', m => m.from_name === 'neural' && /\*\*Job long failed\*\*: exited with status 4/.test(m.body))
  jobs.removeJob('long')
})

test('neural notify prints its usage for --help, and refuses unknown options instead of sending them', async () => {
  // Run without blocking: the hub answering the CLI lives in this process.
  const { execFile } = await import('node:child_process')
  const cli = (args: string[]) => new Promise<{ code: number; out: string }>(resolve => {
    const child = execFile(path.join(here, '../bin/neural'), ['notify', ...args], { env: process.env }, (e: any, out, err) => resolve({ code: e?.code ?? 0, out: out + err }))
    child.stdin!.end()
  })
  const before = (await get('/api/messages?limit=500')).length
  assert.equal((await cli(['--help'])).code, 0)
  assert.match((await cli(['-h'])).out, /^usage: neural notify/)
  assert.equal((await cli(['--frm', 'x', 'hello'])).code, 2)
  assert.equal((await cli(['--to'])).code, 2)
  const sent = await cli(['--from', 'dash', '--', '-5 degrees outside'])
  assert.equal(sent.code, 0, sent.out)
  await messageWhere('the dash message', m => m.from_name === 'job:dash' && m.body === '-5 degrees outside')
  assert.equal((await get('/api/messages?limit=500')).length, before + 1)
})

test('a turn that says it stopped at the usage limit is treated as cut off by it; a transient error is retried', async () => {
  const usage = await import('../server/src/usage.ts')
  const { handleHook, turnFailed } = await import('../server/src/router.ts')
  await idle('hw')
  const resets = Math.floor(Date.now() / 1000) + 12 * 3600 // later than the window the quota test left
  usage.record('hw', { rate_limits: { five_hour: { used_percentage: 100, resets_at: resets }, seven_day: { used_percentage: 50, resets_at: resets + 86400 } } })
  handleHook('hw', 'UserPromptSubmit', { prompt: 'go' })
  handleHook('hw', 'Stop', { last_assistant_message: 'My usage limit was reached partway through the fix pass. The fixes are committed.' })
  const s = await session('hw')
  assert.equal(s.status, 'limited')
  assert.match(s.status_detail, /Stopped at the 5-hour usage limit · resets (?:\w{3} )?\d{1,2}:\d\d [ap]m$/)
  // Back to normal for the rest of the tests.
  usage.record('hw', { rate_limits: { five_hour: { used_percentage: 5, resets_at: resets + 5 * 3600 }, seven_day: { used_percentage: 50, resets_at: resets + 86400 } } })
  ;(await import('../server/src/router.ts')).limitReset('hw', Date.now())
  await idle('hw')
  // The same words with plenty of quota left are just words.
  handleHook('hw', 'UserPromptSubmit', { prompt: 'go' })
  handleHook('hw', 'Stop', { last_assistant_message: 'Explained how the usage limit was reached in the test.' })
  assert.equal((await session('hw')).status, 'idle')
  await turnFailed('hw', 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'server_error')
  assert.equal((await session('hw')).status, 'attention')
  await messageWhere('the retry', m => m.from_name === 'system' && m.to_name === 'hw' && /temporary API error/.test(m.body))
  await messageWhere('carried on', m => m.from_name === 'hw' && m.body.startsWith('echo: Your last turn stopped on a temporary API error'))
  await idle('hw')
  await idle('main')
})

test("Claude Code's prompt to trust Neural's uploads folder is answered", async () => {
  await api('POST', '/api/sessions', { name: 'adddir1', cwd: tmp, prompt: 'past the trust prompt' })
  await messageWhere('reply', m => m.from_name === 'adddir1' && m.body === 'echo: past the trust prompt')
  const { events } = await import('../server/src/db.ts')
  assert.ok(events.recent('adddir1', 50).some((e: any) => e.event === 'dialog' && JSON.parse(e.payload).dialog === 'add-directory'))
  await (await import('../server/src/spawner.ts')).removeSession('adddir1')
})

test('after a startup prompt Neural does not know is answered by hand, the known ones that follow still are', async () => {
  await api('POST', '/api/sessions', { name: 'odd1', cwd: tmp })
  await until('needs attention', async () => (await session('odd1')).status === 'attention')
  await api('POST', '/api/sessions/odd1/keys', { keys: ['y'] })
  await idle('odd1')
  await (await import('../server/src/spawner.ts')).removeSession('odd1')
})

test('a worker can hand off at its own threshold, in context tokens', async () => {
  const usage = await import('../server/src/usage.ts')
  const handoff = await import('../server/src/handoff.ts')
  await idle('main')
  const sent = await say('main', `tool fresh_context ${JSON.stringify({ name: 'hw', auto: true, at_tokens: 100_000 })}`)
  const r = await messageWhere('set', m => m.from_name === 'main' && m.in_reply_to === sent.id)
  assert.match(r.body, /"tokens": 100000/)
  usage.record('hw', { context_window: { used_percentage: 8, context_window_size: 1_000_000 } }) // 80K: not yet
  await new Promise(res => setTimeout(res, 300))
  assert.equal(handoff.pending('hw'), false)
  usage.record('hw', { context_window: { used_percentage: 12, context_window_size: 1_000_000 } }) // 120K
  const asked = await messageWhere('asked', m => m.from_name === 'neural' && m.to_name === 'hw' && /about 120K tokens/.test(m.body))
  assert.match(asked.body, /12% full/)
  handoff.setEnabled('hw', false)
  assert.equal(handoff.pending('hw'), false)
  await idle('main')
})

test("headless runs' usage is counted from their transcripts, under the job that ran them", async () => {
  const { db } = await import('../server/src/db.ts')
  const jobs = await import('../server/src/jobs.ts')
  const usage = await import('../server/src/usage.ts')
  const work = path.join(tmp, 'pipeline')
  fs.mkdirSync(work, { recursive: true })
  jobs.addJob('main', { name: 'pipeline', schedule: 'daily 03:00', command: 'true', cwd: work })
  const runId = Number(db.prepare('INSERT INTO job_runs (job_id) VALUES (?)').run(jobs.jobs.get('pipeline')!.id).lastInsertRowid)
  // What `claude -p` leaves in ~/.claude/projects: a reply written as two lines, each repeating its usage.
  const reply = (uuid: string, cwd: string, id: string) => JSON.stringify({
    type: 'assistant', uuid, sessionId: 'headless-1', cwd, timestamp: new Date().toISOString(),
    message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'researching' }],
      usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 } },
  })
  const dir = path.join(tmp, 'transcripts', 'pipeline-project')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'headless-1.jsonl'), [reply('h1', work, 'msg_1'), reply('h2', work, 'msg_1'), reply('h3', '/somewhere/else', 'msg_2')].join('\n') + '\n')
  const expected = usage.costOf('claude-opus-5-5', { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 1_000_000 })
  const row: any = await until('logged', () => {
    const r: any = db.prepare("SELECT SUM(cost) AS c FROM usage_log WHERE session = 'job:pipeline'").get()
    return r.c != null ? r : null
  })
  assert.ok(Math.abs(row.c - expected) < 1e-9, `${row.c} vs ${expected}`) // once, not twice
  await until('the other folder', () => db.prepare("SELECT 1 FROM usage_log WHERE session = 'other:else'").get())
  const window = { five_hour: { used: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 }, seven_day: null, at: '' }
  assert.ok(usage.shares(window).five_hour!.some(x => x.name === 'job:pipeline'))
  db.prepare("UPDATE job_runs SET status = 'ok', finished_at = ? WHERE id = ?").run(new Date().toISOString(), runId)
  jobs.removeJob('pipeline')
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

test('the usage meter does not flap between sessions: an idle session\'s older, lower reading is ignored', async () => {
  const usage = await import('../server/src/usage.ts')
  // Later than any window the tests before used, so this one counts as the newest.
  const resets = Math.floor(Date.now() / 1000) + 40 * 86400
  const reading = (five: number, at = resets) => ({ rate_limits: { five_hour: { used_percentage: five, resets_at: at }, seven_day: { used_percentage: 50, resets_at: at + 86400 } } })
  const sent = () => seen.filter(e => e.type === 'usage' && e.account).length
  usage.record('main', reading(99)) // main is busy and near the limit
  await new Promise(r => setTimeout(r, 200)) // its update reaches the app
  const before = sent()
  usage.record('hw', reading(84)) // hw has been idle: its figure is from its last API call
  usage.record('hw', reading(84, resets + 7)) // the same window, reported a few seconds apart
  assert.equal(usage.account()?.five_hour?.used, 99)
  assert.equal(usage.account()?.five_hour?.resets_at, resets)
  assert.match(usage.record('hw', {}), /5-hour 99%/) // hw's own status line shows the account figure too
  usage.record('hw', reading(97, resets - 5 * 3600)) // a reading of the window before: stale
  assert.equal(usage.account()?.five_hour?.used, 99)
  await new Promise(r => setTimeout(r, 200))
  assert.equal(sent(), before, 'no usage update goes out for a stale reading')
  assert.equal((await get('/api/state')).usage.five_hour.used, 99)
  usage.record('main', reading(100))
  assert.equal(usage.account()?.five_hour?.used, 100)
  // The real reset: a later reset time starts over, lower.
  usage.record('hw', reading(2, resets + 5 * 3600))
  assert.deepEqual(usage.account()?.five_hour, { used: 2, resets_at: resets + 5 * 3600 })
  assert.equal(usage.merge(null, { used: 5, resets_at: 1 })?.used, 5)
  assert.equal(usage.merge({ used: 5, resets_at: 1 }, null)?.used, 5)
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
