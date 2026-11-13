// What a session changed in its repository: branch and push state, uncommitted files and commits, with diffs
// that read on a phone (one column, wrapped, a file at a time). Plus the one-line recap shown under a reply.
import { useEffect, useState } from 'preact/hooks'
import { html, api, ago } from '../lib.js'
import { Icon } from '../icons.js'
import { navigate, sessionPath, sendNow } from '../store.js'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "2 commits · 5 files · +180 −42 · 2 not pushed" */
export function recapText(r) {
  return [
    r.commits ? plural(r.commits, 'commit') : null,
    plural(r.files, 'file'),
    r.insertions || r.deletions ? `+${r.insertions} −${r.deletions}` : null,
    r.unpushed ? `${r.unpushed} not pushed` : r.unpushed === 0 && r.commits ? 'pushed' : null,
  ].filter(Boolean).join(' · ')
}

export function RecapLine({ recap, session }) {
  return html`<button class="recap" onClick=${() => navigate(sessionPath(session, 'changes'))} title="See what changed">
    <${Icon} name="branch" size=${13} /><span>${recapText(recap)}</span>
  </button>`
}

const CODE = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed', '??': 'new' }

export function Changes({ s }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const load = () => api('GET', `/api/changes/${encodeURIComponent(s.name)}`).then(r => { setData(r.changes ?? false); setError(null) }, e => setError(e.message))
  // Load again when a turn ends, since that's when things change.
  useEffect(() => { load() }, [s.name, s.status])

  if (error && !data) return html`<div class="empty">Couldn't read the repository: ${error}</div>`
  if (data === null) return html`<div class="empty">Loading…</div>`
  if (data === false) return html`<div class="empty"><span class="mono">${s.cwd}</span> isn't in a git repository, so there are no changes to show.</div>`

  const { branch, upstream, ahead, behind, files, commits } = data
  const unpushed = upstream ? ahead : commits.length
  const ask = text => {
    sendNow(s.name, text)
    navigate(sessionPath(s.name), { replace: true })
  }
  const push = upstream
    ? ahead ? html`<span class="warn">${plural(ahead, 'commit')} not pushed to ${upstream}</span>` : html`<span>up to date with ${upstream}</span>`
    : html`<span class="warn">no upstream branch</span>`

  return html`<div class="thread"><div class="changes">
    <div class="changes-head">
      <div class="branch"><${Icon} name="branch" size=${15} /><span class="mono">${branch ?? 'detached HEAD'}</span></div>
      <div class="push">${push}${behind ? html`<span>, ${behind} behind</span>` : ''}</div>
      <button class="btn ghost sm icon-only" aria-label="Refresh" title="Refresh" onClick=${load}><${Icon} name="restart" /></button>
    </div>

    <div class="changes-actions">
      ${(unpushed > 0 || files.length > 0) && html`<button class="btn sm" onClick=${() => ask('Run the tests, then commit anything left and push if they pass.')}>Push when tests pass</button>`}
      <button class="btn sm" onClick=${() => ask('Explain the changes you have made so far, briefly.')}>Explain these changes</button>
      <button class="btn sm" onClick=${() => ask("What's left to do?")}>What's left?</button>
    </div>

    <section class="changes-section">
      <div class="section-head"><span class="label">Not committed</span><span class="count">${files.length}</span><span class="rule"></span></div>
      ${files.length === 0
        ? html`<div class="quiet">Nothing uncommitted.</div>`
        : html`<${Expandable} session=${s.name} label=${html`<span class="file-list">${files.slice(0, 8).map(f => html`<span key=${f.path}><span class=${`code c-${f.code === '??' ? 'new' : f.code}`}>${CODE[f.code] ?? f.code}</span> <span class="mono">${f.path}</span></span>`)}${files.length > 8 ? html`<span class="quiet">and ${files.length - 8} more</span>` : ''}</span>`} />`}
    </section>

    <section class="changes-section">
      <div class="section-head"><span class="label">Commits</span><span class="count">${commits.length}</span><span class="rule"></span></div>
      ${commits.length === 0 && html`<div class="quiet">No commits yet.</div>`}
      ${commits.map(c => html`<${Expandable} key=${c.sha} session=${s.name} refId=${c.sha} label=${html`<span class="commit">
        <span class="subject">${c.subject}</span>
        <span class="meta"><span class="mono">${c.short}</span> · ${ago(c.ts)}${c.pushed === false ? html` · <span class="warn">not pushed</span>` : ''}</span>
      </span>`} />`)}
    </section>
  </div></div>`
}

/** A row that opens to show its diff, fetched the first time it opens. */
function Expandable({ session, refId, label }) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState(null)
  const toggle = () => {
    setOpen(!open)
    if (!diff) {
      const q = refId ? `?ref=${refId}` : ''
      api('GET', `/api/changes/${encodeURIComponent(session)}/diff${q}`).then(setDiff, e => setDiff({ diff: '', error: e.message }))
    }
  }
  return html`<div class=${`expandable ${open ? 'open' : ''}`}>
    <button class="row" aria-expanded=${open} onClick=${toggle}>
      <span class="chev"><${Icon} name="next" size=${14} /></span>${label}
    </button>
    ${open && (diff ? html`<${Diff} d=${diff} />` : html`<div class="quiet pad">Loading…</div>`)}
  </div>`
}

/** Split a unified diff into files, each with its lines classified. */
export function parseDiff(text) {
  const files = []
  let f = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line)
      f = { path: m ? m[1] : line.slice(11), lines: [], add: 0, del: 0, binary: false }
      files.push(f)
      continue
    }
    if (!f) continue
    if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') f.path = line.slice(4).replace(/^b\//, '')
      continue
    }
    if (line.startsWith('--- ') || /^(index|similarity|rename|new file|deleted file|old mode|new mode) /.test(line)) continue
    if (line.startsWith('Binary files')) { f.binary = true; continue }
    if (line.startsWith('@@')) f.lines.push({ k: 'hunk', t: line.replace(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?/, 'line $1 ') })
    else if (line.startsWith('+')) { f.add++; f.lines.push({ k: 'add', t: line.slice(1) }) }
    else if (line.startsWith('-')) { f.del++; f.lines.push({ k: 'del', t: line.slice(1) }) }
    else if (line.startsWith('\\')) continue // "\ No newline at end of file"
    else f.lines.push({ k: 'ctx', t: line.slice(1) })
  }
  return files
}

function Diff({ d }) {
  if (d.error) return html`<div class="quiet pad">Couldn't load the diff: ${d.error}</div>`
  const files = parseDiff(d.diff)
  if (!files.length) return html`<div class="quiet pad">No changes to show.</div>`
  return html`<div class="diff">
    ${files.map(f => html`<details class="diff-file" open=${files.length <= 3} key=${f.path}>
      <summary><span class="mono path">${f.path}</span><span class="stat"><span class="a">+${f.add}</span> <span class="d">−${f.del}</span></span></summary>
      ${f.binary ? html`<div class="quiet pad">Binary file</div>` : html`<div class="diff-lines">
        ${f.lines.map((l, i) => html`<div class=${`dl ${l.k}`} key=${i}>${l.t || ' '}</div>`)}
      </div>`}
    </details>`)}
    ${d.truncated && html`<div class="quiet pad">The diff is too long to show in full.</div>`}
  </div>`
}
