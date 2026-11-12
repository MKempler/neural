// Home: what needs you, every session at a glance, and recent activity.
import { useEffect, useState } from 'preact/hooks'
import { html, ago, clock, plain, excerpt, shortPath, fmtNumber } from '../lib.js'
import { Icon } from '../icons.js'
import { Composer, Dot, PermissionCard, StatusPill, Link } from '../components/parts.js'
import { NotifySetup } from '../push.js'
import {
  user, sessions, sessionList, permissions, recent, health, orchestrator, newSessionOpen,
  navigate, send, sessionPath, sessionAction, totalUnread,
} from '../store.js'

export function Home() {
  const list = sessionList.value
  const name = user.value.name
  const perms = permissions.value
  const troubled = list.filter(s => ['attention', 'exited'].includes(s.status) || (s.status === 'blocked' && !perms.some(p => p.session === s.name)))
  const unread = list.filter(s => s.unread > 0 && (s.last_reply ?? s.last_message))
  const needs = perms.length + troubled.length + unread.length
  const main = orchestrator.value

  return html`<div class="scroll"><div class="page">
    <header class="greeting">
      <h1>${name ? `Welcome back, ${name}` : 'Welcome back'}</h1>
      <${StatusLine} needs=${needs} />
    </header>

    ${main && html`<${Composer} variant="quick" draftKey="home" placeholder=${`Message ${main.name}…`}
      hint=${html`<span class="to">→ ${main.name}</span>`}
      onSend=${async (body, files) => { await send(main.name, body, files); navigate(sessionPath(main.name)) }} />`}

    ${needs > 0 && html`<section class="section" aria-labelledby="needs">
      <div class="section-head"><span class="label" id="needs">Needs you</span><span class="count">${needs}</span><span class="rule"></span></div>
      <div class="attention">
        ${perms.map(p => html`<${PermissionCard} p=${p} key=${`p${p.id}`} />`)}
        ${troubled.map(s => html`<${Trouble} s=${s} key=${`t${s.name}`} />`)}
        ${unread.map(s => html`<div class="alert info clickable compact" key=${`u${s.name}`} onClick=${() => navigate(sessionPath(s.name))}>
          <${Dot} status="working" />
          <div class="truncate"><span class="who">${s.name}</span> <span class="what">${excerpt(s.last_reply ?? s.last_message)}</span></div>
          <div class="actions"><span class="badge">${s.unread}</span></div>
        </div>`)}
      </div>
    </section>`}

    <section class="section" aria-labelledby="sessions-h">
      <div class="section-head"><span class="label" id="sessions-h">Sessions</span><span class="count">${list.length}</span><span class="rule"></span></div>
      <div class="grid">
        ${list.map(s => html`<${SessionCard} s=${s} key=${s.name} />`)}
        <button class="card new" onClick=${() => (newSessionOpen.value = true)}><${Icon} name="plus" />New session</button>
      </div>
    </section>

    <${Activity} />
    <${NotifySetup} />
  </div></div>`
}

function StatusLine({ needs }) {
  const list = sessionList.value
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  const working = list.filter(s => s.status === 'working').length
  const down = list.filter(s => ['exited', 'attention'].includes(s.status)).length
  const chunks = health.value.semantic?.chunks
  const date = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
  return html`<div class="status-line">
    <span>${date} · ${clock(now.toISOString())}</span>
    <span>${list.length} ${list.length === 1 ? 'session' : 'sessions'}${working ? html` · <span class="ok">${working} working</span>` : ''}</span>
    <span>${needs ? html`<span class="warn">${needs} need${needs === 1 ? 's' : ''} you</span>` : down ? html`<span class="warn">${down} down</span>` : html`<span class="ok">all clear</span>`}</span>
    ${chunks > 0 && html`<span>${fmtNumber(chunks)} memories indexed</span>`}
  </div>`
}

function Trouble({ s }) {
  const [busy, setBusy] = useState(false)
  const restart = async e => {
    e.stopPropagation()
    setBusy(true)
    await sessionAction(s.name, 'restart').catch(err => alert(err.message))
    setBusy(false)
  }
  const label = s.status === 'exited' ? 'stopped unexpectedly' : s.status === 'blocked' ? 'is waiting in its terminal' : 'needs attention'
  return html`<div class=${`alert ${s.status === 'exited' ? 'bad' : ''}`}>
    <${Dot} status=${s.status} />
    <div class="truncate"><${Link} href=${sessionPath(s.name)} class="who">${s.name}</${Link}> <span class="what">${label}</span></div>
    <div class="actions">
      <button class="btn sm" onClick=${() => navigate(sessionPath(s.name, 'terminal'))}><${Icon} name="terminal" />Terminal</button>
      <button class="btn sm" disabled=${busy} onClick=${restart}><${Icon} name="restart" />${s.status === 'exited' ? 'Start' : 'Restart'}</button>
    </div>
    ${s.status_detail && html`<pre class="detail">${s.status_detail}</pre>`}
  </div>`
}

export function SessionCard({ s }) {
  const m = s.last_message
  const from = m ? (m.from_name === 'user' ? 'you' : m.from_name === s.name ? '' : m.from_name) : ''
  return html`<div class="card" role="link" tabindex="0" onClick=${() => navigate(sessionPath(s.name))}
      onKeyDown=${e => e.key === 'Enter' && navigate(sessionPath(s.name))} aria-label=${`Open ${s.name}`}>
    <div class="card-top"><span class="card-name">${s.name}</span><${StatusPill} status=${s.status} /></div>
    <div class="card-meta">
      ${s.role === 'orchestrator' && html`<span class="tag accent">orchestrator</span>`}
      <span class="cwd" title=${s.cwd}>${shortPath(s.cwd)}</span>
    </div>
    <p class="card-excerpt">${m ? html`${from && html`<span class="from">${from}: </span>`}${excerpt(m)}` : html`<span class="muted">No messages yet</span>`}</p>
    <div class="card-foot">
      <span>${m ? ago(m.ts) : ago(s.created_at)}</span>
      ${!s.channel_connected && !['stopped', 'exited'].includes(s.status) && html`<span>· channel down</span>`}
      ${s.unread > 0 && html`<span class="badge">${s.unread}</span>`}
    </div>
    <div class="card-actions">
      <button class="btn sm" onClick=${e => { e.stopPropagation(); navigate(sessionPath(s.name, 'terminal')) }}><${Icon} name="terminal" />Terminal</button>
    </div>
  </div>`
}

function Activity() {
  const rows = recent.value.slice(-12).reverse()
  if (!rows.length) return null
  return html`<section class="section" aria-labelledby="activity-h">
    <div class="section-head"><span class="label" id="activity-h">Recent activity</span><span class="rule"></span>
      <${Link} href="/timeline" class="btn ghost sm">Timeline<${Icon} name="arrow" /></${Link}></div>
    <div class="feed">
      ${rows.map(m => {
        const target = m.from_name === 'user' ? m.to_name : m.from_name
        const go = sessions.value[target] ? () => navigate(sessionPath(target)) : undefined
        return html`<button class="feed-row" key=${m.id} onClick=${go}>
          <span class="t">${clock(m.ts)}</span>
          <span class="route">${m.from_name === 'user' ? 'you' : m.from_name}<span class="arrow">→</span>${m.to_name === 'user' ? 'you' : m.to_name}</span>
          <span class="body">${excerpt(m)}</span>
        </button>`
      })}
    </div>
  </section>`
}

/** Phone list of sessions (the Sessions tab). */
export function Sessions() {
  const list = sessionList.value
  return html`<div class="scroll"><div class="page">
    <div class="page-head"><h1>Sessions</h1><span class="label">${list.length} · ${totalUnread.value} unread</span></div>
    <div class="grid">
      ${list.map(s => html`<${SessionCard} s=${s} key=${s.name} />`)}
      <button class="card new" onClick=${() => (newSessionOpen.value = true)}><${Icon} name="plus" />New session</button>
    </div>
  </div></div>`
}
