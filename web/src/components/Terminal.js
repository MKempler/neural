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
    ;(async () => {
      try {
        await loadScript('/vendor/@xterm/xterm/lib/xterm.js')
        await loadScript('/vendor/@xterm/addon-fit/lib/addon-fit.js')
      } catch {
        onFail()
        return
      }
      if (disposed) return
      const css = getComputedStyle(document.documentElement)
      term = new window.Terminal({
        fontFamily: css.getPropertyValue('--mono'),
        fontSize: matchMedia('(max-width: 860px)').matches ? 11 : 12.5,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 0, // history lives in tmux; the History button shows it
        theme: { background: css.getPropertyValue('--term-bg').trim(), foreground: css.getPropertyValue('--term-text').trim(), cursor: css.getPropertyValue('--accent').trim() },
      })
      fit = new window.FitAddon.FitAddon()
      term.loadAddon(fit)
      term.open(host.current)
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
      observer.observe(host.current)
      if (!matchMedia('(pointer: coarse)').matches) term.focus()
    })()
    return () => {
      disposed = true
      conn.current = null
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
