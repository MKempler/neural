// A worker's own git worktree: spawn_session(worktree) checks out a branch in <repo>/.claude/worktrees/<session>
// (the folder Claude Code's own --worktree uses), so parallel workers on one repository don't step on each other.
// Stopping the session removes the worktree only when nothing in it is uncommitted; the branch always stays.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err: any, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout)))
  })
}

const DIR = path.join('.claude', 'worktrees')

/** The main checkout's top folder (not a linked worktree's), or null when `cwd` isn't in a repository. */
async function mainTop(cwd: string): Promise<string | null> {
  try {
    const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    return path.basename(common) === '.git' ? path.dirname(common) : null // a bare repository has no checkout
  } catch {
    return null
  }
}

/** Create the worktree for session `name` from the repository at `cwd`. `branch` true means neural/<name>;
 *  an existing branch is checked out, a new one starts at the repository's HEAD. */
export async function create(cwd: string, name: string, branch: string | true): Promise<{ path: string; branch: string }> {
  const top = await mainTop(cwd)
  if (!top) throw new Error(`worktree needs a git repository, and ${cwd} isn't in one`)
  const b = branch === true ? `neural/${name}` : branch
  try { await git(top, ['check-ref-format', '--branch', b]) } catch { throw new Error(`"${b}" isn't a valid branch name`) }
  const dest = path.join(top, DIR, name)
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists; stop the old session or remove that worktree first`)
  const exists = await git(top, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).then(() => true, () => false)
  await git(top, exists ? ['worktree', 'add', dest, b] : ['worktree', 'add', '-b', b, dest])
  exclude(top)
  return { path: dest, branch: b }
}

/** Keep .claude/worktrees/ out of the main checkout's git status, without touching its tracked .gitignore. */
function exclude(top: string) {
  try {
    const file = path.join(top, '.git', 'info', 'exclude')
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (text.split('\n').some(l => l.trim() === '/.claude/worktrees/')) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}/.claude/worktrees/\n`)
  } catch { /* only cosmetic */ }
}

/** When `cwd` is the worktree spawn_session made for `name`, remove it if it's clean. Anything else: null. */
export async function release(cwd: string, name: string): Promise<{ worktree: string; removed: boolean; branch: string | null; reason?: string } | null> {
  if (path.basename(cwd) !== name || path.basename(path.dirname(cwd)) !== 'worktrees' || !fs.existsSync(cwd)) return null
  const top = await mainTop(cwd)
  if (!top || fs.realpathSync(path.join(top, DIR, name)) !== fs.realpathSync(cwd)) return null
  const branch = (await git(cwd, ['branch', '--show-current']).catch(() => '')).trim() || null
  const dirty = (await git(cwd, ['status', '--porcelain']).catch(() => '?')).trim()
  if (dirty) {
    const n = dirty.split('\n').length
    return { worktree: cwd, removed: false, branch, reason: `${n} uncommitted change${n === 1 ? '' : 's'}; kept` }
  }
  await git(top, ['worktree', 'remove', cwd])
  return { worktree: cwd, removed: true, branch }
}
