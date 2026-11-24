// Shared helpers: rendering, HTTP, formatting and Markdown.
import { h } from 'preact'
import htm from 'htm'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export const html = htm.bind(h)

// ---------------------------------------------------------------------------------------------
// HTTP

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data
}

// ---------------------------------------------------------------------------------------------
// Formatting

export const STATUS = {
  working: 'working', idle: 'idle', blocked: 'needs approval', attention: 'needs attention',
  starting: 'starting', exited: 'exited', stopped: 'stopped', limited: 'usage limit',
}

export function ago(ts, now = Date.now()) {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000))
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export { clock, when } from './clock.js'

export function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

/** /Users/name/Projects/x → ~/Projects/x */
export function tilde(p = '') {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

/** Short form of a folder for tight spaces: ~/a/b, or …/parent/folder when long. */
export function shortPath(p = '', max = 34) {
  const t = tilde(p).replace(/\/$/, '')
  if (t.length <= max) return t
  const parts = t.split('/')
  return `…/${parts.slice(-2).join('/')}`
}

export const plain = s => s.replace(/```[\s\S]*?```/g, '[code]').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()

/** Snippet text without Markdown syntax, keeping [match] brackets from keyword search. */
export const unmark = s => s.replace(/```\w*/g, ' ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()

export function fmtBytes(n) {
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GB`
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export const fmtDuration = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** One-line preview of a message for cards and lists, including attachment-only messages. */
/** Does a message ask something? A question mark ending a sentence in its last few lines (code left out), or
 * an explicit ask ("want me to", "let me know which", "approve"). Reads `tail` (the end of a long preview) when present. */
const ASK = /\b(let me know (which|what|whether|how|when)|want me to|should I|shall I|do you want|would you like|which (one|do you)|your call|ok to|okay to|approve|confirm)\b/i
export function asksSomething(m) {
  const text = String(m?.tail ?? m?.body ?? '').replace(/```[\s\S]*?(```|$)/g, ' ')
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join('\n')
  return /\?(?=[\s)*_"'\]]|$)/.test(lines) || ASK.test(lines)
}

export function excerpt(m) {
  const text = plain(m?.body ?? '')
  if (text) return text
  const n = m?.attachments?.length ?? m?.files ?? 0
  return n ? `${n} attachment${n === 1 ? '' : 's'}` : ''
}

/** "claude-fable-5-2" → "Fable 5.2", "claude-sonnet-4-5-20250929" → "Sonnet 4.5", "opus" → "Opus". */
export function modelLabel(id) {
  if (!id) return ''
  const parts = String(id).replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '').split('-')
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).filter(p => /^\d+$/.test(p)).join('.')
  return version ? `${name} ${version}` : name
}

/** The chip text for a session: "Fable 5.2 · high", or what is known so far. */
export const modelChip = s => [modelLabel(s?.model), s?.effort].filter(Boolean).join(' · ')

/** A message that runs in the session's terminal instead of going to Claude (mirrors the server's rule). */
export const isCommand = text => /^\/[a-z][\w:-]*(?:\s|$)/i.test(text) && !text.startsWith('//')

/** Commands that open a picker in the terminal when given no arguments. */
export const opensPicker = text => /^\/(model|effort|config|permissions|mcp|agents|resume|memory|hooks|status|login|theme|output-style|plugin)\s*$/i.test(text.trim())

export const fmtNumber = n => new Intl.NumberFormat().format(n)

// ---------------------------------------------------------------------------------------------
// Markdown: GitHub-flavoured, sanitised, with copy buttons on code blocks.

marked.setOptions({ gfm: true, breaks: true })
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const cache = new Map()
/**
 * Markdown to safe HTML. Chat keeps each newline as a line break; a file (`{ file: true }`) joins its
 * hard-wrapped lines into paragraphs, so they reflow on a phone instead of ending in jagged half-lines.
 */
export function markdown(text, { file = false } = {}) {
  const key = file ? `\0file\0${text}` : text
  if (cache.has(key)) return cache.get(key)
  const clean = DOMPurify.sanitize(marked.parse(text, { breaks: !file }), { FORBID_TAGS: ['style', 'img', 'iframe', 'form', 'input'] })
  const out = clean
    .replace(/<pre>/g, '<div class="code"><button type="button" class="btn sm copy" data-copy>Copy</button><pre>')
    .replace(/<\/pre>/g, '</pre></div>')
  const linked = linkPaths(out)
  if (cache.size > 500) cache.clear()
  cache.set(key, linked)
  return linked
}

// File paths in a message open the read-only file viewer: absolute or ~/ paths with an extension anywhere in the
// text; in inline code also folders and relative paths with a folder (server/x.ts, resolved against the session's
// folder). A trailing :line jumps to that line.
const PATH_IN_TEXT = /(^|[\s(\[{"'<>,;])((?:~\/|\/)(?:[\w.@+-]+\/)+[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10})(?::(\d+)(?::\d+)?)?/g
const PATH_IN_CODE = /^((?:~\/|\/)?(?:[\w.@+-]+\/)+[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10}|(?:~\/|\/)(?:[\w.@+-]+\/)+[\w.@+-]+)(?::(\d+)(?::\d+)?)?$/
function linkPaths(markup) {
  if (!markup.includes('/')) return markup
  const tpl = document.createElement('template')
  tpl.innerHTML = markup
  let changed = false
  for (const code of tpl.content.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue
    const m = PATH_IN_CODE.exec(code.textContent.trim())
    if (!m || m[1].startsWith('//')) continue
    code.classList.add('path')
    code.dataset.path = m[1]
    if (m[2]) code.dataset.line = m[2]
    code.setAttribute('role', 'link')
    code.tabIndex = 0
    changed = true
  }
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT)
  const texts = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.includes('/') && !n.parentElement?.closest('a, code, pre')) texts.push(n)
  }
  for (const node of texts) {
    const value = node.nodeValue
    const frag = document.createDocumentFragment()
    let last = 0
    for (const m of value.matchAll(PATH_IN_TEXT)) {
      const start = m.index + m[1].length
      frag.append(value.slice(last, start))
      const link = document.createElement('span')
      link.className = 'path'
      link.dataset.path = m[2]
      if (m[3]) link.dataset.line = m[3]
      link.setAttribute('role', 'link')
      link.tabIndex = 0
      link.textContent = value.slice(start, m.index + m[0].length)
      frag.append(link)
      last = m.index + m[0].length
    }
    if (!last) continue
    frag.append(value.slice(last))
    node.replaceWith(frag)
    changed = true
  }
  return changed ? tpl.innerHTML : markup
}

// One listener handles every copy button.
document.addEventListener('click', async e => {
  const btn = e.target.closest?.('[data-copy]')
  if (!btn) return
  const code = btn.parentElement.querySelector('pre')?.innerText ?? ''
  try {
    await navigator.clipboard.writeText(code)
    btn.textContent = 'Copied'
  } catch {
    btn.textContent = 'Select and copy'
  }
  setTimeout(() => (btn.textContent = 'Copy'), 1400)
})

// ---------------------------------------------------------------------------------------------
// Storage that never throws (private windows, blocked storage).

export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key)
      return v === null ? fallback : JSON.parse(v)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // not remembered, which is fine
    }
  },
}
