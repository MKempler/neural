// The message box and its attachments: upload as soon as a file is picked, thumbnails, progress, retry.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, isCommand } from '../lib.js'
import { Icon } from '../icons.js'
import { drafts } from '../store.js'

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
  const latest = useRef(items)
  latest.current = items
  useEffect(() => () => latest.current.forEach(it => it.preview && URL.revokeObjectURL(it.preview)), [])
  const pending = items.some(it => it.status === 'uploading' || it.status === 'processing')
  const failed = items.some(it => it.status === 'error')
  const ready = items.filter(it => it.status === 'ready').map(it => it.server.id)
  return { items, add, remove, retry, clear, pending, failed, ready }
}

function Tray({ att }) {
  if (!att.items.length) return null
  const errors = att.items.filter(it => it.status === 'error')
  return html`<div class="tray-wrap"><div class="tray">
    ${att.items.map(it => html`<div class=${`tile ${it.status}`} key=${it.key} title=${it.name}>
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
  </div>
  <div role="alert">${errors.map(it => html`<div class="tray-error" key=${`e${it.key}`}>${it.name}: ${it.error}</div>`)}</div>
  </div>`
}

/**
 * The message box. A pill with + (photos, camera, files), a growing text box and Send, which turns into Stop
 * while the session is working. Paste and drop add files too. Unsent text is kept per `draftKey`.
 * `onReady` receives { addFiles, insert } so the page around it can drop files in or quote a message.
 */
export function Composer({ placeholder, onSend, hint, autofocus, variant = 'composer', draftKey, onReady, stoppable, onStop }) {
  const [text, setText] = useState(() => (draftKey ? drafts.get(draftKey) : ''))
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const ref = useAutosize(text)
  const pickers = { media: useRef(null), camera: useRef(null), file: useRef(null) }
  const att = useAttachments()
  const box = useRef(null)

  useEffect(() => {
    if (autofocus && !coarse()) ref.current?.focus()
  }, [autofocus])
  // Keep the draft as you type; restore it when the box is shown for another session.
  useEffect(() => {
    if (draftKey) setText(drafts.get(draftKey))
  }, [draftKey])
  useEffect(() => {
    if (!draftKey) return
    const t = setTimeout(() => drafts.set(draftKey, text), 250)
    return () => clearTimeout(t)
  }, [text, draftKey])
  useEffect(() => {
    onReady?.({
      addFiles: att.add,
      insert: snippet => {
        setText(t => (t.trim() ? `${t.replace(/\s*$/, '')}\n\n${snippet}` : snippet))
        requestAnimationFrame(() => {
          const el = ref.current
          el?.focus()
          el?.setSelectionRange(el.value.length, el.value.length)
        })
      },
    })
  }, [onReady])
  useEffect(() => {
    if (!menu) return
    const close = e => !box.current?.contains(e.target) && setMenu(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const hasContent = Boolean(text.trim() || att.ready.length)
  const showStop = stoppable && !hasContent && !att.items.length
  const canSend = !busy && !att.pending && hasContent

  const submit = async e => {
    e?.preventDefault()
    if (!canSend) return
    if (att.failed && !confirm('Some files failed to upload. Send without them?')) return
    const body = text.trim()
    const ids = att.ready
    const previews = att.items.filter(it => it.status === 'ready').map(it => it.server)
    setBusy(true)
    try {
      await onSend(body, ids, previews)
      setText('')
      if (draftKey) drafts.set(draftKey, '')
      att.clear()
    } catch (err) {
      alert(err.message)
    } finally {
      setBusy(false)
      if (!coarse()) ref.current?.focus()
    }
  }
  const onKey = e => {
    // Enter sends on a keyboard; on a phone Return makes a new line and the button sends, as in ChatGPT.
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
  const pick = which => {
    setMenu(false)
    pickers[which].current?.click()
  }
  const fileInput = (which, props) => html`<input ref=${pickers[which]} type="file" hidden ...${props}
    onChange=${e => { att.add(e.currentTarget.files); e.currentTarget.value = '' }} />`

  return html`<form ref=${box} class=${`${variant} ${att.items.length ? 'has-files' : ''}`} onSubmit=${submit}
      onDragOver=${e => e.dataTransfer?.types?.includes('Files') && e.preventDefault()} onDrop=${onDrop}>
    <${Tray} att=${att} />
    ${variant !== 'quick' && isCommand(text.trim()) && !att.items.length && html`<div class="cmd-hint"><${Icon} name="terminal" size=${14} />
      Runs in the terminal · start with // to send it as text</div>`}
    <div class="composer-row">
      ${variant === 'quick' && hint}
      <div class="plus">
        <button type="button" class=${`btn ghost icon-only attach ${menu ? 'on' : ''}`} aria-label="Add photos, videos or files"
          aria-expanded=${menu} onClick=${() => setMenu(!menu)}><${Icon} name="plus" /></button>
        ${menu && html`<div class="plus-menu" role="menu">
          <button type="button" role="menuitem" onClick=${() => pick('media')}><${Icon} name="image" />Photos and videos</button>
          <button type="button" role="menuitem" onClick=${() => pick('camera')}><${Icon} name="camera" />Take photo or video</button>
          <button type="button" role="menuitem" onClick=${() => pick('file')}><${Icon} name="file" />Choose files</button>
          ${!coarse() && html`<div class="plus-hint">You can also paste or drop files here</div>`}
        </div>`}
        ${fileInput('media', { accept: 'image/*,video/*', multiple: true })}
        ${fileInput('camera', { accept: 'image/*,video/*', capture: 'environment' })}
        ${fileInput('file', { multiple: true })}
      </div>
      <textarea ref=${ref} rows="1" value=${text} placeholder=${placeholder} aria-label=${placeholder}
        autocapitalize="sentences" autocorrect="on" spellcheck="true"
        onInput=${e => setText(e.currentTarget.value)} onKeyDown=${onKey} onPaste=${onPaste}></textarea>
      ${showStop
        ? html`<button type="button" class="btn icon-only stop" aria-label="Stop" title="Stop the current turn"
            onClick=${onStop}><${Icon} name="stop" /></button>`
        : html`<button class="btn primary icon-only" disabled=${!canSend} aria-label=${att.pending ? 'Waiting for uploads' : 'Send'}
            title=${att.pending ? 'Waiting for uploads to finish' : 'Send'}><${Icon} name="send" /></button>`}
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

