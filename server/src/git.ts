// What a session changed: its repository's branch, push state, commits and diffs, and a short recap of each turn.
// Read-only: git runs without a shell, with optional locks off, and nothing here writes to the repository
// (no index refresh, no objects; file contents are hashed without -w).
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

const MAX_DIFF = 400_000 // characters of diff sent to the app at once
const MAX_HASHED = 300 // dirty files fingerprinted at the start of a turn

function git(cwd: string, args: string[], opts: { okCodes?: number[]; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout: opts.timeout ?? 8000,
      maxBuffer: 16 * 2 ** 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err: any, stdout) => {
      if (err && !(opts.okCodes ?? []).includes(err.code)) reject(err)
      else resolve(String(stdout))
    })
  })
}

/** The repository's top folder, or null when `cwd` isn't inside one. */
async function root(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

async function head(top: string): Promise<string | null> {
  try {
    return (await git(top, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null
  } catch {
    return null // no commits yet
  }
}

export interface FileChange { path: string; code: string }

/** `git status` as [code, path] pairs: "M", "A", "D", "R", "??" (untracked). */
async function status(top: string): Promise<{ branch: string | null; upstream: string | null; ahead: number; behind: number; files: FileChange[] }> {
  const out = await git(top, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all'])
  const parts = out.split('\0')
  let branch: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const files: FileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('## ')) {
      // "## main...origin/main [ahead 2, behind 1]", "## HEAD (no branch)", "## No commits yet on main"
      const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(p)
      if (m) {
        branch = m[1].startsWith('HEAD (') ? null : m[1]
        upstream = m[2] ?? null
        ahead = Number(/ahead (\d+)/.exec(m[3] ?? '')?.[1] ?? 0)
        behind = Number(/behind (\d+)/.exec(m[3] ?? '')?.[1] ?? 0)
      }
      continue
    }
    const xy = p.slice(0, 2)
    const file = p.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i++ // the original name follows a rename
    const code = xy === '??' ? '??' : (xy[0] !== ' ' ? xy[0] : xy[1])
    files.push({ path: file, code })
  }
  return { branch, upstream, ahead, behind, files }
}

export interface Commit { sha: string; short: string; subject: string; author: string; ts: string; pushed: boolean | null }

/** Branch, push state, uncommitted files and recent commits for a session's folder, or null outside git. */
export async function changes(cwd: string, limit = 30) {
  const top = await root(cwd)
  if (!top) return null
  const st = await status(top)
  const h = await head(top)
  let commits: Commit[] = []
  if (h) {
    const out = await git(top, ['log', `-n${limit}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e'])
    // Commits not yet on the upstream branch.
    let unpushed: Set<string> | null = null
    if (st.upstream) {
      try {
        unpushed = new Set((await git(top, ['rev-list', `-n${limit}`, '@{upstream}..HEAD'])).split('\n').filter(Boolean))
      } catch {
        unpushed = null // the upstream is gone
      }
    }
    commits = out.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
      const [sha, short, subject, author, ts] = r.split('\x1f')
      return { sha, short, subject, author, ts, pushed: unpushed ? !unpushed.has(sha) : null }
    })
  }
  return { root: top, ...st, head: h, commits }
}

const SHA = /^[0-9a-f]{7,40}$/

/** A commit's patch, or (no ref) everything not yet committed, untracked files included. Capped for the phone. */
export async function diff(cwd: string, ref?: string | null): Promise<{ diff: string; truncated: boolean } | null> {
  const top = await root(cwd)
  if (!top) return null
  let out: string
  if (ref) {
    if (!SHA.test(ref)) throw new Error('not a commit id')
    out = await git(top, ['show', '--format=', '--patch', '-M', '--no-color', ref])
  } else {
    const h = await head(top)
    out = h ? await git(top, ['diff', 'HEAD', '-M', '--no-color']) : ''
    const st = await status(top)
    for (const f of st.files.filter(f => f.code === '??')) {
      if (out.length > MAX_DIFF) break
      // Exit code 1 just means "they differ".
      out += await git(top, ['diff', '--no-index', '--no-color', '--', '/dev/null', f.path], { okCodes: [1] }).catch(() => '')
    }
  }
  const truncated = out.length > MAX_DIFF
  return { diff: truncated ? out.slice(0, MAX_DIFF) : out, truncated }
}

// ---------------------------------------------------------------------------------------------
// Turn recaps: a fingerprint of the working tree when a turn starts, compared when it ends.

export interface Snapshot { top: string; head: string | null; dirty: Map<string, string> }

async function fingerprint(top: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const list = files.slice(0, MAX_HASHED)
  if (!list.length) return out
  // Deleted files can't be hashed; give them a fixed fingerprint.
  const present: string[] = []
  for (const f of list) {
    try {
      await fs.promises.access(path.join(top, f))
      present.push(f)
    } catch {
      out.set(f, 'deleted')
    }
  }
  if (present.length) {
    const hashes = (await git(top, ['hash-object', '--', ...present])).trim().split('\n')
    present.forEach((f, i) => out.set(f, hashes[i] ?? ''))
  }
  return out
}

export async function snapshot(cwd: string): Promise<Snapshot | null> {
  const top = await root(cwd)
  if (!top) return null
  const st = await status(top)
  return { top, head: await head(top), dirty: await fingerprint(top, st.files.map(f => f.path)) }
}

export interface Recap { commits: number; files: number; insertions: number; deletions: number; unpushed: number | null; branch: string | null }

/** What changed since `before`: new commits, and files changed during the turn (committed or not). */
export async function recap(before: Snapshot): Promise<Recap | null> {
  const { top } = before
  const now = await head(top)
  const st = await status(top)
  let commits = 0
  const touched = new Set<string>()
  if (before.head && now && before.head !== now) {
    commits = Number((await git(top, ['rev-list', '--count', `${before.head}..${now}`]).catch(() => '0')).trim()) || 0
    for (const f of (await git(top, ['diff', '--name-only', '-z', before.head, now]).catch(() => '')).split('\0')) if (f) touched.add(f)
  } else if (!before.head && now) {
    commits = Number((await git(top, ['rev-list', '--count', now])).trim()) || 0
    for (const f of (await git(top, ['ls-tree', '-r', '--name-only', '-z', now])).split('\0')) if (f) touched.add(f)
  }
  // Uncommitted files count only when they changed during this turn, not when they were already dirty and left alone.
  const after = await fingerprint(top, st.files.map(f => f.path))
  for (const [f, hash] of after) if (before.dirty.get(f) !== hash) touched.add(f)
  // Files dirty at the start and committed or reverted during the turn are already covered by the commit diff.
  if (!touched.size && !commits) return null

  // Line counts, against the start of the turn, for tracked files.
  let insertions = 0
  let deletions = 0
  if (before.head) {
    const numstat = await git(top, ['diff', '--numstat', '-z', before.head, '--', ...[...touched].slice(0, 500)]).catch(() => '')
    for (const row of numstat.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(row)
      if (!m) continue
      insertions += Number(m[1]) || 0
      deletions += Number(m[2]) || 0
    }
  }
  return { commits, files: touched.size, insertions, deletions, unpushed: st.upstream ? st.ahead : null, branch: st.branch }
}
