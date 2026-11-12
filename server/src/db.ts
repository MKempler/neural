import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ROOT, config } from './config.ts'

export const db = new DatabaseSync(config.dbPath, { allowExtension: true })
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')

// sqlite-vec adds vector search. Without it everything still works; search is keyword-only.
export let vectorsEnabled = false
try {
  const { getLoadablePath } = await import('sqlite-vec')
  db.loadExtension(getLoadablePath())
  vectorsEnabled = true
} catch (e: any) {
  console.error('semantic search unavailable (sqlite-vec did not load):', e?.message ?? e)
}
db.enableLoadExtension(false)

// Migrations are numbered files; PRAGMA user_version records how many have run.
const dir = path.join(ROOT, 'db/migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
for (const file of files) {
  const n = Number(file.slice(0, 3))
  if (n <= current) continue
  db.exec('BEGIN')
  try {
    db.exec(fs.readFileSync(path.join(dir, file), 'utf8'))
    db.exec(`PRAGMA user_version = ${n}`)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

if (vectorsEnabled) db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vecs USING vec0(embedding float[384] distance_metric=cosine)')

export type Session = {
  id: number
  name: string
  role: 'orchestrator' | 'worker'
  cwd: string
  status: string
  status_detail: string | null
  channel_connected: number
  claude_session_id: string | null
  transcript_path: string | null
  autostart: number
  restarts: number
  created_at: string
  updated_at: string
  ended_at: string | null
}

export type Message = {
  id: number
  ts: string
  from_name: string
  to_name: string
  body: string
  source: string
  in_reply_to: number | null
  meta: string | null
  delivery?: string | null
  via?: string | null
  attachments?: unknown[]
}

// The files module adds each message's attachments; set at startup so this module stays independent of it.
let decorate = (rows: Message[]): Message[] => rows
export function setMessageDecorator(fn: (rows: Message[]) => Message[]) {
  decorate = fn
}

const q = <T>(sql: string) => {
  const st = db.prepare(sql)
  return {
    all: (...a: any[]) => st.all(...a) as T[],
    get: (...a: any[]) => st.get(...a) as T | undefined,
    run: (...a: any[]) => st.run(...a),
  }
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

export const sessions = {
  all: () => q<Session>("SELECT * FROM sessions ORDER BY role = 'orchestrator' DESC, name").all(),
  get: (name: string) => q<Session>('SELECT * FROM sessions WHERE name = ?').get(name),
  create: (name: string, role: string, cwd: string, autostart: boolean) =>
    q(`INSERT INTO sessions (name, role, cwd, autostart) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET role = excluded.role, cwd = excluded.cwd, autostart = excluded.autostart,
         status = 'starting', status_detail = NULL, ended_at = NULL, updated_at = ${NOW}`).run(name, role, cwd, autostart ? 1 : 0),
  update: (name: string, fields: Partial<Session>) => {
    const keys = Object.keys(fields)
    if (!keys.length) return
    q(`UPDATE sessions SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ${NOW} WHERE name = ?`)
      .run(...keys.map(k => (fields as any)[k]), name)
  },
  remove: (name: string) => q('DELETE FROM sessions WHERE name = ?').run(name),
}

const MSG_COLS = 'm.*, o.state AS delivery, o.via AS via'

export const messages = {
  insert: (m: { from: string; to: string; body: string; source: string; in_reply_to?: number | null; meta?: unknown }) => {
    const r = q('INSERT INTO messages (from_name, to_name, body, source, in_reply_to, meta) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.from, m.to, m.body, m.source, m.in_reply_to ?? null, m.meta ? JSON.stringify(m.meta) : null)
    return messages.get(Number(r.lastInsertRowid))!
  },
  get: (id: number) => {
    const row = q<Message>(`SELECT ${MSG_COLS} FROM messages m LEFT JOIN outbox o ON o.message_id = m.id WHERE m.id = ?`).get(id)
    return row ? decorate([row])[0] : undefined
  },
  // Everything a session sent or received. `before`/`after` page by id.
  thread: (name: string, opts: { before?: number; after?: number; limit?: number } = {}) => {
    const rows = q<Message>(
      `SELECT ${MSG_COLS} FROM messages m LEFT JOIN outbox o ON o.message_id = m.id
       WHERE (m.from_name = ?1 OR m.to_name = ?1) AND m.id < ?2 AND m.id > ?3
       ORDER BY m.id DESC LIMIT ?4`,
    ).all(name, opts.before ?? Number.MAX_SAFE_INTEGER, opts.after ?? 0, opts.limit ?? 100)
    return decorate(rows.reverse())
  },
  timeline: (opts: { before?: number; after?: number; limit?: number } = {}) => {
    const rows = q<Message>(
      `SELECT ${MSG_COLS} FROM messages m LEFT JOIN outbox o ON o.message_id = m.id
       WHERE m.id < ?1 AND m.id > ?2 ORDER BY m.id DESC LIMIT ?3`,
    ).all(opts.before ?? Number.MAX_SAFE_INTEGER, opts.after ?? 0, opts.limit ?? 100)
    return decorate(rows.reverse())
  },
}

export type Summary = { id: number; from_name: string; to_name: string; body: string; ts: string; source: string; files: number }

export const reads = {
  /** Last message to or from a session, with the body shortened for previews. */
  last: (name: string) =>
    q<Summary>(
      `SELECT id, from_name, to_name, substr(body, 1, 400) AS body, ts, source,
              (SELECT count(*) FROM attachments a WHERE a.message_id = messages.id) AS files
       FROM messages WHERE id = (SELECT max(id) FROM messages WHERE from_name = ?1 OR to_name = ?1)`,
    ).get(name) ?? null,
  /** Replies from a session to the user that the user has not seen yet. */
  unread: (name: string) =>
    (q<{ n: number }>(
      `SELECT count(*) AS n FROM messages WHERE from_name = ?1 AND to_name = 'user'
       AND id > COALESCE((SELECT last_read_id FROM read_state WHERE session = ?1), 0)`,
    ).get(name)?.n ?? 0),
  /** Marks everything up to `id` as read; never moves backwards. */
  mark: (name: string, id: number) =>
    q(`INSERT INTO read_state (session, last_read_id) VALUES (?1, ?2)
       ON CONFLICT(session) DO UPDATE SET last_read_id = max(last_read_id, excluded.last_read_id)`).run(name, id),
}

export type OutboxRow = {
  message_id: number
  target: string
  state: string
  via: string | null
  attempts: number
  pushed_at: string | null
}

export const outbox = {
  get: (messageId: number) => q<OutboxRow>('SELECT * FROM outbox WHERE message_id = ?').get(messageId),
  add: (messageId: number, target: string) => q('INSERT INTO outbox (message_id, target) VALUES (?, ?)').run(messageId, target),
  pending: (target: string) =>
    q<OutboxRow>("SELECT * FROM outbox WHERE target = ? AND state = 'pending' ORDER BY message_id").all(target),
  pushed: (target: string) =>
    q<OutboxRow>("SELECT * FROM outbox WHERE target = ? AND state = 'pushed' ORDER BY message_id").all(target),
  stale: (seconds: number) =>
    q<OutboxRow>(`SELECT * FROM outbox WHERE state = 'pushed' AND pushed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
      .all(`-${seconds} seconds`),
  markPushed: (id: number, via: string) =>
    q(`UPDATE outbox SET state = 'pushed', via = ?, attempts = attempts + 1, pushed_at = ${NOW}, last_error = NULL WHERE message_id = ?`).run(via, id),
  markPending: (id: number, error: string) =>
    q("UPDATE outbox SET state = 'pending', last_error = ? WHERE message_id = ?").run(error, id),
  markAcked: (id: number, by: string) =>
    q(`UPDATE outbox SET state = 'acked', acked_at = ${NOW}, acked_by = ? WHERE message_id = ? AND state != 'acked'`).run(by, id),
  markFailed: (id: number, error: string) =>
    q("UPDATE outbox SET state = 'failed', last_error = ? WHERE message_id = ?").run(error, id),
}

export const events = {
  add: (session: string | null, event: string, payload: unknown) =>
    q('INSERT INTO events (session, event, payload) VALUES (?, ?, ?)').run(session, event, JSON.stringify(payload ?? null)),
  recent: (session: string, limit = 50) =>
    q<{ id: number; ts: string; event: string; payload: string }>('SELECT * FROM events WHERE session = ? ORDER BY id DESC LIMIT ?').all(session, limit),
}

export type PermissionRequest = {
  id: number
  ts: string
  session: string
  request_id: string
  tool_name: string
  description: string
  input_preview: string
  verdict: string | null
}

export const permissions = {
  add: (session: string, p: { request_id: string; tool_name: string; description: string; input_preview: string }) => {
    const r = q('INSERT INTO permission_requests (session, request_id, tool_name, description, input_preview) VALUES (?, ?, ?, ?, ?)')
      .run(session, p.request_id, p.tool_name, p.description, p.input_preview)
    return permissions.get(Number(r.lastInsertRowid))!
  },
  get: (id: number) => q<PermissionRequest>('SELECT * FROM permission_requests WHERE id = ?').get(id),
  open: () => q<PermissionRequest>('SELECT * FROM permission_requests WHERE verdict IS NULL ORDER BY id').all(),
  decide: (id: number, verdict: string) =>
    q(`UPDATE permission_requests SET verdict = ?, decided_at = ${NOW} WHERE id = ? AND verdict IS NULL`).run(verdict, id),
  // A session that has moved on (turn ended, restarted) no longer has these dialogs open.
  expire: (session: string) =>
    q(`UPDATE permission_requests SET verdict = 'expired', decided_at = ${NOW} WHERE session = ? AND verdict IS NULL`).run(session),
}

export type SearchHit = { kind: 'message' | 'transcript'; id: number; ts: string | null; session: string | null; who: string; snippet: string; rank: number; match?: 'keyword' | 'meaning' | 'both' }

const STOPWORDS = new Set(('a an and are as at be but by did do does for from had has have how i if in is it its me my of on or our '
  + 'so that the their them then there these they this to was we were what when where which who why will with you your '
  + 'not no use used using can could should would about into over than also just any some more most very get got').split(' '))

// FTS5 treats punctuation as syntax, so quote each word; a trailing * keeps prefix matching.
// `all` requires every word; otherwise any meaningful word may match and ranking favours entries with more of them.
function ftsQuery(input: string, all: boolean): string {
  const words = input.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (all) return words.map(w => `"${w}"*`).join(' ')
  // Whole words only here: with any-word matching, prefixes ("not" matching "notifications") are mostly noise.
  const useful = words.filter(w => !STOPWORDS.has(w.toLowerCase()))
  return (useful.length ? useful : words).map(w => `"${w}"`).join(' OR ')
}

const transcriptText = db.prepare('SELECT text FROM transcript_entries WHERE id = ?')

/** True for a transcript entry that is itself an earlier search for this query (a tool call quoting it). */
function isEchoOfQuery(hit: SearchHit, input: string): boolean {
  if (hit.kind !== 'transcript') return false
  const text = (transcriptText.get(hit.id) as { text: string } | undefined)?.text ?? ''
  const needle = input.trim().toLowerCase()
  return needle.length > 8 && text.includes('[tool: ') && text.toLowerCase().includes(needle)
}

export function search(input: string, opts: { session?: string; since?: string; limit?: number } = {}): SearchHit[] {
  const limit = Math.min(opts.limit ?? 20, 100)
  const strict = run(ftsQuery(input, true), opts, limit)
  // A question in plain language rarely has every word in one entry; widen to any meaningful word.
  if (strict.length >= 5 || (input.match(/[\p{L}\p{N}_]+/gu) ?? []).length < 3) return strict.filter(h => !isEchoOfQuery(h, input))
  const seen = new Set(strict.map(h => `${h.kind}:${h.id}`))
  const loose = run(ftsQuery(input, false), opts, limit).filter(h => !seen.has(`${h.kind}:${h.id}`))
  return [...strict, ...loose].filter(h => !isEchoOfQuery(h, input)).slice(0, limit)
}

function run(match: string, opts: { session?: string; since?: string }, limit: number): SearchHit[] {
  if (!match) return []
  const since = opts.since ?? ''
  const session = opts.session ?? ''
  const msgs = q<SearchHit>(
    `SELECT 'message' AS kind, m.id, m.ts,
            CASE WHEN m.from_name IN ('user','system') THEN m.to_name ELSE m.from_name END AS session,
            m.from_name || ' -> ' || m.to_name AS who,
            snippet(messages_fts, 0, '[', ']', ' … ', 24) AS snippet, bm25(messages_fts) AS rank
     FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
     WHERE messages_fts MATCH ?1 AND (?2 = '' OR m.from_name = ?2 OR m.to_name = ?2) AND (?3 = '' OR m.ts >= ?3)
     ORDER BY rank LIMIT ?4`,
  ).all(match, session, since, limit)
  const trans = q<SearchHit>(
    `SELECT 'transcript' AS kind, t.id, t.ts, COALESCE(t.session_name, t.project) AS session, COALESCE(t.role, '') AS who,
            snippet(transcript_fts, 0, '[', ']', ' … ', 24) AS snippet, bm25(transcript_fts) AS rank
     FROM transcript_fts JOIN transcript_entries t ON t.id = transcript_fts.rowid
     WHERE transcript_fts MATCH ?1 AND (?2 = '' OR t.session_name = ?2) AND (?3 = '' OR t.ts >= ?3)
     ORDER BY rank LIMIT ?4`,
  ).all(match, session, since, limit)
  return [...msgs, ...trans].sort((a, b) => a.rank - b.rank).slice(0, limit)
}
