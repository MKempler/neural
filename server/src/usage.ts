// The usage and context meter. Claude Code runs each session's status line with a JSON description of the
// session (channel/statusline.sh posts it here): how full the context window is, what the session has cost,
// and, for claude.ai subscriptions, how much of the 5-hour and weekly usage limits is used. The latest
// readings are kept and sent to the app; the answer is the line shown at the bottom of the terminal.
import { sessions, usage as store } from './db.ts'
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
    store.set(name, ctx)
    broadcast({ type: 'usage', session: name, context: ctx })
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
