import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { db } from './db.ts'

// One consistent copy of the database per day, keeping the most recent few.
// The copies sit next to the database by default, which protects against corruption and mistakes but not a
// lost disk; point NEURAL_BACKUP_DIR at a synced folder (iCloud Drive, an external disk) for that.

const NAME = /^(?:neural|hub)-\d{4}-\d{2}-\d{2}\.db$/

export function backupNow(opts: { force?: boolean } = {}): string | null {
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 })
  const file = path.join(config.backupDir, `neural-${new Date().toISOString().slice(0, 10)}.db`)
  if (fs.existsSync(file)) {
    if (!opts.force) return null
    fs.rmSync(file)
  }
  // VACUUM INTO writes a compact, self-contained snapshot without stopping the hub.
  db.prepare('VACUUM INTO ?').run(file)
  fs.chmodSync(file, 0o600)
  const old = fs.readdirSync(config.backupDir).filter(f => NAME.test(f)).sort().slice(0, -config.backupKeep)
  for (const f of old) fs.rmSync(path.join(config.backupDir, f))
  return file
}

export function listBackups() {
  try {
    return fs.readdirSync(config.backupDir).filter(f => NAME.test(f)).sort()
  } catch {
    return []
  }
}
