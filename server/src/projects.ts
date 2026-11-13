// New projects in a couple of taps: the folders in the projects folder (~/Projects by default), a new project
// (a folder with git, and optionally a private GitHub repository) and clones of the user's GitHub repositories.
// Folders are only ever created inside the projects folder, and nothing here deletes anything.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { config, findBin } from './config.ts'
import { sessions } from './db.ts'

/** Project folder names: the same rule as session names, so a project and its session can share one. */
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** owner/name on GitHub. */
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

function run(bin: string, args: string[], cwd?: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 8 * 2 ** 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim().split('\n').pop() || err.message))
      else resolve(String(stdout))
    })
  })
}

let ghPath: string | null | undefined
let ghReady: { at: number; ok: boolean } | null = null

/** Is the GitHub CLI installed and signed in? Checked at most once a minute. */
export async function github(): Promise<boolean> {
  if (ghReady && Date.now() - ghReady.at < 60_000) return ghReady.ok
  if (ghPath === undefined) ghPath = findBin('gh')
  let ok = false
  if (ghPath) ok = await run(ghPath, ['auth', 'status'], undefined, 10_000).then(() => true, () => false)
  ghReady = { at: Date.now(), ok }
  return ok
}

async function gh(args: string[], cwd?: string) {
  if (!(await github())) throw new Error('the GitHub CLI (gh) is not installed or not signed in; run `gh auth login`')
  return run(ghPath!, args, cwd)
}

/** The branch a folder's repository is on, read from .git/HEAD without running git. */
function branch(dir: string): string | null | undefined {
  try {
    const head = fs.readFileSync(path.join(dir, '.git/HEAD'), 'utf8').trim()
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : 'detached'
  } catch {
    return fs.existsSync(path.join(dir, '.git')) ? null : undefined // a worktree's .git is a file
  }
}

export interface Folder { name: string; path: string; git: boolean; branch: string | null; modified: string; sessions: string[] }

/** The folders in the projects folder, most recently changed first, with the sessions already working in each. */
export function folders(): { root: string; folders: Folder[] } {
  const root = config.projectsRoot
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { root, folders: [] }
  }
  const all = sessions.all()
  const list: Folder[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = path.join(root, e.name)
    let st: fs.Stats
    try {
      st = fs.statSync(p) // follows symlinks
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const real = fs.realpathSync(p)
    const b = branch(p)
    list.push({
      name: e.name, path: p, git: b !== undefined, branch: b ?? null, modified: st.mtime.toISOString(),
      sessions: all.filter(s => s.cwd === p || s.cwd === real).map(s => s.name),
    })
  }
  list.sort((a, b) => b.modified.localeCompare(a.modified))
  return { root, folders: list }
}

function target(name: string) {
  const dir = path.join(config.projectsRoot, name)
  // Belt and braces: the name rules already keep it to one plain folder inside the projects folder.
  if (path.dirname(dir) !== path.resolve(config.projectsRoot)) throw new Error('projects are created inside the projects folder only')
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`)
  return dir
}

/** A new, empty project: a folder with git, and optionally a private GitHub repository as its origin. */
export async function create(name: string, opts: { github?: boolean } = {}): Promise<{ path: string; repo: string | null }> {
  if (!PROJECT_RE.test(name)) throw new Error('project name must be lowercase letters, digits, - or _ (up to 32 characters)')
  if (opts.github && !(await github())) throw new Error('the GitHub CLI (gh) is not installed or not signed in; run `gh auth login`')
  const dir = target(name)
  fs.mkdirSync(config.projectsRoot, { recursive: true })
  fs.mkdirSync(dir)
  await run('git', ['init', '-q', '-b', 'main'], dir)
  let repo: string | null = null
  if (opts.github) {
    const out = await gh(['repo', 'create', name, '--private', '--source', '.', '--remote', 'origin'], dir)
    repo = /github\.com\/([^\s/]+\/[^\s/]+)/.exec(out)?.[1] ?? name
  }
  return { path: dir, repo }
}

/** The user's GitHub repositories, most recently updated first. */
export async function repos() {
  const out = await gh(['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,name,description,isPrivate,updatedAt'])
  const list = JSON.parse(out) as { nameWithOwner: string; name: string; description: string; isPrivate: boolean; updatedAt: string }[]
  const root = config.projectsRoot
  return list
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(r => ({ ...r, cloned: fs.existsSync(path.join(root, r.name)) }))
}

/** Clone owner/name into the projects folder. */
export async function clone(repo: string): Promise<{ path: string }> {
  if (!REPO_RE.test(repo)) throw new Error('repository must look like owner/name')
  const name = repo.split('/')[1]
  if (name.startsWith('.')) throw new Error('not a repository name')
  const dir = target(name)
  fs.mkdirSync(config.projectsRoot, { recursive: true })
  await gh(['repo', 'clone', repo, dir, '--', '-q'])
  return { path: dir }
}

/** A session name made from a folder name: "My.Project" → "my-project". */
export function sessionName(folder: string) {
  return folder.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 32) || 'project'
}
