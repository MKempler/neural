// Small building blocks shared by the views.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, STATUS, tilde } from '../lib.js'
import { Icon } from '../icons.js'
import { decide, navigate, sessionPath } from '../store.js'

export function Dot({ status }) {
  return html`<span class=${`dot ${status}`} aria-hidden="true"></span>`
}

export function StatusPill({ status, background }) {
  const label = STATUS[status] ?? status
  return html`<span class=${`pill ${status}`}><${Dot} status=${status} />${status === 'idle' && background ? `${label} · ${background} running` : label}</span>`
}

/** Why a session is down and what Neural is doing about it (the hub keeps it as JSON on the session). */
export function downOf(s) {
  try {
    return s?.down ? JSON.parse(s.down) : null
  } catch {
    return null
  }
}

const cap = t => (t ? t[0].toUpperCase() + t.slice(1) : '')
/** Text with `code` spans. */
const withCode = t => String(t).split(/`([^`]+)`/).map((part, i) => (i % 2 ? html`<code>${part}</code>` : part))

export function DownInfo({ s }) {
  const d = downOf(s)
  const [, tick] = useState(0)
  const due = d?.retry_at ? Date.parse(d.retry_at) : null
  // Count down to the next attempt.
  useEffect(() => {
    if (!due || s.status !== 'exited') return
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [due, s.status])
  if (!d) return null
  const attempt = d.attempt ? ` (attempt ${d.attempt} of ${d.max})` : ''
  const wait = due ? Math.ceil((due - Date.now()) / 1000) : 0
  const next = s.status === 'starting' ? `Restarting now${attempt}.`
    : d.kind === 'install' ? 'Neural is not retrying: it restarts the session by itself once Claude Code runs again.'
      : d.kind === 'gave-up' ? 'Neural stopped retrying. Start it again once the cause is fixed.'
        : due ? `${wait > 1 ? `Restarting in ${wait}s` : 'Restarting'}${attempt}.`
          : 'Neural is not restarting it by itself (autostart is off).'
  return html`<div class="down-info">
    <p class="down-reason">${withCode(cap(d.reason))}</p>
    ${d.hint && html`<p class="down-hint">${withCode(d.hint)}</p>`}
    <p class="down-next">${next}</p>
  </div>`
}

/** Link that navigates inside the app without a page load. */
export function Link({ href, class: cls, children, ...rest }) {
  const go = e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(href)
  }
  return html`<a href=${href} class=${cls} onClick=${go} ...${rest}>${children}</a>`
}

export function PermissionCard({ p, showSession = true }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const answer = behavior => async e => {
    e.stopPropagation()
    setBusy(true)
    try {
      await decide(p.id, behavior)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return html`<div class="alert">
    <${Dot} status="blocked" />
    <div class="truncate">
      ${showSession && html`<${Link} href=${sessionPath(p.session)} class="who">${p.session}</${Link}> `}
      <span class="what">wants to use <span class="mono">${p.tool_name}</span>${p.description ? ` · ${p.description}` : ''}</span>
    </div>
    <div class="actions">
      <button class="btn sm" disabled=${busy} onClick=${answer('deny')}>Deny</button>
      <button class="btn sm primary" disabled=${busy} onClick=${answer('allow')}>Allow</button>
    </div>
    ${p.input_preview && html`<pre class="detail">${p.input_preview}</pre>`}
    ${error && html`<div class="error" style="grid-column: 2 / -1">${error}</div>`}
  </div>`
}

/** Button that opens a small menu of actions. */
export function Menu({ label = 'More', items }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = e => !ref.current?.contains(e.target) && setOpen(false)
    const esc = e => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  return html`<div class="menu" ref=${ref}>
    <button class="btn ghost icon-only" aria-label=${label} aria-expanded=${open} onClick=${() => setOpen(!open)}><${Icon} name="more" /></button>
    ${open && html`<div class="menu-list" role="menu">
      ${items.filter(Boolean).map(it => (it === '-' ? html`<hr />` : html`<button role="menuitem" class=${it.danger ? 'danger' : ''}
        onClick=${() => { setOpen(false); it.run() }}><${Icon} name=${it.icon} />${it.label}</button>`))}
    </div>`}
  </div>`
}

export const Cwd = ({ path }) => html`<span class="mono" title=${path}>${tilde(path)}</span>`

// Moved to their own modules; re-exported so older imports keep working.
export { Composer, DropZone, useAutosize } from './Composer.js'
export { Message, Attachments } from './Message.js'
