// One-time move from the Claude Hub names to Neural. Safe to run more than once.
// Deliberately imports nothing from the server, so loading config cannot create files in the new data folder first.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const home = os.homedir()
const uid = process.getuid!()
const OLD_DIR = path.join(home, '.local/share/claude-hub')
const NEW_DIR = path.join(home, '.local/share/neural')
const OLD_PLIST = path.join(home, 'Library/LaunchAgents/com.claudehub.server.plist')
const step = (s: string) => console.log(`- ${s}`)
const quiet = (bin: string, args: string[]) => {
  try {
    execFileSync(bin, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 1. Stop the old login service, so nothing writes to the old database while it moves.
if (quiet('launchctl', ['bootout', `gui/${uid}/com.claudehub.server`])) step('stopped the old login service')
if (fs.existsSync(OLD_PLIST)) {
  fs.rmSync(OLD_PLIST)
  step('removed com.claudehub.server.plist')
}
// The service may have been run by hand instead.
quiet('pkill', ['-f', 'claude-hub/(server/src/index|bin/hub)\\.ts'])

// 2. Stop the sessions on the old tmux server. Their conversations are kept and resumed under Neural.
if (quiet('tmux', ['-L', 'claude-hub', 'kill-server'])) step('stopped the sessions on the old tmux server (they will be resumed)')

// 3. Move the data folder. Anything the old folder has wins over files created in the new one since.
if (fs.existsSync(OLD_DIR)) {
  fs.mkdirSync(NEW_DIR, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(OLD_DIR)) {
    const target = path.join(NEW_DIR, entry)
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(path.join(OLD_DIR, entry), target)
  }
  fs.rmdirSync(OLD_DIR)
  step(`moved ${OLD_DIR} to ${NEW_DIR}`)
}
for (const suffix of ['', '-wal', '-shm']) {
  const from = path.join(NEW_DIR, `hub.db${suffix}`)
  if (fs.existsSync(from)) fs.renameSync(from, path.join(NEW_DIR, `neural.db${suffix}`))
}
const backups = path.join(NEW_DIR, 'backups')
if (fs.existsSync(backups)) {
  for (const f of fs.readdirSync(backups)) {
    if (/^hub-\d{4}-\d{2}-\d{2}\.db$/.test(f)) fs.renameSync(path.join(backups, f), path.join(backups, f.replace(/^hub-/, 'neural-')))
  }
}

// 4. Point stored session folders at the new location, and refresh the orchestrator's instructions.
const dbFile = path.join(NEW_DIR, 'neural.db')
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile)
  const r = db.prepare('UPDATE sessions SET cwd = replace(cwd, ?, ?) WHERE cwd LIKE ?').run(OLD_DIR, NEW_DIR, `${OLD_DIR}%`)
  if (r.changes) step(`updated the working folder of ${r.changes} session(s)`)
  db.close()
}
const guide = path.join(NEW_DIR, 'orchestrator/CLAUDE.md')
if (fs.existsSync(guide) && fs.readFileSync(guide, 'utf8').includes('Claude Hub')) {
  fs.copyFileSync(path.join(import.meta.dirname, '../orchestrator/CLAUDE.md'), guide)
  step('updated the orchestrator instructions')
}

// 5. Install and start the Neural login service. It resumes the sessions stopped above.
execFileSync(path.join(import.meta.dirname, 'neural'), ['install-service'], { stdio: 'inherit' })
console.log('Done. Sessions come back within about a minute; check with: bin/neural status')
