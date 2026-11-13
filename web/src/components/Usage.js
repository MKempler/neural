// The usage and context meter: how much of the account's 5-hour and weekly limits is used, and how full each
// session's context window is. Both come from Claude Code's status line, so they appear after a session's
// first reply, and the limits only for claude.ai subscriptions.
import { html, clock } from '../lib.js'
import { usage } from '../store.js'

/** A window as it stands now: one past its reset time has started over. */
function current(w, now = Date.now()) {
  if (!w) return null
  return w.resets_at * 1000 > now ? { ...w, reset: false } : { ...w, used: 0, reset: true }
}

/** "20:20" today, "Mon 14:00" later in the week. */
function when(unix) {
  const d = new Date(unix * 1000)
  const time = clock(d.toISOString())
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

const level = used => (used >= 90 ? 'bad' : used >= 75 ? 'warn' : '')

/** Home: one bar per limit. */
export function UsageMeter() {
  const five = current(usage.value?.five_hour)
  const week = current(usage.value?.seven_day)
  if (!five && !week) return null
  return html`<div class="usage">
    ${five && html`<${Meter} label="5-hour" w=${five} />`}
    ${week && html`<${Meter} label="Week" w=${week} />`}
  </div>`
}

function Meter({ label, w }) {
  return html`<div class=${`meter ${level(w.used)}`}>
    <div class="meter-top">
      <span class="name">${label}</span>
      <span class="pct">${w.used}% used</span>
      <span class="when">${w.reset ? `reset at ${when(w.resets_at)}` : `resets ${when(w.resets_at)}`}</span>
    </div>
    <div class="bar" role="progressbar" aria-label=${`${label} limit`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${w.used}>
      <span style=${`width: ${w.used}%`}></span>
    </div>
  </div>`
}

/** Shown above a session's composer when a limit is nearly used up. */
export function LimitWarning() {
  const five = current(usage.value?.five_hour)
  const week = current(usage.value?.seven_day)
  const near = [[week, 'weekly'], [five, '5-hour']].find(([w]) => w && w.used >= 90)
  if (!near) return null
  const [w, name] = near
  return html`<div class=${`limit-warn ${w.used >= 98 ? 'bad' : ''}`} role="status">
    ${w.used >= 100 ? `Your ${name} limit is used up` : `About ${100 - w.used}% of your ${name} limit left`} · resets ${when(w.resets_at)}
  </div>`
}

const tokens = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

/** "context 41%", amber from 80% (Claude Code compacts the conversation when it fills up). */
export function ContextChip({ s, short = false }) {
  const c = s.context
  if (c?.used == null) return null
  const title = [
    `${c.used}% of the ${c.size ? `${tokens(c.size)}-token ` : ''}context window used.`,
    c.used >= 80 ? 'Claude Code will compact the conversation soon.' : '',
    c.cost ? `Cost so far: $${c.cost.toFixed(2)}.` : '',
  ].filter(Boolean).join(' ')
  return html`<span class=${`ctx ${c.used >= 80 ? 'warn' : ''}`} title=${title}>${short ? 'ctx' : 'context'} ${c.used}%</span>`
}
