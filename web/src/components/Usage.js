// The usage and context meter: how much of the account's 5-hour and weekly limits is used, and how full each
// session's context window is. Both come from Claude Code's status line, so they appear after a session's
// first reply, and the limits only for claude.ai subscriptions.
import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { html, when as at, api } from '../lib.js'
import { usage, navigate } from '../store.js'
import { Icon } from '../icons.js'

/** A window as it stands now: one past its reset time has started over. */
function current(w, now = Date.now()) {
  if (!w) return null
  return w.resets_at * 1000 > now ? { ...w, reset: false } : { ...w, used: 0, reset: true }
}

/** "1:50 pm" today, "Thu 9:00 am" later in the week. */
const when = unix => at(unix * 1000)

const level = used => (used >= 90 ? 'bad' : used >= 75 ? 'warn' : '')

/** Home: one bar per limit. */
export function UsageMeter() {
  const five = current(usage.value?.five_hour)
  const week = current(usage.value?.seven_day)
  // Who used how much of each window, fetched again whenever the limits move.
  const [shares, setShares] = useState(null)
  useEffect(() => {
    api('GET', '/api/usage').then(r => setShares(r.shares), () => {})
  }, [usage.value?.five_hour?.used, usage.value?.seven_day?.used])
  const open = usageOpen.value
  const setOpen = v => (usageOpen.value = v)
  if (!five && !week) return null
  // On a phone the meters fold into one line that opens them; it turns amber and moves to the top past 80%.
  const hot = Math.max(five?.used ?? 0, week?.used ?? 0) >= 80
  const line = [five && `5h ${five.used}%`, week && `week ${week.used}%`, five && `resets ${when(five.resets_at)}`].filter(Boolean).join(' · ')
  return html`<div class=${`usage-wrap ${hot ? 'hot' : ''} ${open ? 'open' : ''}`}>
    <button class="usage-line" aria-expanded=${open} onClick=${() => setOpen(!open)}><span>${line}</span><${Icon} name="down" size=${14} /></button>
    <div class="usage">
      ${five && html`<${Meter} label="5-hour" w=${five} by=${!five.reset && shares?.five_hour} />`}
      ${week && html`<${Meter} label="Week" w=${week} by=${!week.reset && shares?.seven_day} />`}
    </div>
  </div>`
}

/** Whether the phone's folded usage meters on Home are open. */
const usageOpen = signal(false)

/** Phone top bar: "5h 12% · wk 41%", always in view; tapping opens the meters on Home. */
export function UsageChip() {
  const five = current(usage.value?.five_hour)
  const week = current(usage.value?.seven_day)
  if (!five && !week) return null
  const used = Math.max(five?.used ?? 0, week?.used ?? 0)
  const show = () => {
    usageOpen.value = true
    navigate('/')
    setTimeout(() => document.querySelector('.usage-wrap')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50)
  }
  return html`<button class=${`usage-chip ${level(used)}`} aria-label="Usage limits" onClick=${show}>
    ${[five && `5h ${five.used}%`, week && `wk ${week.used}%`].filter(Boolean).join(' · ')}</button>`
}

function Meter({ label, w, by }) {
  return html`<div class=${`meter ${level(w.used)}`}>
    <div class="meter-top">
      <span class="name">${label}</span>
      <span class="pct">${w.used}% used</span>
      <span class="when">${w.reset ? `reset at ${when(w.resets_at)}` : `resets ${when(w.resets_at)}`}</span>
    </div>
    <div class="bar" role="progressbar" aria-label=${`${label} limit`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${w.used}>
      <span style=${`width: ${w.used}%`}></span>
    </div>
    ${by?.length > 1 && html`<div class="meter-by" title="Share of this window's use, estimated from each session's cost">
      est. ${by.filter(x => x.share > 0).slice(0, 5).map(x => `${x.name} ${x.share}%`).join(' · ')}</div>`}
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
