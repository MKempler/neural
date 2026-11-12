import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const dataDir = process.env.HUB_DATA_DIR ?? path.join(os.homedir(), '.local/share/claude-hub')
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
function loadFile(): { allowedLogins?: string[] } {
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
  dbPath: process.env.HUB_DB ?? path.join(dataDir, 'hub.db'),
  port: Number(process.env.HUB_PORT ?? 7777),
  host: '127.0.0.1',
  secret: loadSecret(),
  tmuxSocket: process.env.HUB_TMUX_SOCKET ?? 'claude-hub',
  claudeBin: process.env.HUB_CLAUDE_BIN ?? 'claude',
  nodeBin: process.execPath,
  // Tailscale logins allowed to use the UI when requests arrive through `tailscale serve`.
  // Empty means any tailnet identity that tailscale serve forwards is accepted.
  allowedLogins: process.env.HUB_ALLOWED_LOGINS !== undefined
    ? process.env.HUB_ALLOWED_LOGINS.split(',').map(s => s.trim()).filter(Boolean)
    : (file.allowedLogins ?? []),
  // Start (or resume) autostart sessions when the hub boots.
  autostart: process.env.HUB_AUTOSTART !== '0',
  orchestratorCwd: process.env.HUB_ORCHESTRATOR_CWD ?? path.join(dataDir, 'orchestrator'),
  // Seconds to wait for evidence that a pushed message was read before falling back to a paste.
  ackTimeoutSec: Number(process.env.HUB_ACK_TIMEOUT ?? 90),
  // How often to check that sessions are alive, and the first delay before restarting a dead one (doubles each try).
  reconcileMs: Number(process.env.HUB_RECONCILE_MS ?? 15_000),
  restartBackoffMs: Number(process.env.HUB_RESTART_BACKOFF_MS ?? 15_000),
  retryMs: Number(process.env.HUB_RETRY_MS ?? 10_000),
  // Daily database snapshots.
  backups: process.env.HUB_BACKUPS !== 'off',
  backupDir: process.env.HUB_BACKUP_DIR ?? path.join(dataDir, 'backups'),
  backupKeep: Number(process.env.HUB_BACKUP_KEEP ?? 7),
  // Stop the Mac going to sleep while a session is in the middle of a turn.
  keepAwake: process.env.HUB_KEEP_AWAKE !== 'off' && process.platform === 'darwin',
  // Semantic search: a small embedding model run locally (downloaded once into modelsDir).
  embeddings: process.env.HUB_EMBEDDINGS !== 'off',
  modelsDir: process.env.HUB_MODELS_DIR ?? path.join(dataDir, 'models'),
  embedMs: Number(process.env.HUB_EMBED_MS ?? 5_000),
  // Contact URL sent to push services with each notification (required by the Web Push protocol).
  pushSubject: process.env.HUB_PUSH_SUBJECT ?? 'mailto:claude-hub@example.com',
  // Where Claude Code keeps its transcripts, and how often to archive what was appended.
  transcriptsDir: process.env.HUB_TRANSCRIPTS_DIR ?? path.join(os.homedir(), '.claude/projects'),
  ingestMs: Number(process.env.HUB_INGEST_MS ?? 5_000),
}

export const hubUrl = `http://${config.host}:${config.port}`
