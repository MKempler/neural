import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** NEURAL_<name>, falling back to the older HUB_<name>. */
export const env = (name: string): string | undefined => process.env[`NEURAL_${name}`] ?? process.env[`HUB_${name}`]

const dataDir = env('DATA_DIR') ?? path.join(os.homedir(), '.local/share/neural')
fs.mkdirSync(path.join(dataDir, 'run'), { recursive: true, mode: 0o700 })

function loadSecret(): string {
  const file = path.join(dataDir, 'secret')
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    const s = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(file, s + '\n', { mode: 0o600 })
    return s
  }
}

// Optional settings file in the data directory; environment variables take precedence.
function loadFile(): { allowedLogins?: string[]; displayName?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}
const file = loadFile()

export const config = {
  dataDir,
  runDir: path.join(dataDir, 'run'),
  dbPath: env('DB') ?? path.join(dataDir, 'neural.db'),
  port: Number(env('PORT') ?? 7777),
  host: '127.0.0.1',
  secret: loadSecret(),
  tmuxSocket: env('TMUX_SOCKET') ?? 'neural',
  claudeBin: env('CLAUDE_BIN') ?? 'claude',
  nodeBin: process.execPath,
  // Tailscale logins allowed to use the UI when requests arrive through `tailscale serve`.
  // Empty means any tailnet identity that tailscale serve forwards is accepted.
  allowedLogins: env('ALLOWED_LOGINS') !== undefined
    ? env('ALLOWED_LOGINS')!.split(',').map(s => s.trim()).filter(Boolean)
    : (file.allowedLogins ?? []),
  // Name used in the greeting. Kept in config.json, not in the code, because the repository is public.
  displayName: env('DISPLAY_NAME') ?? file.displayName ?? '',
  // Start (or resume) autostart sessions when the hub boots.
  autostart: env('AUTOSTART') !== '0',
  orchestratorCwd: env('ORCHESTRATOR_CWD') ?? path.join(dataDir, 'orchestrator'),
  // Seconds to wait for evidence that a pushed message was read before falling back to a paste.
  ackTimeoutSec: Number(env('ACK_TIMEOUT') ?? 90),
  // How often to check that sessions are alive, and the first delay before restarting a dead one (doubles each try).
  reconcileMs: Number(env('RECONCILE_MS') ?? 15_000),
  restartBackoffMs: Number(env('RESTART_BACKOFF_MS') ?? 15_000),
  retryMs: Number(env('RETRY_MS') ?? 10_000),
  // Files attached to messages, and the largest single file accepted.
  uploadsDir: env('UPLOADS_DIR') ?? path.join(dataDir, 'uploads'),
  maxUploadBytes: Number(env('MAX_UPLOAD_MB') ?? 1024) * 2 ** 20,
  // Daily database snapshots.
  backups: env('BACKUPS') !== 'off',
  backupDir: env('BACKUP_DIR') ?? path.join(dataDir, 'backups'),
  backupKeep: Number(env('BACKUP_KEEP') ?? 7),
  // Stop the Mac going to sleep while a session is in the middle of a turn.
  keepAwake: env('KEEP_AWAKE') !== 'off' && process.platform === 'darwin',
  // Semantic search: a small embedding model run locally (downloaded once into modelsDir).
  embeddings: env('EMBEDDINGS') !== 'off',
  modelsDir: env('MODELS_DIR') ?? path.join(dataDir, 'models'),
  embedMs: Number(env('EMBED_MS') ?? 5_000),
  // Contact URL sent to push services with each notification (required by the Web Push protocol).
  pushSubject: env('PUSH_SUBJECT') ?? 'mailto:neural@example.com',
  // Where Claude Code keeps its transcripts, and how often to archive what was appended.
  transcriptsDir: env('TRANSCRIPTS_DIR') ?? path.join(os.homedir(), '.claude/projects'),
  ingestMs: Number(env('INGEST_MS') ?? 5_000),
}

export const hubUrl = `http://${config.host}:${config.port}`
