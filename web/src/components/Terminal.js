// The session's terminal: a live xterm attached to its tmux pane, with a key bar for phones.
// Falls back to refreshing screen snapshots when the live view is unavailable.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, api } from '../lib.js'
import { liveTerminal } from '../store.js'

const KEYS = [
  ['Esc', 'Escape', '\x1b'], ['Tab', 'Tab', '\t'], ['⇧Tab', 'BTab', '\x1b[Z'], ['↑', 'Up', '\x1b[A'], ['↓', 'Down', '\x1b[B'],
  ['Enter', 'Enter', '\r'], ['y', 'y', 'y'], ['n', 'n', 'n'], ['1', '1', '1'], ['2', '2', '2'], ['3', '3', '3'], ['Ctrl+C', 'C-c', '\x03'],
]

const TERM_COLS = 200 // TERM_SIZE in server/src/mux/mux.ts
const TERM_ROWS = 50

const scripts = new Map()
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const tag = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error(src)) })
      document.head.append(tag)
    }))
  }
  return scripts.get(src)
}

// The terminal is a fixed 200x50 (the server never resizes it to the viewer). "fit" scales the text so all of it
// shows; "pan" fits the height and scrolls sideways, which keeps the text readable on a phone.
const narrow = () => matchMedia('(max-width: 860px)').matches
function savedView() {
  try {
    const v = localStorage.getItem('neural.termView')
    if (v === 'fit' || v === 'pan') return v
  } catch {}
  return narrow() ? 'pan' : 'fit'
}

export function Terminal({ name }) {
  const [view, setView] = useState(savedView)
  const toggleView = () => {
    const v = view === 'fit' ? 'pan' : 'fit'
    setView(v)
    try { localStorage.setItem('neural.termView', v) } catch {}
  }
  const [history, setHistory] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = liveTerminal.value && !history && !failed
  const conn = useRef(null)

  const sendKey = async ([, tmuxKey, bytes]) => {
    if (live && conn.current) {
      conn.current.send(bytes)
      return
    }
    await api('POST', `/api/sessions/${encodeURIComponent(name)}/keys`, { keys: [tmuxKey] }).catch(e => alert(e.message))
  }

  return html`<div class="terminal">
    ${live
      ? html`<${Live} name=${name} view=${view} conn=${conn} onFail=${() => setFailed(true)} />`
      : html`<${Snapshot} name=${name} history=${history} />`}
    <div class="term-keys">
      ${KEYS.map(k => html`<button type="button" onClick=${() => sendKey(k)}>${k[0]}</button>`)}
      ${!live && html`<${TypeBox} name=${name} />`}
      <span class="sep"></span>
      ${live && html`<button type="button" class=${view === 'fit' ? 'on' : ''} title="Fit the whole terminal, or fit its height and pan sideways"
        onClick=${toggleView}>Fit</button>`}
      ${liveTerminal.value && html`<button type="button" class=${history ? 'on' : ''} onClick=${() => setHistory(!history)}>
        ${history ? 'Back to live' : 'History'}</button>`}
    </div>
  </div>`
}

function Live({ name, view, conn, onFail }) {
  const host = useRef(null)
  const layout = useRef(null)
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => layout.current?.(), [view])
  useEffect(() => {
    let term, ws, observer
    let disposed = false
    const el = host.current
    const listeners = []
    const listen = (type, fn, opts) => {
      el.addEventListener(type, fn, opts)
      listeners.push([type, fn, opts])
    }
    ;(async () => {
      try {
        await loadScript('/vendor/@xterm/xterm/lib/xterm.js')
      } catch {
        onFail()
        return
      }
      const css = getComputedStyle(document.documentElement)
      const fontFamily = css.getPropertyValue('--mono').trim()
      // xterm measures the character cell once. Measured with a fallback font before Plex Mono arrives, the rows
      // come out shorter than they draw, and the bottom line (Claude Code's status footer) is cut off.
      await document.fonts?.load(`12px ${fontFamily}`).catch(() => {})
      if (disposed) return
      term = new window.Terminal({
        cols: TERM_COLS,
        rows: TERM_ROWS,
        fontFamily,
        fontSize: narrow() ? 11 : 12.5,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 0, // history lives in tmux; the History button shows it
        theme: { background: css.getPropertyValue('--term-bg').trim(), foreground: css.getPropertyValue('--term-text').trim(), cursor: css.getPropertyValue('--accent').trim() },
      })
      term.open(el)
      // Size the text to the pane: the cell size follows the font size, so scale it by how far off it is,
      // a couple of times since the cell is rounded to whole pixels.
      const screen = el.querySelector('.xterm-screen')
      let tries = 0
      const fitFont = () => {
        if (disposed || !screen.offsetWidth || !screen.offsetHeight) return
        const pad = getComputedStyle(el)
        const w = el.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight)
        const h = el.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom)
        const byHeight = h / screen.offsetHeight
        const scale = viewRef.current === 'fit' ? Math.min(w / screen.offsetWidth, byHeight) : byHeight
        const size = Math.min(16, Math.max(3, Math.floor(term.options.fontSize * scale * 4) / 4))
        if (Math.abs(size - term.options.fontSize) < 0.2 || ++tries > 4) return
        term.options.fontSize = size
        requestAnimationFrame(fitFont)
      }
      layout.current = () => {
        tries = 0
        el.classList.toggle('pan', viewRef.current === 'pan')
        fitFont()
      }
      layout.current()
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/term?name=${encodeURIComponent(name)}`)
      const send = msg => ws.readyState === 1 && ws.send(JSON.stringify(msg))
      ws.onmessage = e => term.write(e.data)
      ws.onclose = () => !disposed && term.write('\r\n\x1b[2m[terminal disconnected]\x1b[0m\r\n')
      term.onData(data => send({ type: 'input', data }))
      conn.current = { send: data => send({ type: 'input', data }) }
      observer = new ResizeObserver(() => layout.current?.())
      observer.observe(el)

      // Scrolling: the history lives in tmux, not in xterm (scrollback 0), so a swipe or the mouse wheel asks the
      // server to scroll tmux's own view. Typing afterwards jumps back to the bottom.
      const lineHeight = () => el.clientHeight / Math.max(1, term.rows)
      let pending = 0
      let queued = false
      const scroll = lines => {
        pending += lines
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          const n = Math.trunc(pending)
          pending -= n
          if (n) send({ type: 'scroll', lines: n })
        })
      }
      // In pan view a sideways swipe pans the page (native scrolling); only an up-and-down one scrolls tmux.
      let lastY = null
      let start = null
      let axis = null
      listen('touchstart', e => {
        const t = e.touches.length === 1 ? e.touches[0] : null
        lastY = t ? t.clientY : null
        start = t && { x: t.clientX, y: t.clientY }
        axis = null
      }, { passive: true, capture: true })
      listen('touchmove', e => {
        if (lastY === null || e.touches.length !== 1) return
        if (!axis && viewRef.current === 'pan') {
          const dx = Math.abs(e.touches[0].clientX - start.x), dy = Math.abs(e.touches[0].clientY - start.y)
          if (Math.max(dx, dy) < 6) return
          axis = dx > dy ? 'x' : 'y'
        }
        if (axis === 'x') return
        e.preventDefault()
        const y = e.touches[0].clientY
        scroll((y - lastY) / lineHeight()) // finger moving down shows earlier lines
        lastY = y
      }, { passive: false, capture: true })
      listen('wheel', e => {
        e.preventDefault()
        e.stopPropagation()
        scroll(-(e.deltaMode === 1 ? e.deltaY : e.deltaY / lineHeight()))
      }, { passive: false, capture: true })

      if (!matchMedia('(pointer: coarse)').matches) term.focus()
    })()
    return () => {
      disposed = true
      conn.current = null
      for (const [type, fn, opts] of listeners) el.removeEventListener(type, fn, opts)
      observer?.disconnect()
      ws?.close()
      term?.dispose()
    }
  }, [name])
  return html`<div class="term-live" ref=${host}></div>`
}

function Snapshot({ name, history }) {
  const [screen, setScreen] = useState('')
  const pre = useRef(null)
  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const { screen } = await api('GET', `/api/screen/${encodeURIComponent(name)}?history=${history ? 3000 : 0}`)
        if (stop) return
        const el = pre.current
        const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40
        setScreen(screen || '(nothing on screen)')
        if (atBottom) requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight))
      } catch {
        // keep the last screen until the next refresh
      }
    }
    tick()
    const timer = setInterval(tick, history ? 5000 : 1500)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [name, history])
  return html`<pre class="term-snapshot" ref=${pre} tabindex="0">${screen}</pre>`
}

function TypeBox({ name }) {
  const [text, setText] = useState('')
  const submit = async e => {
    e.preventDefault()
    if (!text) return
    await api('POST', `/api/sessions/${encodeURIComponent(name)}/type`, { text }).catch(err => alert(err.message))
    setText('')
  }
  return html`<form onSubmit=${submit}>
    <input value=${text} onInput=${e => setText(e.currentTarget.value)} placeholder="Type into the terminal" autocomplete="off" autocapitalize="off" spellcheck="false" />
    <button type="submit">Type</button>
  </form>`
}
