import { config } from './config.ts'
import { db, vectorsEnabled, search, type SearchHit } from './db.ts'

// Semantic search. A small sentence-embedding model runs locally (nothing is sent anywhere); each message
// and transcript entry is split into chunks, embedded, and stored in a sqlite-vec table. A query is embedded
// the same way and matched by meaning, then merged with the keyword results.

const MODEL = 'Xenova/all-MiniLM-L6-v2' // 384 dimensions
const CHUNK_CHARS = 700
const OVERLAP = 80
const MAX_CHUNKS = 8
const BATCH = 16
const MAX_DISTANCE = 0.7 // cosine distance; beyond this a match is noise

let embedder: Promise<any> | null = null
let failedAt = 0

function getEmbedder(): Promise<any> | null {
  if (!config.embeddings || !vectorsEnabled) return null
  if (failedAt && Date.now() - failedAt < 10 * 60_000) return null // offline at first start: try again later
  embedder ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = config.modelsDir
    return pipeline('feature-extraction', MODEL, { dtype: 'q8' })
  })().catch(e => {
    console.error('semantic search unavailable (embedding model did not load):', e?.message ?? e)
    failedAt = Date.now()
    embedder = null
    return null
  })
  return embedder
}

async function embed(texts: string[]): Promise<Uint8Array[] | null> {
  const model = await getEmbedder()
  if (!model) return null
  const out = await model(texts, { pooling: 'mean', normalize: true })
  const dim = out.dims[1]
  // sqlite-vec takes a vector as the raw bytes of a Float32Array.
  return texts.map((_, i) => new Uint8Array(new Float32Array(out.data.subarray(i * dim, (i + 1) * dim)).buffer))
}

/** Split text into overlapping chunks small enough for the model, dropping tool-call noise. */
export function chunksOf(text: string): string[] {
  const clean = text.split('\n').filter(l => !l.startsWith('[tool: ')).join('\n').replace(/[ \t]+/g, ' ').trim()
  if (clean.length < 24) return []
  const chunks: string[] = []
  let start = 0
  while (start < clean.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + CHUNK_CHARS, clean.length)
    if (end < clean.length) {
      // Prefer to break at a paragraph, sentence or word boundary in the last third of the window.
      const window = clean.slice(start, end)
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '))
      if (cut > CHUNK_CHARS * 0.66) end = start + cut + 1
    }
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = end - OVERLAP
  }
  return chunks.filter(Boolean)
}

const getState = db.prepare('SELECT last_id FROM embed_state WHERE kind = ?')
const setState = db.prepare('INSERT INTO embed_state (kind, last_id) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET last_id = excluded.last_id')
const insertChunk = db.prepare('INSERT INTO chunks (kind, ref_id, seq, text) VALUES (?, ?, ?, ?)')
const insertVec = vectorsEnabled ? db.prepare('INSERT INTO chunk_vecs (rowid, embedding) VALUES (?, ?)') : null
const SOURCES = {
  message: db.prepare("SELECT id, body AS text FROM messages WHERE id > ? AND from_name != 'system' ORDER BY id LIMIT 64"),
  // Tool output is left to keyword search, and hub messages echoed into transcripts are already covered as messages.
  transcript: db.prepare(
    `SELECT id, text FROM transcript_entries
     WHERE id > ? AND role IN ('user', 'assistant') AND text NOT LIKE '<channel source="hub"%' AND text NOT LIKE '<channel source="neural"%' ORDER BY id LIMIT 64`),
  transcriptMax: db.prepare('SELECT max(id) AS id FROM transcript_entries'),
}

/** Embed whatever is new, for up to `budgetMs`. Returns how many chunks were added. */
export async function embedPending(budgetMs = 20_000): Promise<number> {
  if (!getEmbedder() || !insertVec) return 0
  const deadline = Date.now() + budgetMs
  let added = 0
  for (const kind of ['message', 'transcript'] as const) {
    for (;;) {
      const last = (getState.get(kind) as { last_id: number } | undefined)?.last_id ?? 0
      const rows = SOURCES[kind].all(last) as { id: number; text: string }[]
      if (!rows.length) {
        // Skipped rows (tool output) still count as seen, so the scan does not start over each time.
        if (kind === 'transcript') {
          const max = (SOURCES.transcriptMax.get() as { id: number | null }).id ?? 0
          if (max > last) setState.run(kind, max)
        }
        break
      }
      const pieces = rows.flatMap(r => chunksOf(r.text).map((text, seq) => ({ ref: r.id, seq, text })))
      const vectors: Uint8Array[] = []
      for (let i = 0; i < pieces.length; i += BATCH) {
        const batch = await embed(pieces.slice(i, i + BATCH).map(p => p.text))
        if (!batch) return added
        vectors.push(...batch)
        await new Promise(r => setImmediate(r)) // let the hub answer requests between batches
      }
      db.exec('BEGIN')
      try {
        pieces.forEach((p, i) => {
          const id = insertChunk.run(kind, p.ref, p.seq, p.text).lastInsertRowid
          insertVec.run(BigInt(id), vectors[i])
        })
        setState.run(kind, rows[rows.length - 1].id)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
      added += pieces.length
      if (Date.now() > deadline) return added
    }
  }
  return added
}

const nearest = vectorsEnabled
  ? db.prepare(
      `SELECT c.kind, c.ref_id, c.text, v.distance FROM chunk_vecs v JOIN chunks c ON c.id = v.rowid
       WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`)
  : null
const messageRow = db.prepare(
  `SELECT id, ts, CASE WHEN from_name IN ('user','system') THEN to_name ELSE from_name END AS session,
          from_name || ' -> ' || to_name AS who, from_name, to_name FROM messages WHERE id = ?`)
const transcriptRow = db.prepare(
  "SELECT id, ts, COALESCE(session_name, project) AS session, COALESCE(role, '') AS who, session_name FROM transcript_entries WHERE id = ?")

async function semanticHits(input: string, opts: { session?: string; since?: string }, k: number): Promise<SearchHit[]> {
  if (!nearest || !getEmbedder()) return []
  // While the model is still loading, answer with keyword results rather than making the caller wait.
  const vectors = await Promise.race([embed([input]), new Promise<null>(r => setTimeout(() => r(null), 4000))])
  if (!vectors) return []
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const row of nearest.all(vectors[0], k) as { kind: 'message' | 'transcript'; ref_id: number; text: string; distance: number }[]) {
    if (row.distance > MAX_DISTANCE) break
    const key = `${row.kind}:${row.ref_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const src: any = (row.kind === 'message' ? messageRow : transcriptRow).get(row.ref_id)
    if (!src) continue
    if (opts.since && (!src.ts || src.ts < opts.since)) continue
    if (opts.session) {
      const inSession = row.kind === 'message' ? src.from_name === opts.session || src.to_name === opts.session : src.session_name === opts.session
      if (!inSession) continue
    }
    const snippet = row.text.length > 240 ? row.text.slice(0, 239) + '…' : row.text
    hits.push({ kind: row.kind, id: src.id, ts: src.ts, session: src.session, who: src.who, snippet, rank: row.distance })
  }
  return hits
}

/** Keyword and meaning-based results merged by reciprocal rank, best first. */
export async function searchAll(input: string, opts: { session?: string; since?: string; limit?: number } = {}): Promise<SearchHit[]> {
  const limit = Math.min(opts.limit ?? 20, 100)
  if (!/[\p{L}\p{N}]/u.test(input)) return []
  const keyword = search(input, { ...opts, limit: 50 })
  const meaning = await semanticHits(input, opts, 50).catch(() => [])
  const merged = new Map<string, SearchHit & { score: number }>()
  const add = (list: SearchHit[], match: 'keyword' | 'meaning') => list.forEach((hit, i) => {
    const key = `${hit.kind}:${hit.id}`
    const prior = merged.get(key)
    const score = 1 / (60 + i)
    if (prior) Object.assign(prior, { score: prior.score + score, match: 'both' as const })
    else merged.set(key, { ...hit, score, match })
  })
  add(keyword, 'keyword') // added first so its highlighted snippet is the one kept
  add(meaning, 'meaning')
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...hit }) => ({ ...hit, rank: score }))
}

export function embeddingStatus() {
  const chunks = (db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n
  return { enabled: Boolean(config.embeddings && vectorsEnabled), ready: Boolean(embedder) && !failedAt, chunks }
}
