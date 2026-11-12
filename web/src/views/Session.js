// One session: conversation, live terminal and activity log.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { html, api, clock, dayLabel, tilde, shortPath, local, unmark } from '../lib.js'
import { Icon } from '../icons.js'
import { Composer, DropZone, Message, Menu, PermissionCard, StatusPill } from '../components/parts.js'
import { Terminal } from '../components/Terminal.js'
import {
  sessions, threads, permissions, route, navigate, sessionPath, loadThread, loadOlder, send,
  sessionAction, removeSession, readLatest,
} from '../store.js'

const TABS = [['chat', 'Conversation', 'chat'], ['terminal', 'Terminal', 'terminal'], ['activity', 'Activity', 'activity']]

export function Session() {
  const { name, tab } = route.value
  const s = sessions.value[name]
  const [split, setSplit] = useState(local.get('neural.split', false))
  const wide = useWide()

  useEffect(() => {
    if (!threads.value[name]) loadThread(name).catch(() => {})
  }, [name])
  useEffect(() => {
    if (tab !== 'activity') readLatest(name)
  }, [name, tab, s?.last_message?.id])

  if (!s) {
    return html`<div class="scroll"><div class="page narrow"><div class="empty">
      There is no session called <span class="mono">${name}</span>.<br /><br />
      <button class="btn" onClick=${() => navigate('/')}>Back home</button>
    </div></div></div>`
  }

  const setTab = t => navigate(sessionPath(name, t), { replace: true })
  const toggleSplit = () => {
    local.set('neural.split', !split)
    setSplit(!split)
    if (!split && tab !== 'chat') setTab('chat')
  }
  const splitting = split && wide && tab === 'chat'
  const down = ['stopped', 'exited'].includes(s.status)
  const perms = permissions.value.filter(p => p.session === name)
  const showNotice = s.status_detail && (['attention', 'exited'].includes(s.status) || (s.status === 'blocked' && perms.length === 0))

  const menu = [
    { label: down ? 'Start' : 'Restart', icon: 'restart', run: () => sessionAction(name, 'restart').catch(e => alert(e.message)) },
    !down && { label: 'Stop', icon: 'stop', run: () => confirm(`Stop ${name}? Its conversation is kept and it can be started again.`) && sessionAction(name, 'stop').catch(e => alert(e.message)) },
    '-',
    { label: 'Remove from Neural', icon: 'trash', danger: true, run: async () => {
      if (!confirm(`Remove ${name}? This stops it and removes it from the list. Its messages stay in history.`)) return
      await removeSession(name).catch(e => alert(e.message))
      navigate('/')
    } },
  ]

  return html`<section class="session">
    <header class="session-head">
      <button class="btn ghost icon-only back" aria-label="Back" onClick=${() => (history.length > 1 ? history.back() : navigate('/'))}><${Icon} name="back" /></button>
      <div class="title">
        <h1>${name} <${StatusPill} status=${s.status} /></h1>
        <div class="meta">
          ${s.role === 'orchestrator' && html`<span>orchestrator</span>`}
          <span title=${s.cwd}>${wide ? tilde(s.cwd) : shortPath(s.cwd, 40)}</span>
          ${!s.channel_connected && !down && html`<span>channel down</span>`}
        </div>
      </div>
      <div class="tools">
        <div class="tabs" role="tablist">
          ${TABS.map(([id, label, icon]) => html`<button role="tab" class=${`tab ${tab === id ? 'active' : ''}`} aria-selected=${tab === id}
            onClick=${() => setTab(id)}><${Icon} name=${icon} />${label}</button>`)}
        </div>
        ${wide && html`<button class=${`btn ghost icon-only split-toggle ${splitting ? 'active' : ''}`} title="Conversation and terminal side by side"
          aria-pressed=${splitting} onClick=${toggleSplit}><${Icon} name="split" /></button>`}
        <${Menu} label="Session actions" items=${menu} />
      </div>
    </header>

    ${showNotice && html`<div class=${`notice ${s.status === 'exited' ? 'bad' : ''}`}><pre>${s.status_detail}</pre></div>`}
    ${perms.length > 0 && html`<div class="inline-perms">${perms.map(p => html`<${PermissionCard} p=${p} showSession=${false} key=${p.id} />`)}</div>`}

    <div class=${`panes ${splitting ? 'split' : ''}`}>
      ${tab === 'chat' && html`<div class="pane"><${Conversation} s=${s} /></div>`}
      ${(tab === 'terminal' || splitting) && html`<div class="pane"><${Terminal} name=${name} key=${name} /></div>`}
      ${tab === 'activity' && html`<div class="pane"><${ActivityLog} name=${name} status=${s.status} /></div>`}
    </div>
  </section>`
}

function useWide() {
  const query = '(min-width: 1180px)'
  const [wide, setWide] = useState(matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

function Conversation({ s }) {
  const rows = threads.value[s.name]
  const box = useRef(null)
  const addFiles = useRef(null)
  const stick = useRef(true)
  const [more, setMore] = useState(true)

  // Stay pinned to the newest message unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [rows?.length, s.name])
  const onScroll = e => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  const older = async () => {
    const el = box.current
    const before = el.scrollHeight
    stick.current = false
    const n = await loadOlder(s.name)
    if (n < 100) setMore(false)
    requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - before))
  }

  const down = ['stopped', 'exited'].includes(s.status) || !s.channel_connected
  const items = []
  let lastDay = ''
  let prev = null
  for (const m of rows ?? []) {
    const day = dayLabel(m.ts)
    if (day !== lastDay) {
      items.push(html`<div class="day" key=${`d${m.id}`}>${day}</div>`)
      lastDay = day
      prev = null
    }
    const continued = prev && prev.from_name === m.from_name && prev.to_name === m.to_name && Date.parse(m.ts) - Date.parse(prev.ts) < 5 * 60_000
    items.push(html`<${Message} m=${m} context=${s.name} continued=${continued} key=${m.id} />`)
    prev = m
  }

  return html`<${DropZone} class="conversation" onFiles=${files => addFiles.current?.(files)} label=${`Drop to send to ${s.name}`}>
    <div class="thread" ref=${box} onScroll=${onScroll}>
      <div class="thread-inner">
        ${rows && rows.length >= 200 && more && html`<button class="btn ghost sm load-more" onClick=${older}>Load earlier messages</button>`}
        ${rows === undefined ? html`<div class="empty">Loading…</div>`
          : rows.length === 0 ? html`<div class="empty">No messages yet. Say something to <span class="mono">${s.name}</span>.</div>`
          : items}
      </div>
    </div>
    <div class="composer-wrap">
      <${Composer} placeholder=${`Message ${s.name}`} autofocus=${true} onSend=${(body, files) => send(s.name, body, files)}
        registerDrop=${add => (addFiles.current = add)} />
      <div class="composer-hint">
        <span>↵ send · ⇧↵ new line · paste or drop files to attach</span>
        ${down && html`<span class="warn">${s.name} isn't connected; messages wait and are delivered when it is back</span>`}
      </div>
    </div>
  </${DropZone}>`
}

const EVENT_TEXT = {
  'hook:SessionStart': 'Session started',
  'hook:UserPromptSubmit': 'Turn started',
  'hook:Stop': 'Turn finished',
  'hook:Notification': 'Waiting on the user',
  'hook:SessionEnd': 'Session ended',
  'hook:PreCompact': 'Compacting context',
  'channel-connected': 'Channel connected',
  'channel-disconnected': 'Channel disconnected',
  spawn: 'Launched',
  dialog: 'Answered a startup prompt',
  exited: 'Process exited',
  'startup-timeout': 'Startup stalled',
  'fallback-paste': 'Message typed into the terminal',
  'fallback-failed': 'Fallback delivery failed',
  'restart-failed': 'Restart failed',
}

function detail(e) {
  let p
  try {
    p = JSON.parse(e.payload)
  } catch {
    return ''
  }
  if (!p) return ''
  if (e.event === 'hook:UserPromptSubmit') return unmark(String(p.prompt ?? '').replace(/<[^>]+>/g, ' '))
  if (e.event === 'hook:Stop') return unmark(String(p.last_assistant_message ?? ''))
  if (e.event === 'hook:Notification') return p.message ?? ''
  if (e.event === 'hook:SessionStart') return p.source ?? ''
  if (e.event === 'hook:SessionEnd') return p.reason ?? ''
  if (e.event === 'dialog') return p.dialog ?? ''
  if (e.event === 'spawn') return p.resume ? 'resuming its conversation' : 'new conversation'
  if (p.message_id) return `message ${p.message_id}`
  return p.error ?? ''
}

function ActivityLog({ name, status }) {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    api('GET', `/api/events/${encodeURIComponent(name)}`).then(setRows, () => setRows([]))
  }, [name, status])
  if (!rows) return html`<div class="empty">Loading…</div>`
  if (!rows.length) return html`<div class="empty">Nothing recorded yet.</div>`
  return html`<div class="thread"><div class="log">
    ${rows.map(e => html`<div class="log-row" key=${e.id}>
      <span class="t" title=${new Date(e.ts).toLocaleString()}>${dayLabel(e.ts) === 'Today' ? clock(e.ts) : `${dayLabel(e.ts).split(' ').slice(0, 2).join(' ')}`}</span>
      <span class="e">${EVENT_TEXT[e.event] ?? e.event}</span>
      <span class="d" title=${detail(e)}>${detail(e)}</span>
    </div>`)}
  </div></div>`
}
