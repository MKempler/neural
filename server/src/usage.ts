// The usage and context meter. Claude Code runs each session's status line with a JSON description of the
// session (channel/statusline.sh posts it here): how full the context window is, what the session has cost,
// and, for claude.ai subscriptions, how much of the 5-hour and weekly usage limits is used. The latest
// readings are kept and sent to the app; the answer is the line shown at the bottom of the terminal.
import { config } from './config.ts'
import { sessions, usage as store, usageLog, prefs, providerUsage } from './db.ts'
import * as providers from './providers.ts'
import { broadcast } from './live.ts'
import { when } from './clock.ts'

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

/** Readings of one window whose reset times are this close are the same window (they can differ by seconds). */
const SAME_WINDOW = 15 * 60

/** The account's figure after a new reading. Every session reports the limits from its own last API response,
 *  so a session that has been idle reports an older, lower figure; taken as is, the meter jumped back and forth
 *  between sessions. Within a window use only grows, so keep the highest; a reading of an earlier window is
 *  stale and ignored; a later reset time means the window really did reset. */
export function merge(prev: Window | null | undefined, next: Window | null): Window | null {
  if (!next) return prev ?? null
  if (!prev || next.resets_at > prev.resets_at + SAME_WINDOW) return next
  if (next.resets_at < prev.resets_at - SAME_WINDOW) return prev
  return next.used > prev.used ? { used: next.used, resets_at: prev.resets_at } : prev
}

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
    // On another provider the figure is Claude Code's guess at Claude prices, and none of it is Claude plan use:
    // its real cost is metered from the transcript (meter below).
    if (ctx.cost != null && !providers.of(sessions.get(name)?.provider)) {
      const spent = before?.cost != null && ctx.cost >= before.cost ? ctx.cost - before.cost : ctx.cost
      if (spent > 0) logSpend(name, spent)
    }
    store.set(name, ctx)
    broadcast({ type: 'usage', session: name, context: ctx })
    void import('./handoff.ts').then(h => h.onContext(name, ctx.used, ctx.size))
  }

  // Each window can be missing (API-key sessions have neither, and they appear only after the first reply).
  let acc = account()
  const five = window(payload?.rate_limits?.five_hour)
  const week = window(payload?.rate_limits?.seven_day)
  if (five || week) {
    const next: Account = { five_hour: merge(acc?.five_hour, five), seven_day: merge(acc?.seven_day, week), at }
    if (!acc || !sameWindow(acc.five_hour, next.five_hour) || !sameWindow(acc.seven_day, next.seven_day)) {
      store.set(ACCOUNT, next)
      sample(next)
      broadcast({ type: 'usage', account: next })
      checkQuota(next)
    }
    acc = next
  }
  return line(ctx, acc)
}

// ---------------------------------------------------------------------------------------------
// The outlook for list_sessions: each window's use, reset time and pace, so the orchestrator can plan without
// reading a footer. The pace comes from the account's readings over the last few hours.

export interface Sample { t: number; five: Window | null; week: Window | null }
const SAMPLES = 'usageSamples'
const KEEP = 8 * 86400_000
const PACE_SPAN = 6 * 3600_000 // the slope is taken over this much recent history
const PACE_MIN = 20 * 60_000 // and needs at least this much of it

function sample(acc: Account, now = Date.now()) {
  const list = (prefs.get<Sample[]>(SAMPLES) ?? []).filter(x => x.t > now - KEEP)
  list.push({ t: now, five: acc.five_hour, week: acc.seven_day })
  prefs.set(SAMPLES, list)
}

export interface Outlook { used: number; resets: string; pace: string | null }

/** One window's outlook: `pace` is when it would reach 100% at the recent rate, or null when not before it resets. */
export function windowOutlook(key: 'five' | 'week', w: Window | null | undefined, samples: Sample[], now = Date.now()): Outlook | null {
  if (!w || w.resets_at * 1000 <= now) return null
  // The oldest reading of this same window within the span.
  const first = samples.find(x => x.t >= now - PACE_SPAN && x[key] && Math.abs(x[key]!.resets_at - w.resets_at) <= SAME_WINDOW)
  let pace: string | null = null
  if (first && now - first.t >= PACE_MIN && w.used > first[key]!.used && w.used < 100) {
    const full = now + (100 - w.used) * (now - first.t) / (w.used - first[key]!.used)
    if (full < w.resets_at * 1000) pace = when(full)
  }
  return { used: w.used, resets: when(w.resets_at * 1000), pace }
}

export function outlook(acc = account(), samples = prefs.get<Sample[]>(SAMPLES) ?? [], now = Date.now()) {
  return { five_hour: windowOutlook('five', acc?.five_hour, samples, now), weekly: windowOutlook('week', acc?.seven_day, samples, now) }
}

/** "context 41% · 5-hour 62% (resets 8:20 pm) · week 41%" */
export function line(ctx: Context | null, acc: Account | null, now = Date.now()): string {
  const live = (w: Window | null | undefined) => (w && w.resets_at * 1000 > now ? w : null)
  const five = live(acc?.five_hour)
  const week = live(acc?.seven_day)
  return [
    ctx?.used != null ? `context ${ctx.used}%` : null,
    five ? `5-hour ${five.used}% (resets ${when(five.resets_at * 1000)})` : null,
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

// ---------------------------------------------------------------------------------------------
// Usage outside Neural's sessions: headless runs (`claude -p`, often from scheduled jobs) and other Claude Code
// sessions on the machine use the same plan but have no status line reporting to Neural. Their transcripts
// are archived, though, and each reply records its tokens, so their cost is estimated from those and logged
// under the job that was running in that folder ("job:<name>"), else "other:<folder>".

/** $ per million input tokens; output costs 5x, writing the cache 1.25x and reading it 0.1x. */
const PRICE: [RegExp, number][] = [[/opus/i, 5], [/sonnet/i, 3], [/haiku/i, 1]]
const seenReplies = new Set<string>()

export function costOf(model: string, u: any): number {
  const per = PRICE.find(([re]) => re.test(model))?.[1] ?? 3
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const units = n(u?.input_tokens) + 5 * n(u?.output_tokens) + 1.25 * n(u?.cache_creation_input_tokens) + 0.1 * n(u?.cache_read_input_tokens)
  return (units * per) / 1e6
}

// ---------------------------------------------------------------------------------------------
// Spend on other providers, from each transcript reply's token counts at the provider's list prices. Kept apart
// from the Claude windows. Replies from outside Neural's sessions count too, under job:<name> or other:<folder>.

const metered = new Set<string>()

/** Meter a transcript reply if it came from another provider's model; true if it did (it isn't Claude use). */
export function meter(entry: any, owner: string | null, jobFor: (cwd: string, at: string) => string | null): boolean {
  const msg = entry?.message
  const p = providers.forModel(msg?.model)
  if (!p) return false
  if (!msg.usage || !msg.id || metered.has(msg.id)) return true
  // A reply is written as several lines (one per content block), each repeating its usage: count it once.
  metered.add(msg.id)
  if (metered.size > 20_000) metered.clear()
  const at = String(entry.timestamp ?? new Date().toISOString())
  const cwd = String(entry.cwd ?? '')
  const job = owner ? null : cwd ? jobFor(cwd, at) : null
  const session = owner ?? (job ? `job:${job}` : `other:${cwd ? cwd.split('/').filter(Boolean).pop() : 'unknown'}`)
  const c = providers.costOf(p, String(msg.model), msg.usage)
  providerUsage.add({ session, provider: p.name, model: String(msg.model).slice(p.modelPrefix.length), day: at.slice(0, 10), ...c })
  return true
}

const DAY = 86400_000
const day = (t: number) => new Date(t).toISOString().slice(0, 10)
const usd = (n: number) => Math.round(n * 1000) / 1000

/** Spend per provider (today, last 7 days, last 30 days, UTC days) and per session (last 30 days), for list_sessions. */
export function providerSpend(now = Date.now()) {
  const month = providerUsage.since(day(now - 29 * DAY))
  if (!month.length) return null
  const week = providerUsage.since(day(now - 6 * DAY))
  const today = providerUsage.since(day(now))
  const sum = (rows: typeof month, p: string) => usd(rows.filter(r => r.provider === p).reduce((t, r) => t + r.cost, 0))
  const totals: Record<string, { today_usd: number; week_usd: number; month_usd: number }> = {}
  for (const p of new Set(month.map(r => r.provider))) totals[p] = { today_usd: sum(today, p), week_usd: sum(week, p), month_usd: sum(month, p) }
  const bySession = new Map(month.map(r => [r.session, { provider: r.provider, usd_30d: usd(r.cost), tokens: { input: r.input, cached: r.cached, output: r.output } }]))
  return { totals, bySession, note: 'List-price estimates from transcript token counts; the provider\'s billing page has the real figure.' }
}

/** A transcript reply from outside Neural's sessions: log its estimated cost against the job (or folder). */
export function logOutside(entry: any, jobFor: (cwd: string, at: string) => string | null) {
  const msg = entry?.message
  if (!msg?.usage || !msg.id || msg.model === '<synthetic>') return
  // A reply is written as several lines (one per content block), each repeating its usage: count it once.
  if (seenReplies.has(msg.id)) return
  seenReplies.add(msg.id)
  if (seenReplies.size > 20_000) seenReplies.clear()
  const cost = costOf(String(msg.model ?? ''), msg.usage)
  if (cost <= 0) return
  const cwd = String(entry.cwd ?? '')
  const job = cwd ? jobFor(cwd, String(entry.timestamp ?? new Date().toISOString())) : null
  logSpend(job ? `job:${job}` : `other:${cwd ? cwd.split('/').filter(Boolean).pop() : 'unknown'}`, cost)
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

// ---------------------------------------------------------------------------------------------
// The reset notice: once a window that reached an alert level resets, the orchestrators hear it, so paused work
// can start again without anyone watching the clock. Checked on the reconcile timer.

type Told = Record<string, { resets_at: number; level: number; announced?: boolean }>
const STALE_RESET = 6 * 3600 // a reset found long after the fact (the hub was down) isn't news

export function checkReset(now = Date.now()) {
  const told = prefs.get<Told>('quotaTold') ?? {}
  const reset = (Object.keys(SPAN) as (keyof typeof SPAN)[]).filter(k => told[k] && !told[k].announced && told[k].resets_at * 1000 <= now)
  if (!reset.length) return
  for (const k of reset) told[k].announced = true
  prefs.set('quotaTold', told)
  const fresh = reset.filter(k => now / 1000 - told[k].resets_at < STALE_RESET)
  if (!fresh.length) return
  // Freed around this reset (a limit's own reset time can differ from the account's by minutes), or still limited.
  const since = Math.min(...fresh.map(k => told[k].resets_at)) * 1000 - 3600_000
  const limited = sessions.all().filter(s => s.status === 'limited' || (freed.get(s.name) ?? 0) >= since).map(s => s.name)
  freed.clear()
  const title = fresh.map(k => LABEL[k]).join(' and ')
  const lines = [`**${title[0].toUpperCase()}${title.slice(1)} window reset.** Paused work can go ahead again.`]
  lines.push(limited.length
    ? `Stopped by the limit: ${limited.join(', ')}.${config.autoContinue && fresh.includes('five_hour') ? ' Neural tells them to carry on, one at a time.' : ''}`
    : 'No session was stopped by the limit.')
  void import('./health.ts').then(h => h.tell('', lines.join('\n')))
}

/** Sessions freed by a limit's reset since the last notice (the reset times in their messages can lead the account's). */
const freed = new Map<string, number>()
export const limitFreed = (name: string, at: number) => { freed.set(name, at) }

function quotaNotice(key: keyof typeof SPAN, w: Window, level: number) {
  const low = sessions.all().filter(s => s.priority === 'low' && s.status !== 'stopped').map(s => s.name)
  const resets = when(w.resets_at * 1000)
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
