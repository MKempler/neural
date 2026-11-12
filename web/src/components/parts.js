// Small building blocks shared by the views.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, STATUS, clock, markdown, tilde, fmtBytes, fmtDuration } from '../lib.js'
import { Icon } from '../icons.js'
import { decide, navigate, sessionPath, lightbox } from '../store.js'

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
      ${m.body && html`<div class="md" dangerouslySetInnerHTML=${{ __html: markdown(m.body) }}></div>`}
      <${Attachments} list=${m.attachments} />
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

// ---------------------------------------------------------------------------------------------
// Attachments in the composer: each file starts uploading as soon as it is picked.

let nextKey = 1
const kindOf = file => (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name) ? 'image' : file.type.startsWith('video/') ? 'video' : 'file')

function uploadFile(file, onProgress) {
  const xhr = new XMLHttpRequest()
  const done = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/upload')
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'file'))
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // handled below
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data)
      else reject(new Error(data?.error ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload failed; check the connection'))
    xhr.onabort = () => reject(new Error('cancelled'))
    xhr.send(file)
  })
  return { xhr, done }
}

export function useAttachments() {
  const [items, setItems] = useState([])
  const patch = (key, fields) => setItems(list => list.map(it => (it.key === key ? { ...it, ...fields } : it)))

  const start = item => {
    const { xhr, done } = uploadFile(item.file, p => patch(item.key, { progress: p, status: p >= 1 ? 'processing' : 'uploading' }))
    patch(item.key, { xhr, status: 'uploading', progress: 0, error: '' })
    done.then(
      server => patch(item.key, { status: 'ready', server, progress: 1 }),
      err => err.message !== 'cancelled' && patch(item.key, { status: 'error', error: err.message }),
    )
  }

  const add = files => {
    const fresh = [...(files ?? [])].filter(f => f && f.size !== undefined).map(file => ({
      key: nextKey++, file, name: file.name || 'pasted image', size: file.size, kind: kindOf(file),
      preview: kindOf(file) !== 'file' ? URL.createObjectURL(file) : null, status: 'uploading', progress: 0,
    }))
    if (!fresh.length) return
    setItems(list => [...list, ...fresh])
    fresh.forEach(start)
  }
  const remove = key => setItems(list => {
    const it = list.find(x => x.key === key)
    it?.xhr?.abort()
    if (it?.preview) URL.revokeObjectURL(it.preview)
    return list.filter(x => x.key !== key)
  })
  const retry = key => {
    const it = items.find(x => x.key === key)
    if (it) start(it)
  }
  const clear = () => setItems(list => {
    list.forEach(it => it.preview && URL.revokeObjectURL(it.preview))
    return []
  })
  useEffect(() => () => items.forEach(it => it.preview && URL.revokeObjectURL(it.preview)), [])
  const pending = items.some(it => it.status === 'uploading' || it.status === 'processing')
  const failed = items.some(it => it.status === 'error')
  const ready = items.filter(it => it.status === 'ready').map(it => it.server.id)
  return { items, add, remove, retry, clear, pending, failed, ready }
}

function Tray({ att }) {
  if (!att.items.length) return null
  return html`<div class="tray">
    ${att.items.map(it => html`<div class=${`tile ${it.status}`} key=${it.key} title=${it.error || it.name}>
      ${it.kind === 'image' && it.preview ? html`<img src=${it.preview} alt="" onError=${e => (e.currentTarget.style.visibility = 'hidden')} />`
        : it.kind === 'video' && it.preview ? html`<video src=${`${it.preview}#t=0.1`} muted playsinline preload="metadata"></video>`
        : html`<div class="tile-file"><${Icon} name="file" /><span>${it.name.split('.').pop()?.slice(0, 4)}</span></div>`}
      ${it.kind === 'video' && html`<span class="tile-tag">video</span>`}
      ${(it.status === 'uploading' || it.status === 'processing') && html`<div class="tile-progress">
        <span style=${{ width: `${Math.round(it.progress * 100)}%` }}></span></div>`}
      ${it.status === 'processing' && html`<span class="tile-state">${it.kind === 'video' ? 'preparing' : 'saving'}</span>`}
      ${it.status === 'error' && html`<button type="button" class="tile-state bad" onClick=${() => att.retry(it.key)}>retry</button>`}
      <button type="button" class="tile-x" aria-label=${`Remove ${it.name}`} onClick=${() => att.remove(it.key)}><${Icon} name="x" size=${12} /></button>
    </div>`)}
    ${att.items.filter(it => it.status === 'error').map(it => html`<div class="tray-error" key=${`e${it.key}`}>${it.name}: ${it.error}</div>`)}
  </div>`
}

/** The message box: text, attachments (button, paste, drop), and send. `registerDrop` receives a function that adds dropped files. */
export function Composer({ placeholder, onSend, hint, autofocus, variant = 'composer', registerDrop }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useAutosize(text)
  const picker = useRef(null)
  const att = useAttachments()
  useEffect(() => {
    if (autofocus && !coarse()) ref.current?.focus()
  }, [autofocus])
  useEffect(() => {
    registerDrop?.(att.add)
  }, [registerDrop])

  const canSend = !busy && !att.pending && (text.trim() || att.ready.length)
  const submit = async e => {
    e?.preventDefault()
    if (!canSend) return
    if (att.failed && !confirm('Some files failed to upload. Send without them?')) return
    setBusy(true)
    try {
      await onSend(text.trim(), att.ready)
      setText('')
      att.clear()
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
  const onPaste = e => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length) {
      e.preventDefault()
      att.add(files)
    }
  }
  const onDrop = e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    att.add(e.dataTransfer.files)
  }

  return html`<form class=${`${variant} ${att.items.length ? 'has-files' : ''}`} onSubmit=${submit}
      onDragOver=${e => e.dataTransfer?.types?.includes('Files') && e.preventDefault()} onDrop=${onDrop}>
    <${Tray} att=${att} />
    <div class="composer-row">
      ${variant === 'quick' && hint}
      <button type="button" class="btn ghost icon-only attach" aria-label="Attach photos, videos or files" title="Attach photos, videos or files"
        onClick=${() => picker.current?.click()}><${Icon} name="clip" /></button>
      <input ref=${picker} type="file" multiple hidden onChange=${e => { att.add(e.currentTarget.files); e.currentTarget.value = '' }} />
      <textarea ref=${ref} rows="1" value=${text} placeholder=${placeholder} aria-label=${placeholder}
        onInput=${e => setText(e.currentTarget.value)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
      <button class="btn primary icon-only" disabled=${!canSend} aria-label=${att.pending ? 'Waiting for uploads' : 'Send'}
        title=${att.pending ? 'Waiting for uploads to finish' : 'Send'}><${Icon} name="send" /></button>
    </div>
  </form>`
}

/** Drag files anywhere over `children` to attach them to the composer inside. */
export function DropZone({ children, onFiles, label = 'Drop to attach', class: cls = '' }) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const isFiles = e => e.dataTransfer?.types?.includes('Files')
  return html`<div class=${`dropzone ${cls}`}
      onDragEnter=${e => { if (!isFiles(e)) return; depth.current++; setOver(true) }}
      onDragLeave=${() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false) }}
      onDragOver=${e => isFiles(e) && e.preventDefault()}
      onDrop=${e => { depth.current = 0; setOver(false); if (e.dataTransfer?.files?.length) { e.preventDefault(); onFiles(e.dataTransfer.files) } }}>
    ${children}
    ${over && html`<div class="drop-hint"><${Icon} name="clip" size=${20} />${label}</div>`}
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
