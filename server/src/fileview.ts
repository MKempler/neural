import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type http from 'node:http'
import { config } from './config.ts'
import { sessions } from './db.ts'
import { redact } from './redact.ts'

// Read-only file viewer: tapping a path in a message opens the file rendered. Only files under a known session's
// folder, the orchestrator's folder or the uploads are reachable, checked after resolving symlinks, and files that
// usually hold secrets (keys, .env, ~/.ssh) are refused even there. Text is redacted like the archive is.

export class ViewError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const TEXT_MAX = 1024 * 1024 // larger text files show their first megabyte
const IMAGE_MAX = 25 * 1024 * 1024

const IMAGES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
}
const MARKDOWN = new Set(['.md', '.markdown', '.mdx'])
// Language names the viewer's highlighter knows, by extension.
const LANGS: Record<string, string> = {
  '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.json': 'json',
  '.py': 'py', '.rb': 'py', '.sh': 'sh', '.bash': 'sh', '.zsh': 'sh', '.go': 'c', '.rs': 'c', '.c': 'c', '.h': 'c',
  '.cpp': 'c', '.java': 'c', '.kt': 'c', '.swift': 'c', '.cs': 'c', '.css': 'css', '.html': 'html', '.xml': 'html',
  '.sql': 'sql', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'yaml', '.lua': 'lua', '.luau': 'lua',
}

// Never shown, wherever they are: they usually hold credentials.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.password-store'])
const SECRET_FILE = /^(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_[a-z0-9]+|credentials(\.json)?|secrets?(\.[a-z]+)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i

function realOrNull(p: string) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/** The folders the viewer may read from, resolved. */
export function roots(): string[] {
  const dirs = [config.orchestratorCwd, config.uploadsDir, ...sessions.all().map(s => s.cwd)]
  return [...new Set(dirs.filter(Boolean).map(realOrNull).filter((d): d is string => Boolean(d)))]
}

function secret(file: string) {
  const parts = file.split(path.sep)
  return parts.some(part => SECRET_DIRS.has(part)) || SECRET_FILE.test(parts[parts.length - 1])
}

const inside = (file: string, dir: string) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

/** Resolve what was tapped (absolute, ~/..., or relative to a session's folder) to an allowed file, or throw. */
export function resolve(raw: string, base?: string): string {
  let p = String(raw ?? '').trim().replace(/^file:\/\//, '')
  if (!p || p.includes('\0')) throw new ViewError(400, 'no path')
  p = p.replace(/^~(?=\/|$)/, os.homedir())
  if (!path.isAbsolute(p)) {
    const cwd = base ? sessions.get(base)?.cwd : undefined
    if (!cwd) throw new ViewError(400, 'a relative path needs a session')
    p = path.join(cwd, p)
  }
  const real = realOrNull(p)
  if (!real) throw new ViewError(404, 'no such file')
  if (!roots().some(dir => inside(real, dir))) throw new ViewError(403, 'outside the folders Neural can show')
  if (secret(real)) throw new ViewError(403, 'this file usually holds secrets, so it is not shown')
  if (real === path.join(config.dataDir, 'secret')) throw new ViewError(403, 'not shown')
  return real
}

export interface View {
  path: string
  name: string
  size: number
  modified: number
  kind: 'markdown' | 'code' | 'text' | 'image' | 'binary' | 'folder'
  entries?: { name: string; folder: boolean; size: number }[]
  lang?: string
  text?: string
  truncated?: boolean
  redacted?: number
}

/** What the viewer shows for a file: its text (redacted), or for an image just its kind, fetched raw separately. */
export function view(raw: string, base?: string): View {
  const file = resolve(raw, base)
  const st = fs.statSync(file)
  if (st.isDirectory()) {
    const entries = fs.readdirSync(file, { withFileTypes: true })
      .filter(d => !secret(path.join(file, d.name)) && d.name !== '.git' && d.name !== 'node_modules' && d.name !== '.DS_Store')
      .map(d => {
        let size = 0
        let folder = d.isDirectory()
        try {
          const s = fs.statSync(path.join(file, d.name))
          folder = s.isDirectory()
          size = s.size
        } catch {}
        return { name: d.name, folder, size }
      })
      .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name))
    return { path: file, name: path.basename(file), size: 0, modified: st.mtimeMs, kind: 'folder', entries: entries.slice(0, 1000) }
  }
  if (!st.isFile()) throw new ViewError(400, 'not a file')
  const ext = path.extname(file).toLowerCase()
  const out: View = { path: file, name: path.basename(file), size: st.size, modified: st.mtimeMs, kind: 'text' }
  if (IMAGES[ext]) return { ...out, kind: 'image' }
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(Math.min(st.size, TEXT_MAX))
  try {
    fs.readSync(fd, buf, 0, buf.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  // A NUL byte in the first few KB: not text.
  if (buf.subarray(0, 8192).includes(0)) return { ...out, kind: 'binary' }
  const { text, found } = redact(buf.toString('utf8'))
  out.text = text
  if (found.length) out.redacted = found.length
  if (st.size > TEXT_MAX) out.truncated = true
  if (MARKDOWN.has(ext)) out.kind = 'markdown'
  else if (LANGS[ext]) Object.assign(out, { kind: 'code', lang: LANGS[ext] })
  return out
}

/** Stream an image file (only images: anything served raw on this origin must not be able to run script). */
export function serveRaw(res: http.ServerResponse, raw: string, base?: string) {
  const file = resolve(raw, base)
  const type = IMAGES[path.extname(file).toLowerCase()]
  if (!type) throw new ViewError(415, 'only images are served raw')
  const st = fs.statSync(file)
  if (!st.isFile() || st.size > IMAGE_MAX) throw new ViewError(400, 'not an image this viewer shows')
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    // An SVG opened on its own must not run script on this origin.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  })
  fs.createReadStream(file).pipe(res)
}
