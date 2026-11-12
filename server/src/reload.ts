import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { ROOT, config } from './config.ts'
import { broadcast } from './live.ts'

// Picks up code changes without anyone restarting anything:
// - Server code: check the new code loads, then exit; the login service (launchd, KeepAlive) starts Neural
//   again within a second or two. Sessions keep running in tmux and their channels reconnect.
// - Web app: tell open pages a new version is available; they reload when it won't interrupt anything.

const SERVER_DIRS = ['server/src', 'channel', 'db/migrations']
const WEB_DIR = 'web'

/** Changes to the web files: newest modification time, so pages can tell they are out of date. */
export let webVersion = latestMtime(path.join(ROOT, WEB_DIR))

function latestMtime(dir: string): string {
  let newest = 0
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else newest = Math.max(newest, fs.statSync(p).mtimeMs)
    }
  }
  try {
    walk(dir)
  } catch {
    // missing folder: version stays 0
  }
  return String(Math.round(newest))
}

/** Load the changed server code in a throwaway process; only restart if that works. */
function newCodeLoads(): Promise<string | null> {
  return new Promise(resolve => {
    const probe = `await import(${JSON.stringify(path.join(ROOT, 'server/src/index.ts'))}); process.exit(0)`
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', probe],
      { env: { ...process.env, NEURAL_AUTOSTART: '0' }, timeout: 60_000 },
      (err, _out, stderr) => {
        if (!err) return resolve(null)
        const lines = String(stderr).split('\n').map(l => l.trim()).filter(Boolean)
        const where = lines.find(l => l.startsWith('file://') || l.startsWith('/'))
        resolve([lines.find(l => /Error\b/.test(l)) ?? err.message, where].filter(Boolean).join(' at '))
      })
  })
}

function debounce(fn: () => void, ms: number) {
  let t: NodeJS.Timeout | undefined
  return () => {
    clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}

/** True when launchd runs Neural as the login service, so exiting means "start me again". */
export const underService = process.env.XPC_SERVICE_NAME === 'com.neural.server' || process.env.NEURAL_SERVICE === '1'

export function watchForChanges(stop: () => Promise<unknown>) {
  if (!config.autoReload) return
  const onServerChange = debounce(async () => {
    if (!underService) {
      console.log('neural: server code changed; restart Neural to use it (bin/neural restart)')
      return
    }
    const problem = await newCodeLoads()
    if (problem) {
      console.error(`neural: server code changed but does not load, keeping the running version: ${problem}`)
      return
    }
    console.log('neural: server code changed; restarting to use it')
    await stop().catch(() => {})
    process.exit(0)
  }, 1500)
  const onWebChange = debounce(() => {
    webVersion = latestMtime(path.join(ROOT, WEB_DIR))
    broadcast({ type: 'version', web: webVersion })
  }, 800)

  const watch = (dir: string, fn: () => void) => {
    try {
      fs.watch(path.join(ROOT, dir), { recursive: true }, (_e, file) => {
        if (file && !/(^|\/)\.|~$|\.swp$/.test(String(file))) fn()
      })
    } catch (e: any) {
      console.error(`neural: cannot watch ${dir} for changes: ${e?.message ?? e}`)
    }
  }
  for (const dir of SERVER_DIRS) watch(dir, onServerChange)
  watch(WEB_DIR, onWebChange)
}
