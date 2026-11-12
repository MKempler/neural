// Small building blocks shared by the views.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, STATUS, tilde } from '../lib.js'
import { Icon } from '../icons.js'
import { decide, navigate, sessionPath } from '../store.js'

export function Dot({ status }) {
  return html`<span class=${`dot ${status}`} aria-hidden="true"></span>`
}

export function StatusPill({ status }) {
  return html`<span class=${`pill ${status}`}><${Dot} status=${status} />${STATUS[status] ?? status}</span>`
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
