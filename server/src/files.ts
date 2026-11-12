import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import type http from 'node:http'
import { config } from './config.ts'
import { db, setMessageDecorator } from './db.ts'

// Attachments: files the user uploads from the web app, or that a session attaches to a reply.
// Each file is stored under the data folder. Claude opens images with its Read tool, so photos are
// converted to JPEG when the format is one it can't read (HEIC from iPhones) and shrunk when huge.
// Claude can't watch video, so a few still frames are pulled out with ffmpeg and passed along instead.

export type Attachment = {
  id: number
  message_id: number | null
  kind: 'image' | 'video' | 'file'
  name: string
  mime: string
  size: number
  path: string
  view_path: string | null
  poster_path: string | null
  frames: string | null
  width: number | null
  height: number | null
  duration: number | null
  created_at: string
}

/** What the web app needs: no file-system paths. */
export function publicView(a: Attachment) {
  const frames = a.frames ? (JSON.parse(a.frames) as string[]).length : 0
  return {
    id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, width: a.width, height: a.height, duration: a.duration,
    frames, url: `/api/files/${a.id}`, view: a.view_path ? `/api/files/${a.id}/view` : null, poster: a.poster_path ? `/api/files/${a.id}/poster` : null,
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.zip': 'application/zip', '.svg': 'image/svg+xml',
}
const CLAUDE_READS = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_EDGE = 2000

const run = (bin: string, args: string[], timeout = 120_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${bin}: ${String(stderr).trim().split('\n').pop() || err.message}`)) : resolve(stdout)))

function safeName(name: string) {
  const base = path.basename(name || 'file').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(-120)
  return base || 'file'
}

function destination(name: string) {
  const month = new Date().toISOString().slice(0, 7)
  const dir = path.join(config.uploadsDir, month)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = crypto.randomBytes(6).toString('hex')
  return path.join(dir, `${id}-${safeName(name)}`)
}

function mimeOf(name: string, given?: string) {
  const byExt = MIME_BY_EXT[path.extname(name).toLowerCase()]
  if (given && given !== 'application/octet-stream') return given.split(';')[0].trim().toLowerCase()
  return byExt ?? 'application/octet-stream'
}

const kindOf = (mime: string): Attachment['kind'] =>
  mime === 'image/svg+xml' ? 'file' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file'

async function imageSize(file: string) {
  try {
    const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], 30_000)
    const w = Number(out.match(/pixelWidth: (\d+)/)?.[1])
    const h = Number(out.match(/pixelHeight: (\d+)/)?.[1])
    return w && h ? { width: w, height: h } : {}
  } catch {
    return {}
  }
}

/** A version of the photo Claude can open: JPEG when the format needs converting, at most MAX_EDGE pixels. */
async function prepareImage(file: string, mime: string) {
  const size = await imageSize(file)
  const needsConvert = !CLAUDE_READS.has(mime)
  const tooBig = (size.width ?? 0) > MAX_EDGE || (size.height ?? 0) > MAX_EDGE
  if (!needsConvert && !tooBig) return { ...size, view_path: null }
  const view = file.replace(/\.[^.\/]+$/, '') + '.view.jpg'
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82']
  if (tooBig) args.push('-Z', String(MAX_EDGE))
  try {
    await run('sips', [...args, file, '--out', view], 60_000)
    return { ...size, view_path: view }
  } catch {
    return { ...size, view_path: null } // Claude gets the original; better than nothing
  }
}

async function prepareVideo(file: string) {
  let duration = 0
  let width: number | undefined
  let height: number | undefined
  try {
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 30_000))
    duration = Number(probe.format?.duration) || 0
    const v = (probe.streams ?? []).find((s: any) => s.codec_type === 'video')
    width = v?.width
    height = v?.height
    // Phone videos are often stored sideways with a rotation flag.
    const rotation = Math.abs(Number(v?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0))
    if (rotation === 90 || rotation === 270) [width, height] = [height, width]
  } catch {
    return { duration: null, width: null, height: null, poster_path: null, frames: null }
  }
  // Up to eight stills, spread evenly; short clips get fewer.
  const count = Math.max(1, Math.min(8, Math.ceil(duration / 3)))
  const base = file.replace(/\.[^.\/]+$/, '')
  const frames: string[] = []
  for (let i = 0; i < count; i++) {
    const at = duration > 0 ? (duration * (i + 0.5)) / count : 0
    const out = `${base}.frame-${String(i + 1).padStart(2, '0')}.jpg`
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', out], 60_000)
      if (fs.existsSync(out)) frames.push(out)
    } catch {
      // keep whatever frames worked
    }
  }
  return { duration: duration || null, width: width ?? null, height: height ?? null, poster_path: frames[0] ?? null, frames: frames.length ? JSON.stringify(frames) : null }
}

const insert = db.prepare(
  `INSERT INTO attachments (message_id, kind, name, mime, size, path, view_path, poster_path, frames, width, height, duration)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const byId = db.prepare('SELECT * FROM attachments WHERE id = ?')

async function register(file: string, name: string, mime: string, messageId: number | null = null): Promise<Attachment> {
  const kind = kindOf(mime)
  const size = fs.statSync(file).size
  let extra: Record<string, unknown> = {}
  if (kind === 'image') extra = await prepareImage(file, mime)
  else if (kind === 'video') extra = await prepareVideo(file)
  const r = insert.run(messageId, kind, name, mime, size, file, (extra.view_path as string) ?? null, (extra.poster_path as string) ?? null,
    (extra.frames as string) ?? null, (extra.width as number) ?? null, (extra.height as number) ?? null, (extra.duration as number) ?? null)
  return byId.get(Number(r.lastInsertRowid)) as Attachment
}

/** Stream an upload from the web app to disk (the body is the raw file), then prepare it. */
export async function receiveUpload(req: http.IncomingMessage): Promise<Attachment> {
  const name = safeName(decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')))
  const mime = mimeOf(name, String(req.headers['content-type'] ?? ''))
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > config.maxUploadBytes) throw Object.assign(new Error(`That file is too large (limit ${Math.round(config.maxUploadBytes / 2 ** 20)} MB)`), { status: 413 })
  const file = destination(name)
  const out = fs.createWriteStream(file, { mode: 0o600 })
  let bytes = 0
  try {
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > config.maxUploadBytes) throw Object.assign(new Error(`That file is too large (limit ${Math.round(config.maxUploadBytes / 2 ** 20)} MB)`), { status: 413 })
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r))
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error) => (e ? reject(e) : resolve())))
  } catch (e) {
    out.destroy()
    fs.rmSync(file, { force: true })
    throw e
  }
  if (!bytes) {
    fs.rmSync(file, { force: true })
    throw Object.assign(new Error('The file is empty'), { status: 400 })
  }
  return register(file, name, mime)
}

/** A session attaching a file from its own disk: copy it in, so the message keeps working if the original moves. */
export async function importFile(source: string): Promise<Attachment> {
  if (!path.isAbsolute(source)) throw new Error(`file paths must be absolute: ${source}`)
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new Error(`no such file: ${source}`)
  }
  if (!stat.isFile()) throw new Error(`not a file: ${source}`)
  if (stat.size > config.maxUploadBytes) throw new Error(`file too large (limit ${Math.round(config.maxUploadBytes / 2 ** 20)} MB): ${source}`)
  const name = safeName(path.basename(source))
  const file = destination(name)
  fs.copyFileSync(source, file)
  fs.chmodSync(file, 0o600)
  return register(file, name, mimeOf(name))
}

const claim = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL')

/** Attach uploaded files to a message. Each upload can only belong to one message. */
export function claimFor(messageId: number, ids: number[]) {
  for (const id of ids) {
    if (!claim.run(messageId, id).changes) throw new Error(`attachment ${id} is unknown or already sent`)
  }
}

const unsent = db.prepare("SELECT * FROM attachments WHERE message_id IS NULL AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)")
const drop = db.prepare('DELETE FROM attachments WHERE id = ?')

/** Delete uploads that were attached in the app but never sent. Returns how many were removed. */
export function cleanUnsent(olderThanHours = 24): number {
  const rows = unsent.all(`-${olderThanHours} hours`) as Attachment[]
  for (const a of rows) {
    const extra = a.frames ? (JSON.parse(a.frames) as string[]) : []
    for (const f of [a.path, a.view_path, a.poster_path, ...extra]) if (f) fs.rmSync(f, { force: true })
    drop.run(a.id)
  }
  return rows.length
}

export function getAttachment(id: number) {
  return byId.get(id) as Attachment | undefined
}

export function forMessages(ids: number[]): Map<number, Attachment[]> {
  const map = new Map<number, Attachment[]>()
  if (!ids.length) return map
  const rows = db.prepare('SELECT * FROM attachments WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(JSON.stringify(ids)) as Attachment[]
  for (const a of rows) {
    const list = map.get(a.message_id!) ?? []
    list.push(a)
    map.set(a.message_id!, list)
  }
  return map
}

setMessageDecorator(rows => {
  const map = forMessages(rows.map(r => r.id))
  return rows.map(r => ({ ...r, attachments: (map.get(r.id) ?? []).map(publicView) }))
})

/** Uploaded files that exist and have not been sent yet; throws otherwise. */
export function checkUnclaimed(ids: number[]) {
  for (const id of ids) {
    const a = getAttachment(id)
    if (!a || a.message_id !== null) throw new Error(`attachment ${id} is unknown or already sent`)
  }
}

export function summary(list: { kind: string }[]) {
  const n = list.length
  const kinds = new Set(list.map(a => a.kind))
  const noun = kinds.size === 1 ? ({ image: 'photo', video: 'video', file: 'file' } as Record<string, string>)[[...kinds][0]] : 'file'
  return `Sent ${n === 1 ? `a ${noun}` : `${n} ${noun}s`}`
}

const fmtSize = (n: number) => (n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** The text a session receives about attached files: where they are and how to look at them. */
export function describeForClaude(list: Attachment[]): string {
  if (!list.length) return ''
  const lines = [`[${list.length} attached file${list.length === 1 ? '' : 's'}, saved on this Mac. Open images with the Read tool.]`]
  for (const a of list) {
    const dims = a.width && a.height ? `, ${a.width}×${a.height}` : ''
    if (a.kind === 'image') {
      lines.push(`- ${a.name} (photo${dims}, ${fmtSize(a.size)}): ${a.view_path ?? a.path}`)
      if (a.view_path) lines.push(`  original: ${a.path}`)
    } else if (a.kind === 'video') {
      const frames = a.frames ? (JSON.parse(a.frames) as string[]) : []
      lines.push(`- ${a.name} (video${a.duration ? `, ${fmtTime(a.duration)}` : ''}${dims}, ${fmtSize(a.size)}): ${a.path}`)
      if (frames.length) lines.push(`  stills from the video, in order (Read these to see it): ${frames.join(', ')}`)
      else lines.push('  (no stills could be extracted; use ffmpeg on the file if you need to see it)')
    } else {
      lines.push(`- ${a.name} (${a.mime}, ${fmtSize(a.size)}): ${a.path}`)
    }
  }
  return lines.join('\n')
}

/** Serve a stored file, with byte ranges so phones can seek in videos. */
export function serveFile(req: http.IncomingMessage, res: http.ServerResponse, a: Attachment, variant: string | undefined) {
  let file = a.path
  let mime = a.mime
  if (variant === 'view' && a.view_path) [file, mime] = [a.view_path, 'image/jpeg']
  else if (variant === 'poster' && a.poster_path) [file, mime] = [a.poster_path, 'image/jpeg']
  else if (variant && variant !== 'download') throw Object.assign(new Error('not found'), { status: 404 })
  if (!fs.existsSync(file)) throw Object.assign(new Error('file is missing from disk'), { status: 410 })
  const size = fs.statSync(file).size
  const headers: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    // Uploaded files are shown inline, never run as pages of this site.
    'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'content-disposition': `${variant === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
      return
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  fs.createReadStream(file).pipe(res)
}
