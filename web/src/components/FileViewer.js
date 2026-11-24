// Read-only file viewer: a path tapped in a message opens here, rendered (Markdown, highlighted code, images,
// folder listings). The hub decides what may be shown; this only displays it.
import { useEffect, useRef, useState } from 'preact/hooks'
import { html, api, markdown, tilde, fmtBytes, ago } from '../lib.js'
import { Icon } from '../icons.js'
import { Overlay } from './overlays.js'
import { fileView, route } from '../store.js'

// Any element with data-path opens the viewer. Relative paths resolve against the file being viewed, else the
// session the message came from (data-base), else the session on screen.
document.addEventListener('click', e => {
  const el = e.target.closest?.('[data-path]')
  if (!el || e.defaultPrevented) return
  e.preventDefault()
  open(el)
})
document.addEventListener('keydown', e => {
  const el = e.target.closest?.('[data-path]')
  if (el && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    open(el)
  }
})

function open(el) {
  let path = el.dataset.path
  const line = Number(el.dataset.line) || undefined
  const viewing = el.closest('[data-viewing]')?.dataset.viewing
  if (viewing && !/^[~/]/.test(path)) path = join(viewing, path)
  const base = el.closest('[data-base]')?.dataset.base || (route.value.view === 'session' ? route.value.name : '')
  const cur = fileView.value
  fileView.value = { path, line, base, back: cur ? [...cur.back, { path: cur.path, base: cur.base }] : [] }
}

function join(file, rel) {
  const parts = file.split('/').slice(0, -1)
  for (const p of rel.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.' && p) parts.push(p)
  }
  return parts.join('/')
}

export function FileViewer() {
  const fv = fileView.value
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const body = useRef(null)
  useEffect(() => {
    if (!fv) return
    let gone = false
    setData(null)
    setError('')
    const q = new URLSearchParams({ path: fv.path, ...(fv.base ? { base: fv.base } : {}) })
    api('GET', `/api/view?${q}`)
      .then(d => !gone && setData(d))
      .catch(e => !gone && setError(e.message))
    return () => (gone = true)
  }, [fv?.path, fv?.base])
  useEffect(() => {
    if (!data || !fv?.line) return
    body.current?.querySelector(`[data-ln="${fv.line}"]`)?.scrollIntoView({ block: 'center' })
  }, [data])
  if (!fv) return null
  const close = () => (fileView.value = null)
  const back = () => {
    const prev = fv.back.at(-1)
    fileView.value = prev ? { ...prev, back: fv.back.slice(0, -1) } : null
  }
  const name = data?.name ?? fv.path.split('/').filter(Boolean).at(-1) ?? fv.path
  const up = data && data.path !== '/' ? data.path.split('/').slice(0, -1).join('/') || '/' : null
  const raw = data && `/api/view/raw?${new URLSearchParams({ path: data.path })}`
  return html`<${Overlay} onClose=${close} label="File">
    <div class="file-view" data-viewing=${data?.path ?? ''}>
      <header class="file-head">
        ${fv.back.length > 0 && html`<button class="btn sm icon" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>`}
        <div class="file-title">
          <div class="truncate"><strong>${name}</strong></div>
          <div class="file-meta truncate">${data ? `${tilde(data.path)}${data.kind !== 'folder' ? ` · ${fmtBytes(data.size)}` : ''} · ${ago(data.modified)}` : tilde(fv.path)}</div>
        </div>
        ${up && html`<button class="btn sm" title="Open the folder" data-path=${up}>Folder</button>`}
        <button class="btn sm icon" aria-label="Close" onClick=${close}><${Icon} name="x" /></button>
      </header>
      <div class="file-body" ref=${body}>
        ${error && html`<p class="file-note">${error}</p>`}
        ${!data && !error && html`<p class="file-note">Loading…</p>`}
        ${data && html`
          ${data.redacted && html`<p class="file-note">${data.redacted} secret${data.redacted > 1 ? 's' : ''} hidden.</p>`}
          ${data.truncated && html`<p class="file-note">Showing the first ${fmtBytes(data.text.length)}.</p>`}
          ${data.kind === 'markdown' && html`<div class="md file-md" dangerouslySetInnerHTML=${{ __html: markdown(data.text) }} />`}
          ${(data.kind === 'code' || data.kind === 'text') && html`<${Code} text=${data.text} lang=${data.lang} line=${fv.line} />`}
          ${data.kind === 'image' && html`<div class="file-image"><img src=${raw} alt=${data.name} /></div>`}
          ${data.kind === 'binary' && html`<p class="file-note">A binary file; nothing to show.</p>`}
          ${data.kind === 'folder' && html`<ul class="file-list">
            ${data.entries.length === 0 && html`<li class="file-note">Empty folder.</li>`}
            ${data.entries.map(en => html`<li><button type="button" data-path=${`${data.path}/${en.name}`.replace(/^\/\//, '/')}>
              <${Icon} name=${en.folder ? 'sessions' : 'file'} /><span class="truncate">${en.name}</span>
              ${!en.folder && html`<span class="file-size">${fmtBytes(en.size)}</span>`}</button></li>`)}
          </ul>`}`}
      </div>
    </div>
  </${Overlay}>`
}

function Code({ text, lang, line }) {
  const lines = (text.length > 300_000 ? plain(text) : highlight(text, lang)).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return html`<div class="file-code" style=${`--gutter: ${String(lines.length).length + 1}ch`}>
    ${lines.map((l, i) => html`<div class=${`ln ${line === i + 1 ? 'hit' : ''}`} data-ln=${i + 1} dangerouslySetInnerHTML=${{ __html: l || ' ' }} />`)}
  </div>`
}

// ---------------------------------------------------------------------------------------------
// A small highlighter: comments, strings, numbers and keywords, which is most of what helps when reading code
// on a phone. Output is escaped HTML split into lines, a span never crossing a line break.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const plain = esc

const KW = {
  js: 'async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof interface let new null of return static super switch this throw true try type typeof undefined var void while yield enum implements private public readonly as',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield end do then unless module require puts nil',
  sh: 'if then else elif fi for while do done case esac in function return local export set unset echo exit source',
  c: 'break case catch class const continue default do else enum extern false fn for func go if impl import in let loop match mod mut new nil null package pub return self static struct switch this throw true try type use var void while val fun interface public private protected guard defer',
  css: 'important media supports keyframes from to',
  sql: 'select from where insert into update delete create table index on and or not null primary key values set join left inner group by order limit as with',
  yaml: 'true false null yes no',
  lua: 'and break do else elseif end false for function if in local nil not or repeat return then true until while',
  json: 'true false null',
  html: '',
}
const COMMENT = {
  js: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`, c: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`, css: String.raw`\/\*[\s\S]*?\*\/`,
  py: '#[^\\n]*', sh: '#[^\\n]*', yaml: '#[^\\n]*', sql: '--[^\\n]*', lua: '--\\[\\[[\\s\\S]*?\\]\\]|--[^\\n]*',
  html: '<!--[\\s\\S]*?-->', json: '(?!)',
}
const STRING = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + '`(?:\\\\.|[^`\\\\])*`'
const NUMBER = String.raw`\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`
const cache = {}

function tokenizer(lang) {
  if (cache[lang]) return cache[lang]
  const kw = KW[lang] ?? ''
  const parts = [`(${COMMENT[lang] ?? '(?!)'})`, `(${STRING})`, `(${NUMBER})`, kw ? `\\b(${kw.split(' ').join('|')})\\b` : '((?!))']
  if (lang === 'html') parts.push('(</?[A-Za-z][\\w:-]*)')
  return (cache[lang] = new RegExp(parts.join('|'), 'g'))
}

function highlight(text, lang) {
  if (!lang) return esc(text)
  const re = tokenizer(lang)
  const cls = ['c', 's', 'n', 'k', 'k']
  let out = ''
  let last = 0
  re.lastIndex = 0
  for (let m; (m = re.exec(text)); ) {
    if (!m[0]) {
      re.lastIndex++
      continue
    }
    const kind = cls[m.slice(1).findIndex(g => g !== undefined)]
    out += esc(text.slice(last, m.index))
    out += esc(m[0]).split('\n').map(piece => (piece ? `<span class="t-${kind}">${piece}</span>` : '')).join('\n')
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}
