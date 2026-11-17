// Scheduled jobs, run by Neural itself: a shell command, or a prompt sent to a session, on a schedule. Each run's
// outcome and output are kept. A failure is reported to the orchestrator straight away, again (with a push
// notification) when a job keeps failing, and once more when it works again, so a broken job doesn't go
// unnoticed for days. Commands get the user's login-shell PATH, so `claude`, `node` and Homebrew tools are found
// the way they are in a terminal (a launchd job's bare PATH is a common reason jobs fail).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, config, findBin } from './config.ts'
import { db, sessions } from './db.ts'
import { broadcast } from './live.ts'
import { clean } from './redact.ts'
import { notify } from './push.ts'

export interface Job {
  id: number; name: string; schedule: string; command: string | null; session: string | null; prompt: string | null
  cwd: string | null; timeout_s: number; enabled: number; created_by: string | null; created_at: string
  next_run_at: string | null; failures: number
}
export interface Run { id: number; job_id: number; started_at: string; finished_at: string | null; status: string; exit_code: number | null; output: string | null; trigger: string; pid: number | null }
type Result = { status: string; code: number | null; output: string }

const q = <T>(sql: string) => {
  const st = db.prepare(sql)
  return { get: (...a: any[]) => st.get(...a) as T | undefined, all: (...a: any[]) => st.all(...a) as T[], run: (...a: any[]) => st.run(...a) }
}
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"

const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/
/** Failed runs in a row after which the user is notified too. */
export const ESCALATE_AFTER = 3
const KEEP_RUNS = 50
const OUTPUT_MAX = 32 * 1024

// ---------------------------------------------------------------------------------------------
// Schedules: "every 30m", "every 6h", "daily 08:00", "weekdays 09:30", "mon,thu 18:00", or 5-field cron
// ("0 8 * * 1-5"). Times are local.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

type Spec = { every: number } | { cron: Set<number>[] }

function field(text: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>()
  for (const part of text.toLowerCase().split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText ? Number(stepText) : 1
    const val = (v: string) => (names?.includes(v) ? names.indexOf(v) : Number(v))
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(val) as [number, number?]
    if (hi === undefined) hi = stepText ? max : lo
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) || step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`bad schedule field "${part}"`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseSchedule(text: string): Spec {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ')
  let m = /^every (\d+) ?(m|min|mins|minutes?|h|hours?|d|days?)$/.exec(s)
  if (m) {
    const n = Number(m[1]) * (m[2].startsWith('m') ? 60_000 : m[2].startsWith('h') ? 3600_000 : 86400_000)
    if (n < 60_000) throw new Error('jobs run at most once a minute')
    return { every: n }
  }
  m = /^(daily|weekdays|weekends|[a-z]{3}(?:,[a-z]{3})*) (\d{1,2}):(\d{2})$/.exec(s)
  if (m) {
    const days = m[1] === 'daily' ? '*' : m[1] === 'weekdays' ? '1-5' : m[1] === 'weekends' ? '0,6' : m[1]
    return parseSchedule(`${Number(m[3])} ${Number(m[2])} * * ${days}`)
  }
  const f = s.split(' ')
  if (f.length !== 5) throw new Error('schedule must be like "every 30m", "daily 08:00", "weekdays 09:30", "mon,thu 18:00" or cron "0 8 * * 1-5"')
  return { cron: [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4].replace(/\b7\b/, '0'), 0, 6, DAYS)] }
}

/** The next time after `from` the schedule fires. */
export function nextRun(schedule: string, from = Date.now()): number {
  const spec = parseSchedule(schedule)
  if ('every' in spec) return from + spec.every
  const [mins, hours, doms, months, dows] = spec.cron
  const d = new Date(from)
  d.setSeconds(0, 0)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1)
    if (mins.has(d.getMinutes()) && hours.has(d.getHours()) && doms.has(d.getDate()) && months.has(d.getMonth() + 1) && dows.has(d.getDay())) return d.getTime()
  }
  throw new Error('that schedule never fires')
}

// ---------------------------------------------------------------------------------------------
// Storage.

export const jobs = {
  all: () => q<Job>('SELECT * FROM jobs ORDER BY name').all(),
  get: (name: string) => q<Job>('SELECT * FROM jobs WHERE name = ?').get(name),
  due: () => q<Job>('SELECT * FROM jobs WHERE enabled = 1 AND next_run_at <= ?').all(new Date().toISOString()),
  runs: (jobId: number, limit = 10) => q<Run>('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(jobId, limit),
  lastRun: (jobId: number) => q<Run>('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId),
}

/** The command job that was running in `cwd` (or a folder above it) at the ISO time `at`, if any. */
export function jobAt(cwd: string, at: string): string | null {
  const rows = q<{ name: string; cwd: string | null }>(
    `SELECT j.name, j.cwd FROM job_runs r JOIN jobs j ON j.id = r.job_id
     WHERE j.command IS NOT NULL AND r.started_at <= ? AND (r.finished_at IS NULL OR r.finished_at >= ?) ORDER BY r.id DESC`).all(at, at)
  return rows.find(r => r.cwd && (cwd === r.cwd || cwd.startsWith(r.cwd.replace(/\/$/, '') + '/')))?.name ?? null
}

/** A job as the app and the tools show it: with its last run. */
export function view(j: Job) {
  const last = jobs.lastRun(j.id)
  return {
    name: j.name, schedule: j.schedule, enabled: Boolean(j.enabled), cwd: j.cwd, timeout_s: j.timeout_s,
    ...(j.command ? { command: j.command } : { session: j.session, prompt: j.prompt }),
    created_by: j.created_by, next_run_at: j.enabled ? j.next_run_at : null, failures_in_a_row: j.failures,
    last_run: last ? { status: last.status, started_at: last.started_at, finished_at: last.finished_at, exit_code: last.exit_code, output_tail: tailOf(last.output, 15) } : null,
  }
}

const tailOf = (text: string | null, lines: number) => (text ?? '').trimEnd().split('\n').slice(-lines).join('\n')

function changed(name: string) {
  const j = jobs.get(name)
  broadcast(j ? { type: 'job', job: view(j) } : { type: 'job_removed', name })
}

export function addJob(by: string, a: { name?: unknown; schedule?: unknown; command?: unknown; session?: unknown; prompt?: unknown; cwd?: unknown; timeout_s?: unknown }) {
  const name = String(a.name ?? '')
  if (!NAME_RE.test(name)) throw new Error('name must be lowercase letters, digits, . _ - (up to 40 characters)')
  const schedule = String(a.schedule ?? '')
  const next = nextRun(schedule) // checks it
  const command = a.command ? String(a.command) : null
  const session = a.session ? String(a.session) : null
  const prompt = a.prompt ? String(a.prompt) : null
  if (Boolean(command) === Boolean(session && prompt)) throw new Error('give either command, or session and prompt')
  if (session && !sessions.get(session)) throw new Error(`no session "${session}"`)
  const cwd = a.cwd ? String(a.cwd) : sessions.get(by)?.cwd ?? os.homedir()
  if (command && (!path.isAbsolute(cwd) || !fs.existsSync(cwd))) throw new Error(`cwd does not exist: ${cwd}`)
  const timeout = Math.min(Math.max(Number(a.timeout_s) || 3600, 10), 24 * 3600)
  q(`INSERT INTO jobs (name, schedule, command, session, prompt, cwd, timeout_s, created_by, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET schedule = excluded.schedule, command = excluded.command, session = excluded.session,
       prompt = excluded.prompt, cwd = excluded.cwd, timeout_s = excluded.timeout_s, next_run_at = excluded.next_run_at, enabled = 1`)
    .run(name, schedule, command, session, prompt, cwd, timeout, by, new Date(next).toISOString())
  changed(name)
  return view(jobs.get(name)!)
}

export function removeJob(name: string) {
  const j = jobs.get(name)
  if (!j) throw new Error(`no job "${name}"`)
  running.get(j.id)?.kill()
  q('DELETE FROM jobs WHERE id = ?').run(j.id)
  changed(name)
}

export function setEnabled(name: string, enabled: boolean) {
  const j = jobs.get(name)
  if (!j) throw new Error(`no job "${name}"`)
  q('UPDATE jobs SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled ? 1 : 0, new Date(nextRun(j.schedule)).toISOString(), j.id)
  changed(name)
  return view(jobs.get(name)!)
}

// ---------------------------------------------------------------------------------------------
// Running.

/** Runs in progress, by job id, so a job never overlaps itself. */
const running = new Map<number, { kill: () => void }>()

let shellPath: string | null = null
/** PATH as a login shell sets it up, with the claude Neural uses first, plus where node and Homebrew live. */
export function jobPath(): string {
  if (shellPath === null) {
    let p = ''
    const shell = process.env.SHELL || '/bin/zsh'
    try {
      p = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      // fall back to what the hub has
    }
    const claude = findBin(config.claudeBin)
    // The claude Neural runs comes first, so jobs use the same one.
    const dirs = [claude ? path.dirname(claude) : '', ...p.split(':'), ...(process.env.PATH ?? '').split(':'), path.dirname(process.execPath),
      path.join(ROOT, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    shellPath = [...new Set(dirs.filter(Boolean))].join(':')
  }
  return shellPath
}

export async function runJob(name: string, trigger: 'schedule' | 'manual' = 'manual'): Promise<Run> {
  const j = jobs.get(name)
  if (!j) throw new Error(`no job "${name}"`)
  if (running.has(j.id)) throw new Error(`"${name}" is already running`)
  // The next scheduled time counts from now, whatever this run does (a missed run is made up once, not many times).
  q('UPDATE jobs SET next_run_at = ? WHERE id = ?').run(new Date(nextRun(j.schedule)).toISOString(), j.id)
  const runId = Number(q('INSERT INTO job_runs (job_id, trigger) VALUES (?, ?)').run(j.id, trigger).lastInsertRowid)
  changed(name)
  let result: Result
  try {
    result = j.command ? await runCommand(j, runId) : await sendPrompt(j)
  } catch (e) {
    result = { status: 'failed', code: null, output: String((e as Error).message ?? e) }
  }
  return finish(j, runId, result)
}

async function finish(j: Job, runId: number, result: Result): Promise<Run> {
  q(`UPDATE job_runs SET finished_at = ${NOW}, status = ?, exit_code = ?, output = ? WHERE id = ?`).run(result.status, result.code, clean(result.output), runId)
  q('DELETE FROM job_runs WHERE job_id = ? AND id <= ?').run(j.id, runId - KEEP_RUNS)
  await settle(jobs.get(j.name) ?? j, result)
  changed(j.name)
  return q<Run>('SELECT * FROM job_runs WHERE id = ?').get(runId)!
}

// A command's output and exit status go to files, not to the hub, so a run outlives a hub restart (a code
// reload): the next hub process finds it by its process group, waits for it, and reads its result.
const runFiles = (runId: number) => {
  const dir = path.join(config.dataDir, 'jobs')
  return { dir, out: path.join(dir, `${runId}.out`), exit: path.join(dir, `${runId}.exit`) }
}

/** The command's result once its process group is gone: the exit status it wrote, and its output's tail. */
function collect(runId: number, timedOut: boolean): Result {
  const f = runFiles(runId)
  let output = ''
  try {
    const fd = fs.openSync(f.out, 'r')
    const size = fs.fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size, OUTPUT_MAX))
    fs.readSync(fd, buf, 0, buf.length, size - buf.length)
    fs.closeSync(fd)
    output = buf.toString()
  } catch {
    // no output
  }
  let code: number | null = null
  try {
    code = Number(fs.readFileSync(f.exit, 'utf8').trim())
    if (!Number.isInteger(code)) code = null
  } catch {
    // killed before it could write one
  }
  for (const file of [f.out, f.exit]) fs.rmSync(file, { force: true })
  if (timedOut) return { status: 'timeout', code, output }
  if (code === null) return { status: 'failed', code, output: output + '\n(the command was killed before it finished)' }
  return { status: code === 0 ? 'ok' : 'failed', code, output }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a process group to finish, stopping it at the job's timeout. Polls, so it works for a run started
 *  by an earlier hub process too. */
function waitForGroup(j: Job, runId: number, pid: number, startedAt: number): Promise<Result> {
  return new Promise(resolve => {
    let timedOut = false
    const kill = () => {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    running.set(j.id, { kill })
    const tick = setInterval(() => {
      if (!timedOut && Date.now() - startedAt > j.timeout_s * 1000) {
        timedOut = true
        kill()
      }
      if (alive(pid)) return
      clearInterval(tick)
      running.delete(j.id)
      resolve(collect(runId, timedOut))
    }, POLL_MS)
  })
}
const POLL_MS = Number(process.env.NEURAL_JOB_POLL_MS ?? 1000)

async function runCommand(j: Job, runId: number): Promise<Result> {
  const f = runFiles(runId)
  fs.mkdirSync(f.dir, { recursive: true })
  const out = fs.openSync(f.out, 'a')
  // sh runs the command, then writes its exit status; both run in their own process group (detached), which
  // a timeout stops as a whole.
  const child = spawn('/bin/sh', ['-c', '/bin/sh -c "$1"; echo $? > "$2"', 'neural-job', j.command!, f.exit], {
    cwd: j.cwd ?? os.homedir(),
    env: { ...process.env, PATH: jobPath(), NEURAL_JOB: j.name, NEURAL_CLI: path.join(ROOT, 'bin/neural') },
    stdio: ['ignore', out, out],
    detached: true,
  })
  fs.closeSync(out)
  child.unref()
  if (!child.pid) return { status: 'failed', code: null, output: 'could not start /bin/sh' }
  child.on('error', () => {})
  q('UPDATE job_runs SET pid = ? WHERE id = ?').run(child.pid, runId)
  return waitForGroup(j, runId, child.pid, Date.now())
}

async function sendPrompt(j: Job) {
  const s = sessions.get(j.session!)
  if (!s) throw new Error(`session "${j.session}" no longer exists`)
  if (s.status === 'stopped') throw new Error(`session "${j.session}" is stopped`)
  const { sendMessage } = await import('./router.ts')
  const m = sendMessage({ from: `job:${j.name}`, to: s.name, body: j.prompt!, source: 'job' })
  return { status: 'ok', code: 0, output: `sent to ${s.name} as message ${m.id}${s.status === 'exited' ? ' (it is down; the message waits until it is back)' : ''}` }
}

/** Count failures in a row, and say what needs saying: the first failure, a job that keeps failing, a recovery. */
async function settle(j: Job, r: { status: string; code: number | null; output: string }) {
  const { tell } = await import('./health.ts')
  const who = (j.created_by && sessions.get(j.created_by)?.role !== 'orchestrator') ? j.created_by : null
  const say = (body: string) => {
    void tell('', body)
    // The session that set the job up hears too, if it isn't the orchestrator.
    if (who && sessions.get(who)) void import('./router.ts').then(x => x.sendMessage({ from: 'neural', to: who, body, source: 'job' })).catch(() => {})
  }
  if (r.status === 'ok') {
    if (j.failures) say(`**Job ${j.name} works again** after ${j.failures} failed run${j.failures === 1 ? '' : 's'}.`)
    q('UPDATE jobs SET failures = 0 WHERE id = ?').run(j.id)
    return
  }
  const failures = j.failures + 1
  q('UPDATE jobs SET failures = ? WHERE id = ?').run(failures, j.id)
  const how = r.status === 'timeout' ? `timed out after ${j.timeout_s}s` : r.code === null ? 'could not run' : `exited with status ${r.code}`
  const tail = tailOf(clean(r.output), 12).replace(/```/g, "'''")
  const lines = tail ? '\n```\n' + tail + '\n```' : ''
  if (failures === 1) say(`**Job ${j.name} failed**: ${how}.${lines}\n\`list_jobs\` shows it; \`run_job\` runs it again once it's fixed.`)
  else if (failures === ESCALATE_AFTER) {
    say(`**Job ${j.name} keeps failing**: ${failures} runs in a row, last one ${how}.${lines}`)
    void notify({ title: `Job ${j.name} keeps failing`, body: `${failures} failed runs in a row; last one ${how}.`, tag: `job-${j.name}` })
  }
}

/** On a timer: start whatever is due. */
export async function runDue() {
  for (const j of jobs.due()) {
    if (running.has(j.id)) continue
    void runJob(j.name, 'schedule').catch(e => console.error(`job ${j.name}:`, e))
  }
}

/** At startup: runs still going from an earlier hub process are waited for and recorded as usual; ones whose
 *  process is gone without a result (or from before results were kept in files) are marked interrupted. */
export function adoptRunning() {
  for (const r of q<Run & { name: string }>("SELECT r.*, j.name FROM job_runs r JOIN jobs j ON j.id = r.job_id WHERE r.status = 'running'").all()) {
    const j = jobs.get(r.name)!
    const hasResult = fs.existsSync(runFiles(r.id).exit) || fs.existsSync(runFiles(r.id).out)
    if (r.pid && (alive(r.pid) || hasResult)) {
      void waitForGroup(j, r.id, r.pid, Date.parse(r.started_at)).then(result => finish(j, r.id, result))
    } else {
      q(`UPDATE job_runs SET status = 'interrupted', finished_at = ${NOW}, output = ? WHERE id = ?`)
        .run('Neural restarted while this ran, and its result was not recorded.', r.id)
    }
  }
}
