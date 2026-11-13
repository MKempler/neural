// A one-off pass that redacts secrets already in the archive, from before redaction existed (or from before a
// rule was added: bump VERSION and it runs again). Messages, archived transcript text and original lines, their
// search indexes, the text of embedded chunks, events and questions are all covered. With secure_delete on, the
// old content is overwritten; the search indexes are then merged and the file rebuilt, so no old copy of a token
// is left in it. Backups made before the pass still hold the old content until they age out.
import { db, prefs } from './db.ts'
import { redact } from './redact.ts'
import { rawLine } from './ingest.ts'
import zlib from 'node:zlib'

const VERSION = 2
const BATCH = 500

const tick = () => new Promise(r => setImmediate(r))

/** Redact one column of a table in batches; `fts` keeps a contentless-sync FTS table in step. */
async function pass(opts: {
  table: string; column: string; fts?: string; ftsColumn?: string
  read?: (v: any) => string | null; write?: (s: string) => unknown
}): Promise<number> {
  const { table, column, fts, ftsColumn = column } = opts
  const read = opts.read ?? ((v: any) => (v == null ? null : String(v)))
  const write = opts.write ?? ((s: string) => s)
  const select = db.prepare(`SELECT id, ${column} AS v FROM ${table} WHERE id > ? ORDER BY id LIMIT ${BATCH}`)
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
  const ftsDelete = fts ? db.prepare(`INSERT INTO ${fts}(${fts}, rowid, ${ftsColumn}) VALUES ('delete', ?, ?)`) : null
  const ftsInsert = fts ? db.prepare(`INSERT INTO ${fts}(rowid, ${ftsColumn}) VALUES (?, ?)`) : null
  let changed = 0
  let after = 0
  for (;;) {
    const rows = select.all(after) as { id: number; v: any }[]
    if (!rows.length) return changed
    db.exec('BEGIN')
    try {
      for (const row of rows) {
        const before = read(row.v)
        if (before == null) continue
        const r = redact(before)
        if (!r.found.length) continue
        update.run(write(r.text) as any, row.id)
        if (ftsDelete && ftsInsert) {
          ftsDelete.run(row.id, before)
          ftsInsert.run(row.id, r.text)
        }
        changed++
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    after = rows[rows.length - 1].id
    await tick()
  }
}

export async function scrubArchive(): Promise<Record<string, number> | null> {
  if ((prefs.get<number>('scrubVersion') ?? 0) >= VERSION) return null
  const counts = {
    messages: await pass({ table: 'messages', column: 'body', fts: 'messages_fts' }),
    transcripts: await pass({ table: 'transcript_entries', column: 'text', fts: 'transcript_fts' }),
    originals: await pass({
      table: 'transcript_entries', column: 'raw',
      read: v => (v == null ? null : rawLine(v)), write: s => zlib.deflateSync(s),
    }),
    chunks: await pass({ table: 'chunks', column: 'text' }),
    events: await pass({ table: 'events', column: 'payload' }),
    questions: await pass({ table: 'questions', column: 'payload' }),
  }
  // Merge the search indexes into fresh segments, so old tokens are gone from them too. Then rebuild the file:
  // pages freed before secure_delete was on can still hold old content, and VACUUM writes only live data.
  // It takes a few seconds and holds a lock meanwhile, which is why it runs once per version, after startup.
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')")
  db.exec("INSERT INTO transcript_fts(transcript_fts) VALUES ('optimize')")
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.exec('VACUUM')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  prefs.set('scrubVersion', VERSION)
  return counts
}
