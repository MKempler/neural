// Quick replies: the short answers you give most ("Continue", "Go ahead"), one tap away above the message box
// and on Home's unread cards. Tap sends; hold (or right-click) puts the text in the message box to edit first.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, api } from '../lib.js'
import { Icon } from '../icons.js'
import { Overlay } from './overlays.js'
import { quickReplies, quickRepliesOpen, saveQuickReplies, sendNow, markRead } from '../store.js'

const HOLD_MS = 450

/** Is the session waiting for an answer? Idle, and the last word in the conversation is its own. */
export function awaitingReply(s, rows, pending) {
  if (!s || s.status !== 'idle' || pending.length) return false
  const last = rows?.at(-1)
  return Boolean(last && last.from_name === s.name && last.to_name === 'user')
}

/** One chip: tap to send, hold to edit. */
function Chip({ text, onSend, onHold }) {
  const timer = useRef(null)
  const held = useRef(false)
  const down = () => {
    held.current = false
    if (!onHold) return
    timer.current = setTimeout(() => {
      held.current = true
      navigator.vibrate?.(10)
      onHold(text)
    }, HOLD_MS)
  }
  const cancel = () => clearTimeout(timer.current)
  return html`<button type="button" class="chip quick-chip" title=${onHold ? 'Tap to send · hold to edit first' : 'Send'}
    onPointerDown=${down} onPointerUp=${cancel} onPointerLeave=${cancel} onPointerCancel=${cancel}
    onContextMenu=${e => { if (onHold) { e.preventDefault(); cancel(); held.current = true; onHold(text) } }}
    onClick=${e => { e.stopPropagation(); if (held.current) { held.current = false; return } onSend(text) }}>${text}</button>`
}

/** The row above a session's message box. `onHold` puts a reply in the box instead of sending it. */
export function QuickReplies({ name, onHold, limit, compact = false, after }) {
  const list = limit ? quickReplies.value.slice(0, limit) : quickReplies.value
  if (!list.length) return null
  const send = text => {
    sendNow(name, text)
    after?.(text)
  }
  return html`<div class=${`quick-replies ${compact ? 'compact' : ''}`} role="group" aria-label="Quick replies">
    ${list.map(t => html`<${Chip} key=${t} text=${t} onSend=${send} onHold=${onHold} />`)}
    ${!compact && html`<button type="button" class="chip icon-chip" aria-label="Edit quick replies" title="Edit quick replies"
      onClick=${() => (quickRepliesOpen.value = true)}><${Icon} name="pencil" size=${13} /></button>`}
  </div>`
}

/** Home's unread cards: reply without opening the session. */
export function CardReplies({ s }) {
  const last = s.last_reply ?? s.last_message
  return html`<div class="card-replies" onClick=${e => e.stopPropagation()}>
    <${QuickReplies} name=${s.name} limit=${3} compact=${true} after=${() => last && markRead(s.name, last.id)} />
  </div>`
}

/** Edit the list: reorder, remove, add your own, or pick from what you often send. */
export function QuickRepliesSheet() {
  if (!quickRepliesOpen.value) return null
  return html`<${Editor} />`
}

function Editor() {
  const [list, setList] = useState(quickReplies.value)
  const [text, setText] = useState('')
  const [suggested, setSuggested] = useState([])
  const [error, setError] = useState('')
  const close = () => (quickRepliesOpen.value = false)
  useEffect(() => {
    api('GET', '/api/prefs/suggestions').then(r => setSuggested(r.replies), () => {})
  }, [])
  const has = t => list.some(x => x.toLowerCase() === t.toLowerCase())
  const add = t => {
    t = t.trim()
    if (t && !has(t) && list.length < 12) setList([...list, t])
  }
  const move = (i, by) => {
    const j = i + by
    if (j < 0 || j >= list.length) return
    const next = list.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setList(next)
  }
  const save = async () => {
    try {
      await saveQuickReplies(list)
      close()
    } catch (e) {
      setError(e.message)
    }
  }
  const ideas = suggested.filter(r => !has(r.body))
  return html`<${Overlay} onClose=${close} label="Quick replies">
    <div class="sheet quick-sheet">
      <div class="sheet-head"><h2>Quick replies</h2>
        <button class="btn ghost icon-only" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
      <div class="sheet-body">
        <p class="hint">Shown above the message box when a session is waiting for you. Tap one to send it; hold it to edit it first.</p>
        <div class="quick-list">
          ${list.map((t, i) => html`<div class="quick-item" key=${t}>
            <span class="txt">${t}</span>
            <button class="btn ghost sm icon-only" aria-label=${`Move ${t} up`} disabled=${i === 0} onClick=${() => move(i, -1)}><${Icon} name="up" size=${14} /></button>
            <button class="btn ghost sm icon-only" aria-label=${`Move ${t} down`} disabled=${i === list.length - 1} onClick=${() => move(i, 1)}><${Icon} name="down" size=${14} /></button>
            <button class="btn ghost sm icon-only" aria-label=${`Remove ${t}`} onClick=${() => setList(list.filter(x => x !== t))}><${Icon} name="x" size=${14} /></button>
          </div>`)}
          ${!list.length && html`<div class="quiet">No quick replies. Add one below.</div>`}
        </div>
        <form class="quick-add" onSubmit=${e => { e.preventDefault(); add(text); setText('') }}>
          <input class="input" placeholder="Add a reply…" value=${text} maxLength="300" onInput=${e => setText(e.currentTarget.value)} />
          <button class="btn" disabled=${!text.trim() || list.length >= 12}>Add</button>
        </form>
        ${ideas.length > 0 && html`<div class="field"><span>You often send</span>
          <div class="chips">${ideas.map(r => html`<button class="chip" key=${r.body} title=${`Sent ${r.n} times`} onClick=${() => add(r.body)}>+ ${r.body}</button>`)}</div>
        </div>`}
        ${error && html`<div class="error">${error}</div>`}
      </div>
      <div class="sheet-foot">
        <button class="btn ghost" onClick=${close}>Cancel</button>
        <button class="btn primary" onClick=${save}>Save</button>
      </div>
    </div>
  </${Overlay}>`
}
