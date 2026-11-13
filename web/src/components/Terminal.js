// The session's terminal: a live xterm attached to its tmux pane, with a key bar for phones.
// Falls back to refreshing screen snapshots when the live view is unavailable.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, api } from '../lib.js'
import { liveTerminal } from '../store.js'

const KEYS = [
  ['Esc', 'Escape', '\x1b'], ['Tab', 'Tab', '\t'], ['⇧Tab', 'BTab', '\x1b[Z'], ['↑', 'Up', '\x1b[A'], ['↓', 'Down', '\x1b[B'],
  ['Enter', 'Enter', '\r'], ['y', 'y', 'y'], ['n', 'n', 'n'], ['1', '1', '1'], ['2', '2', '2'], ['3', '3', '3'], ['Ctrl+C', 'C-c', '\x03'],
]

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

export function Terminal({ name }) {
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
      ? html`<${Live} name=${name} conn=${conn} onFail=${() => setFailed(true)} />`
      : html`<${Snapshot} name=${name} history=${history} />`}
    <div class="term-keys">
      ${KEYS.map(k => html`<button type="button" onClick=${() => sendKey(k)}>${k[0]}</button>`)}
      ${!live && html`<${TypeBox} name=${name} />`}
      <span class="sep"></span>
      ${liveTerminal.value && html`<button type="button" class=${history ? 'on' : ''} onClick=${() => setHistory(!history)}>
        ${history ? 'Back to live' : 'History'}</button>`}
    </div>
  </div>`
}

function Live({ name, conn, onFail }) {
  const host = useRef(null)
  useEffect(() => {
    let term, fit, ws, observer
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
        await loadScript('/vendor/@xterm/addon-fit/lib/addon-fit.js')
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
        fontFamily,
        fontSize: matchMedia('(max-width: 860px)').matches ? 11 : 12.5,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 0, // history lives in tmux; the History button shows it
        theme: { background: css.getPropertyValue('--term-bg').trim(), foreground: css.getPropertyValue('--term-text').trim(), cursor: css.getPropertyValue('--accent').trim() },
      })
      fit = new window.FitAddon.FitAddon()
      term.loadAddon(fit)
      term.open(el)
      fit.fit()
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/term?name=${encodeURIComponent(name)}&cols=${term.cols}&rows=${term.rows}`)
      const send = msg => ws.readyState === 1 && ws.send(JSON.stringify(msg))
      ws.onmessage = e => term.write(e.data)
      ws.onclose = () => !disposed && term.write('\r\n\x1b[2m[terminal disconnected]\x1b[0m\r\n')
      term.onData(data => send({ type: 'input', data }))
      term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
      conn.current = { send: data => send({ type: 'input', data }) }
      observer = new ResizeObserver(() => fit.fit())
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
      let lastY = null
      listen('touchstart', e => (lastY = e.touches.length === 1 ? e.touches[0].clientY : null), { passive: true, capture: true })
      listen('touchmove', e => {
        if (lastY === null || e.touches.length !== 1) return
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
