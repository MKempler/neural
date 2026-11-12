// End-to-end test of the hub with a scripted stand-in for Claude (test/fake-claude.ts) running in real tmux.
// Run with: npm test
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hub-test-'))
const port = 17000 + Math.floor(Math.random() * 2000)
const base = `http://127.0.0.1:${port}`
const SOCKET = 'claude-hub-test'

Object.assign(process.env, {
  HUB_DATA_DIR: tmp,
  HUB_PORT: String(port),
  HUB_TMUX_SOCKET: SOCKET,
  HUB_CLAUDE_BIN: path.join(here, 'fake-claude'),
  HUB_TEST_NODE: process.execPath,
  HUB_ORCHESTRATOR_CWD: tmp,
  HUB_TRANSCRIPTS_DIR: path.join(tmp, 'transcripts'),
  HUB_INGEST_MS: '300',
  // Semantic search runs in the tests only when the embedding model is already on this machine.
  HUB_MODELS_DIR: path.join(os.homedir(), '.local/share/claude-hub/models'),
  HUB_EMBEDDINGS: fs.existsSync(path.join(os.homedir(), '.local/share/claude-hub/models/Xenova')) ? 'on' : 'off',
  HUB_EMBED_MS: '300',
  HUB_KEEP_AWAKE: 'off',
  HUB_BACKUPS: 'off',
  HUB_ACK_TIMEOUT: '2',
  HUB_RETRY_MS: '300',
  HUB_RECONCILE_MS: '300',
  HUB_RESTART_BACKOFF_MS: '300',
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

test('search also matches by meaning', { skip: process.env.HUB_EMBEDDINGS === 'off' && 'embedding model not downloaded' }, async () => {
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
  for (const ch of 'typed in the browser') term.send(JSON.stringify({ type: 'input', data: ch }))
  term.send(JSON.stringify({ type: 'input', data: '\r' }))
  await messageWhere('reply to typed text', m => m.from_name === 'main' && m.body === 'pasted: typed in the browser')
  term.close()
  await idle('main')
  // Closing the browser's terminal detaches it; the session keeps running.
  await new Promise(r => setTimeout(r, 300))
  assert.equal((await session('main')).status, 'idle')
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

test('a backup is a complete, readable copy and old ones are rotated out', async () => {
  const { backupNow, listBackups } = await import('../server/src/backup.ts')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = path.join(tmp, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `hub-2020-01-0${d}.db`), 'old')
  const file = backupNow()
  assert.ok(file && fs.existsSync(file))
  assert.equal(backupNow(), null) // one per day
  assert.equal(listBackups().length, 7)
  assert.ok(!fs.existsSync(path.join(dir, 'hub-2020-01-03.db')))
  const copy = new DatabaseSync(file!, { readOnly: true })
  const live = (await get('/api/messages?limit=500')).length
  assert.equal((copy.prepare('SELECT count(*) AS n FROM messages').get() as any).n, live)
  copy.close()
})

test('requests from other origins and without the secret are refused', async () => {
  assert.equal((await api('GET', '/api/sessions', undefined, { origin: 'http://evil.example' })).status, 403)
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
