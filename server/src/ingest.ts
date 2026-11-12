import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { db, sessions, outbox } from './db.ts'
import { broadcast } from './live.ts'
import { noteModel } from './router.ts'

// Archives Claude Code transcripts into the hub database so they stay searchable after Claude Code's own
// cleanup removes them. Every session on this machine is covered, not only the ones the hub started.
//
// The transcript format is internal to Claude Code and changes between versions. Only the conversation
// entries (user and assistant turns) are read, defensively, and the original line is stored alongside the
// extracted text so nothing is lost if the extraction falls behind a format change.

const MAX_RAW = 200_000
const MAX_TOOL_TEXT = 2_000
const CHUNK = 4 << 20

const getOffset = db.prepare('SELECT offset FROM transcript_files WHERE path = ?')
const setOffset = db.prepare('INSERT INTO transcript_files (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset')
const insert = db.prepare(
  `INSERT OR IGNORE INTO transcript_entries (claude_session_id, session_name, project, uuid, ts, role, text, raw)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
)
const messageTarget = db.prepare("SELECT target FROM outbox WHERE message_id = ? AND state = 'pushed'")

/** The model and effort a transcript line reveals: Claude's replies carry both, and /model and /effort record
 *  their result as "Set model to `Opus 5.5`" / "Set effort level to high". */
export function modelInfo(entry: any): { model?: string; effort?: string } | null {
  if (entry?.isSidechain) return null
  if (entry?.type === 'assistant') {
    const effort = typeof entry.effort === 'string' ? entry.effort : entry.effort?.level
    return entry.message?.model ? { model: entry.message.model, effort } : null
  }
  const content = entry?.message?.content
  if (entry?.type !== 'user' || typeof content !== 'string' || !content.includes('<local-command-stdout>')) return null
  const model = /Set model to `?([^`\n(]+?)`?(?:\s+and\b|\s*\(|\s*<|$)/.exec(content)?.[1]?.trim()
  const effort = /Set effort(?: level)? to `?(low|medium|high|xhigh|max)\b/i.exec(content)?.[1]?.toLowerCase()
  return model || effort ? { model, effort } : null
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s)

/** The searchable text of one transcript entry, or null when it carries none (for example thinking only). */
export function extract(entry: any): { role: string; text: string } | null {
  const content = entry?.message?.content
  if (typeof content === 'string') return content.trim() ? { role: entry.type, text: content } : null
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  let role: string = entry.type
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'tool_use') {
      parts.push(`[tool: ${block.name}] ${clip(JSON.stringify(block.input ?? {}), MAX_TOOL_TEXT)}`)
    } else if (block?.type === 'tool_result') {
      role = 'tool'
      const c = block.content
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : ''
      if (text.trim()) parts.push(clip(text, MAX_TOOL_TEXT))
    }
  }
  const text = parts.join('\n').trim()
  return text ? { role, text } : null
}

function nameFor(claudeSessionId: string, cache: Map<string, string | null>) {
  if (!cache.has(claudeSessionId)) {
    cache.set(claudeSessionId, sessions.all().find(s => s.claude_session_id === claudeSessionId)?.name ?? null)
  }
  return cache.get(claudeSessionId) ?? null
}

function ingestLines(lines: string[], project: string, names: Map<string, string | null>) {
  let added = 0
  const latest = new Map<string, { model?: string; effort?: string }>()
  db.exec('BEGIN')
  try {
    for (const line of lines) {
      // Most lines are bookkeeping (request records, file snapshots), some of them very large. Skip them cheaply.
      if (!line.includes('"uuid"') || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if ((entry.type !== 'user' && entry.type !== 'assistant') || !entry.uuid || !entry.sessionId) continue
      const info = modelInfo(entry)
      if (info) {
        const owner = nameFor(entry.sessionId, names)
        if (owner) latest.set(owner, { ...latest.get(owner), ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)) })
      }
      const found = extract(entry)
      if (!found) continue
      const name = nameFor(entry.sessionId, names)
      const raw = line.length <= MAX_RAW ? line : JSON.stringify({ truncated: true, bytes: line.length })
      const r = insert.run(entry.sessionId, name, project, entry.uuid, entry.timestamp ?? null, found.role, found.text, raw)
      if (!r.changes) continue
      added++
      // A hub message showing up in the session's own transcript is proof it was delivered.
      if (name && found.role === 'user') {
        for (const m of found.text.matchAll(/<channel\b[^>]*\bmsg_id="(\d+)"/g)) {
          const id = Number(m[1])
          const row = messageTarget.get(id) as { target: string } | undefined
          if (row?.target === name && outbox.markAcked(id, 'transcript').changes) {
            broadcast({ type: 'delivery', message_id: id, state: 'acked', via: 'channel' })
          }
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  // Only lines appended since the last pass are read, so this reflects the newest turns.
  for (const [name, v] of latest) noteModel(name, v.model, v.effort)
  return added
}

async function ingestFile(file: string, project: string, names: Map<string, string | null>) {
  const size = fs.statSync(file).size
  let offset = (getOffset.get(file) as { offset: number } | undefined)?.offset ?? 0
  if (size < offset) offset = 0 // rewritten (compaction can do this); entries are deduplicated by uuid
  if (size === offset) return 0
  let added = 0
  const fd = fs.openSync(file, 'r')
  try {
    let carry = Buffer.alloc(0)
    const buf = Buffer.allocUnsafe(CHUNK)
    let pos = offset
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos)
      if (!n) break
      pos += n
      const data = Buffer.concat([carry, buf.subarray(0, n)])
      const lastNewline = data.lastIndexOf(0x0a)
      if (lastNewline === -1) {
        carry = data
        continue
      }
      // Only whole lines are consumed; a line still being written is picked up on the next pass.
      added += ingestLines(data.subarray(0, lastNewline).toString('utf8').split('\n'), project, names)
      carry = data.subarray(lastNewline + 1)
      setOffset.run(file, pos - carry.length)
      await new Promise(r => setImmediate(r)) // keep the hub responsive during a large backfill
    }
  } finally {
    fs.closeSync(fd)
  }
  return added
}

function* transcriptFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* transcriptFiles(p)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p
  }
}

/** One pass over every transcript file: reads whatever was appended since the last pass. */
export async function ingestAll(): Promise<{ files: number; added: number }> {
  const root = config.transcriptsDir
  const names = new Map<string, string | null>()
  let files = 0
  let added = 0
  for (const file of transcriptFiles(root)) {
    const project = path.relative(root, file).split(path.sep)[0]
    try {
      const n = await ingestFile(file, project, names)
      if (n) files++
      added += n
    } catch (e: any) {
      if (e?.code !== 'ENOENT') console.error(`transcript ingest failed for ${file}:`, e?.message ?? e)
    }
  }
  return { files, added }
}

/** Each session's current model and effort from the end of its transcript, at startup: sessions that have been
 *  quiet since Neural started, or switched model before it watched for that, show the right thing at once. */
export function seedModels() {
  for (const s of sessions.all()) {
    if (!s.transcript_path) continue
    try {
      const size = fs.statSync(s.transcript_path).size
      const fd = fs.openSync(s.transcript_path, 'r')
      const start = Math.max(0, size - (1 << 20))
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      // Newest first: the first model and the first effort found are the current ones.
      let model: string | undefined
      let effort: string | undefined
      for (const line of buf.toString('utf8').split('\n').reverse()) {
        if (!line.includes('"type":"assistant"') && !line.includes('local-command-stdout')) continue
        let info: ReturnType<typeof modelInfo> = null
        try {
          info = modelInfo(JSON.parse(line))
        } catch {
          continue // a partial first line from the cut
        }
        model ??= info?.model
        effort ??= info?.effort
        if (model && effort) break
      }
      noteModel(s.name, model, effort)
    } catch {
      // transcript gone; the next reply reports it
    }
  }
}

export function transcriptCount(): number {
  return (db.prepare('SELECT count(*) AS n FROM transcript_entries').get() as { n: number }).n
}
