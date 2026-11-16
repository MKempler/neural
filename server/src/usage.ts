// The usage and context meter. Claude Code runs each session's status line with a JSON description of the
// session (channel/statusline.sh posts it here): how full the context window is, what the session has cost,
// and, for claude.ai subscriptions, how much of the 5-hour and weekly usage limits is used. The latest
// readings are kept and sent to the app; the answer is the line shown at the bottom of the terminal.
import { config } from './config.ts'
import { sessions, usage as store, usageLog, prefs } from './db.ts'
import { broadcast } from './live.ts'

/** A usage-limit window: percent used, and when it resets (Unix seconds). */
export interface Window { used: number; resets_at: number }
export interface Account { five_hour: Window | null; seven_day: Window | null; at: string }
/** One session's context window (percent used, size in tokens) and cost so far in US dollars. */
export interface Context { used: number | null; size: number | null; cost: number | null; at: string }

const ACCOUNT = '' // the row holding the account's limits; session names are never empty

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const pct = (v: unknown) => {
  const n = num(v)
  return n === null ? null : Math.max(0, Math.min(100, Math.round(n)))
}
function window(w: any): Window | null {
  const used = pct(w?.used_percentage)
  const resets = num(w?.resets_at)
  return used === null || !resets ? null : { used, resets_at: resets }
}
const sameWindow = (a: Window | null | undefined, b: Window | null) => (a?.used ?? null) === (b?.used ?? null) && (a?.resets_at ?? null) === (b?.resets_at ?? null)

export const account = () => store.get<Account>(ACCOUNT)
export const context = (name: string) => store.get<Context>(name)
export const forget = (name: string) => store.remove(name)

/** Take a status line reading from a session; returns the text for its terminal's status line. */
export function record(name: string, payload: any): string {
  if (!name || !sessions.get(name)) return ''
  const at = new Date().toISOString()

  const cw = payload?.context_window
  const ctx: Context = { used: pct(cw?.used_percentage), size: num(cw?.context_window_size), cost: num(payload?.cost?.total_cost_usd), at }
  const before = context(name)
  // The status line runs after every update; only a visible change (a percent, a cent) is stored and sent.
  const cents = (c: number | null | undefined) => (c == null ? null : Math.round(c * 100))
  if (!before || before.used !== ctx.used || before.size !== ctx.size || cents(before.cost) !== cents(ctx.cost)) {
    // What it spent since the last reading. A new process (a restart) counts from zero again.
    if (ctx.cost != null) {
      const spent = before?.cost != null && ctx.cost >= before.cost ? ctx.cost - before.cost : ctx.cost
      if (spent > 0) logSpend(name, spent)
    }
    store.set(name, ctx)
    broadcast({ type: 'usage', session: name, context: ctx })
    void import('./handoff.ts').then(h => h.onContext(name, ctx.used))
  }

  // Each window can be missing (API-key sessions have neither, and they appear only after the first reply).
  let acc = account()
  const five = window(payload?.rate_limits?.five_hour)
  const week = window(payload?.rate_limits?.seven_day)
  if (five || week) {
    const next: Account = { five_hour: five ?? acc?.five_hour ?? null, seven_day: week ?? acc?.seven_day ?? null, at }
    if (!acc || !sameWindow(acc.five_hour, next.five_hour) || !sameWindow(acc.seven_day, next.seven_day)) {
      store.set(ACCOUNT, next)
      broadcast({ type: 'usage', account: next })
      checkQuota(next)
    }
    acc = next
  }
  return line(ctx, acc)
}

const hhmm = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** "context 41% · 5-hour 62% (resets 20:20) · week 41%" */
export function line(ctx: Context | null, acc: Account | null, now = Date.now()): string {
  const live = (w: Window | null | undefined) => (w && w.resets_at * 1000 > now ? w : null)
  const five = live(acc?.five_hour)
  const week = live(acc?.seven_day)
  return [
    ctx?.used != null ? `context ${ctx.used}%` : null,
    five ? `5-hour ${five.used}% (resets ${hhmm(five.resets_at)})` : null,
    week ? `week ${week.used}%` : null,
  ].filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------------------------
// The quota guard. Every session uses the same plan, so the orchestrator is told when a limit gets close, with
// which sessions used it; sessions marked low priority are the ones to pause, and near the limit Neural holds
// messages from other sessions to them until it resets (the user's own messages always go through).

const SPAN = { five_hour: 5 * 3600, seven_day: 7 * 86400 } as const
const LABEL = { five_hour: '5-hour', seven_day: 'weekly' } as const
const LEVELS = [80, 95]
export const HOLD_AT = 95

let pruned = 0
function logSpend(name: string, cost: number) {
  usageLog.add(name, cost)
  if (Date.now() - pruned > 3600_000) {
    pruned = Date.now()
    usageLog.prune(new Date(Date.now() - 8 * 86400_000).toISOString())
  }
}

const live = (w: Window | null | undefined, now = Date.now()) => (w && w.resets_at * 1000 > now ? w : null)

export interface Share { name: string; cost: number; share: number }

/** Who used how much of each current window, estimated from each session's cost (shares in percent). */
export function shares(acc = account(), now = Date.now()) {
  const out: Partial<Record<keyof typeof SPAN, Share[]>> = {}
  for (const key of Object.keys(SPAN) as (keyof typeof SPAN)[]) {
    const w = live(acc?.[key], now)
    if (!w) continue
    const rows = usageLog.since(new Date((w.resets_at - SPAN[key]) * 1000).toISOString())
    const total = rows.reduce((t, r) => t + r.cost, 0)
    out[key] = total > 0 ? rows.map(r => ({ name: r.session, cost: Math.round(r.cost * 100) / 100, share: Math.round((100 * r.cost) / total) })) : []
  }
  return out
}

/** One session's share of each current window, for list_sessions. */
export function shareOf(name: string, all = shares()) {
  const pick = (list?: Share[]) => list?.find(s => s.name === name)?.share ?? (list ? 0 : null)
  return { five_hour: pick(all.five_hour), week: pick(all.seven_day) }
}

/** Is a limit at or past the hold level right now? */
export function nearLimit(acc = account()) {
  return (Object.keys(SPAN) as (keyof typeof SPAN)[]).some(k => (live(acc?.[k])?.used ?? 0) >= HOLD_AT)
}

/** Messages from other sessions to this one wait until the limit resets. */
export function held(name: string) {
  return config.quotaHold && sessions.get(name)?.priority === 'low' && nearLimit()
}

const names = (list: Share[] | undefined) => (list?.length ? list.slice(0, 6).map(s => `${s.name} ${s.share}%`).join(', ') : 'no readings yet')

function checkQuota(acc: Account) {
  const told = prefs.get<Record<string, { resets_at: number; level: number }>>('quotaTold') ?? {}
  for (const key of Object.keys(SPAN) as (keyof typeof SPAN)[]) {
    const w = live(acc[key])
    if (!w) continue
    const level = LEVELS.filter(l => w.used >= l).pop()
    if (!level) continue
    const prev = told[key]
    // Once per level per window (the reset time can move by a few seconds between readings).
    if (prev && Math.abs(prev.resets_at - w.resets_at) < 3600 && prev.level >= level) continue
    told[key] = { resets_at: w.resets_at, level }
    prefs.set('quotaTold', told)
    void import('./health.ts').then(h => h.tell('', quotaNotice(key, w, level)))
  }
}

function quotaNotice(key: keyof typeof SPAN, w: Window, level: number) {
  const low = sessions.all().filter(s => s.priority === 'low' && s.status !== 'stopped').map(s => s.name)
  const resets = new Date(w.resets_at * 1000).toLocaleString([], { weekday: key === 'seven_day' ? 'short' : undefined, hour: '2-digit', minute: '2-digit', hour12: false })
  const lines = [
    `**${LABEL[key]} usage is at ${w.used}%** (resets ${resets}).`,
    `Used so far in this window, estimated from each session's cost: ${names(shares()[key])}.`,
  ]
  if (level >= HOLD_AT) {
    lines.push(low.length && config.quotaHold
      ? `Low priority: ${low.join(', ')}. Neural now holds messages from other sessions to them until the limit resets; the user's messages still go through.`
      : 'No session is marked low priority. Pause or stop work that can wait (`set_priority` marks a session low).')
  } else {
    lines.push(low.length ? `Low priority: ${low.join(', ')}; pause those first if it gets tight.` : 'Consider which work can wait; `set_priority` marks a session low, so Neural holds it near the limit.')
  }
  return lines.join('\n')
}
