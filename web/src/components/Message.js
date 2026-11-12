// One message in a conversation or the timeline, its attachments, and the live "working" line.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, clock, markdown, fmtBytes, fmtDuration } from '../lib.js'
import { Icon } from '../icons.js'
import { lightbox, retrySend, discardSend } from '../store.js'

const DELIVERY = { sending: 'sending', queued: 'waiting for connection', pending: 'queued', pushed: 'sent', acked: 'delivered', failed: 'not delivered' }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older iOS: copy through a temporary selection.
    const ta = Object.assign(document.createElement('textarea'), { value: text, readOnly: true })
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

/**
 * Tap a message (or hover on desktop) to see its time and actions: copy, quote into the composer, retry if
 * it wasn't sent. `onQuote` receives the quoted Markdown. Pending (not yet sent) messages carry a `key`.
 */
export function Message({ m, context, continued, onQuote }) {
  const [open, setOpen] = useState(false)
  const self = useRef(null)
  const [copied, setCopied] = useState(false)
  const mine = m.from_name === 'user'
  const relay = m.from_name !== 'user' && m.to_name !== 'user'
  const pending = Boolean(m.key)
  const who = mine ? (context ? 'you' : `you → ${m.to_name}`) : m.from_name

  const status = []
  if ((mine || relay) && m.delivery && !(relay && m.delivery === 'acked')) {
    const via = m.via === 'paste' && m.delivery !== 'pending' ? ' · typed into terminal' : ''
    status.push(html`<span class=${m.delivery === 'failed' ? 'bad' : ['acked', 'pushed'].includes(m.delivery) ? '' : 'accent'}>${DELIVERY[m.delivery] ?? m.delivery}${via}</span>`)
  }
  if (m.source === 'stop_hook') status.push(html`<span>from the terminal</span>`)

  const toggle = e => {
    // Links, buttons, media and code keep their own taps.
    if (e.target.closest('a, button, video, img, pre, .thumb, .file-chip, .actions')) return
    if (window.getSelection()?.toString()) return
    setOpen(!open)
    // Make sure the actions that just appeared aren't hidden under the composer.
    if (!open) requestAnimationFrame(() => self.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }
  const copy = async () => {
    if (await copyText(m.body)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }
  const quote = () => {
    const lines = m.body.trim().split('\n').slice(0, 12).map(l => `> ${l}`).join('\n')
    onQuote?.(lines + '\n\n')
    setOpen(false)
  }

  if (m.source === 'command') {
    return html`<div class="msg mine command" ref=${self}>
      <div class="gutter"><span class="who">you</span><span title=${new Date(m.ts).toLocaleString()}>${clock(m.ts)}</span></div>
      <div class="content"><div class="cmd-line"><${Icon} name="terminal" size=${14} /><code>${m.body}</code><span>ran in the terminal</span></div></div>
    </div>`
  }

  return html`<div class=${`msg ${mine ? 'mine' : ''} ${relay ? 'relay' : ''} ${continued ? 'continued' : ''} ${open ? 'open' : ''} ${pending ? 'pending' : ''}`}
      onClick=${toggle} ref=${self}>
    <div class="gutter">
      <span class="who">${relay ? '' : who}</span>
      <span title=${new Date(m.ts).toLocaleString()}>${clock(m.ts)}</span>
    </div>
    <div class="content">
      ${relay && html`<div class="route">${m.from_name} → ${m.to_name}</div>`}
      ${m.body && html`<div class="md" dangerouslySetInnerHTML=${{ __html: markdown(m.body) }}></div>`}
      <${Attachments} list=${m.attachments} />
      ${m.delivery === 'failed' && pending && html`<div class="failed-row">
        <span>${m.error || 'Not sent.'}</span>
        <button class="btn sm" onClick=${() => retrySend(m.key)}>Retry</button>
        <button class="btn sm ghost" onClick=${() => discardSend(m.key)}>Discard</button>
      </div>`}
      <div class="foot">
        <span class="when">${clock(m.ts)}</span>
        ${status}
        <span class="actions">
          ${m.body && html`<button class="act" onClick=${copy} aria-label="Copy message"><${Icon} name=${copied ? 'check' : 'copy'} size=${14} />${copied ? 'Copied' : 'Copy'}</button>`}
          ${m.body && onQuote && html`<button class="act" onClick=${quote} aria-label="Quote in reply"><${Icon} name="quote" size=${14} />Quote</button>`}
        </span>
      </div>
    </div>
  </div>`
}

const elapsed = ms => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "main · Editing auth.ts · 0:42" while a session works; replaced by a waiting note when it needs approval. */
export function ActivityLine({ s }) {
  const [, tick] = useState(0)
  const active = s.status === 'working' || s.status === 'blocked'
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
  if (!active) return null
  const since = s.activity?.since ?? Date.parse(s.updated_at)
  const text = s.status === 'blocked' ? 'Waiting for your approval' : s.activity?.text ?? 'Working'
  return html`<div class=${`activity-line ${s.status}`} role="status" aria-live="polite">
    <span class="pulse"></span>
    <span class="who">${s.name}</span>
    <span class="what">${text}</span>
    <span class="time">${elapsed(Date.now() - since)}</span>
  </div>`
}

// ---------------------------------------------------------------------------------------------
// Attachments in a message

export function Attachments({ list }) {
  if (!list?.length) return null
  const images = list.filter(a => a.kind === 'image')
  const open = i => (lightbox.value = { items: images, index: i })
  return html`<div class="attachments">
    ${images.length > 0 && html`<div class=${`thumbs n${Math.min(images.length, 4)}`}>
      ${images.map((a, i) => html`<button type="button" class="thumb" key=${a.id} onClick=${() => open(i)} aria-label=${`Open ${a.name}`}>
        <img src=${a.view ?? a.url} alt=${a.name} loading="lazy" style=${a.width && a.height && images.length === 1 ? { aspectRatio: `${a.width} / ${a.height}` } : null} />
      </button>`)}
    </div>`}
    ${list.filter(a => a.kind === 'video').map(a => html`<div class="video" key=${a.id}>
      <video controls playsinline preload="metadata" poster=${a.poster ?? undefined} src=${a.url}
        style=${a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : null}></video>
      <div class="file-meta"><span class="truncate">${a.name}</span><span>${a.duration ? fmtDuration(a.duration) : ''} · ${fmtBytes(a.size)}</span></div>
    </div>`)}
    ${list.filter(a => a.kind === 'file').map(a => html`<div class="file-chip" key=${a.id}>
      <${Icon} name="file" />
      <a class="truncate" href=${a.url} target="_blank" rel="noopener">${a.name}</a>
      <span class="size">${fmtBytes(a.size)}</span>
      <a class="dl" href=${`${a.url}/download`} aria-label=${`Download ${a.name}`}><${Icon} name="download" /></a>
    </div>`)}
  </div>`
}

