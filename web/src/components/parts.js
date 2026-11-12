// Small building blocks shared by the views.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, STATUS, clock, markdown, tilde } from '../lib.js'
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

const DELIVERY = { pending: 'queued', pushed: 'sent', acked: 'delivered', failed: 'not delivered' }

/** One message in a conversation or timeline. `context` is the session being viewed, if any. */
export function Message({ m, context, continued }) {
  const mine = m.from_name === 'user'
  const relay = m.from_name !== 'user' && m.to_name !== 'user'
  const who = mine ? (context ? 'you' : `you → ${m.to_name}`) : m.from_name
  const foot = []
  if (mine && m.delivery) {
    const via = m.via === 'paste' && m.delivery !== 'pending' ? ' · typed into terminal' : ''
    foot.push(html`<span class=${m.delivery === 'failed' ? 'bad' : m.delivery === 'acked' ? '' : 'accent'}>${DELIVERY[m.delivery]}${via}</span>`)
  }
  if (m.source === 'stop_hook') foot.push(html`<span>from the terminal</span>`)
  if (relay && m.delivery && m.delivery !== 'acked') foot.push(html`<span>${DELIVERY[m.delivery]}</span>`)

  return html`<div class=${`msg ${mine ? 'mine' : ''} ${relay ? 'relay' : ''} ${continued ? 'continued' : ''}`}>
    <div class="gutter">
      <span class="who">${relay ? '' : who}</span>
      <span title=${new Date(m.ts).toLocaleString()}>${clock(m.ts)}</span>
    </div>
    <div class="content">
      ${relay && html`<div class="route">${m.from_name} → ${m.to_name}</div>`}
      <div class="md" dangerouslySetInnerHTML=${{ __html: markdown(m.body) }}></div>
      ${foot.length > 0 && html`<div class="foot">${foot}</div>`}
    </div>
  </div>`
}

/** Textarea that grows with its content, up to the CSS max-height. */
export function useAutosize(value) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return ref
}

const coarse = () => matchMedia('(pointer: coarse)').matches

export function Composer({ placeholder, onSend, hint, autofocus, variant = 'composer' }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useAutosize(text)
  useEffect(() => {
    if (autofocus && !coarse()) ref.current?.focus()
  }, [autofocus])
  const submit = async e => {
    e?.preventDefault()
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await onSend(body)
      setText('')
    } catch (err) {
      alert(err.message)
    } finally {
      setBusy(false)
      if (!coarse()) ref.current?.focus()
    }
  }
  const onKey = e => {
    // Enter sends on a keyboard; on a phone Enter makes a new line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) submit(e)
  }
  return html`<form class=${variant} onSubmit=${submit}>
    ${variant === 'quick' && hint}
    <textarea ref=${ref} rows="1" value=${text} placeholder=${placeholder} aria-label=${placeholder}
      onInput=${e => setText(e.currentTarget.value)} onKeyDown=${onKey}></textarea>
    <button class="btn primary icon-only" disabled=${busy || !text.trim()} aria-label="Send"><${Icon} name="send" /></button>
  </form>`
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
