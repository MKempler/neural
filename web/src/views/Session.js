// One session: conversation, live terminal and activity log.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { html, api, clock, dayLabel, tilde, shortPath, local, unmark, modelChip, isCommand, opensPicker } from '../lib.js'
import { Icon } from '../icons.js'
import { Dot, Menu, PermissionCard, StatusPill } from '../components/parts.js'
import { Composer, DropZone } from '../components/Composer.js'
import { Message, ActivityLine } from '../components/Message.js'
import { Terminal } from '../components/Terminal.js'
import {
  sessions, threads, permissions, route, navigate, sessionPath, loadThread, loadOlder,
  sessionAction, removeSession, readLatest, pendingSends, sendNow, interrupt, switcherOpen, modelSheet,
} from '../store.js'

const TABS = [['chat', 'Conversation', 'chat'], ['terminal', 'Terminal', 'terminal'], ['activity', 'Activity', 'activity']]

export function Session() {
  const { name, tab } = route.value
  const s = sessions.value[name]
  const [split, setSplit] = useState(local.get('neural.split', false))
  const wide = useMedia('(min-width: 1180px)')
  const phone = useMedia('(max-width: 860px)')

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
  const showNotice = s.status_detail && (['attention', 'exited', 'limited'].includes(s.status) || (s.status === 'blocked' && perms.length === 0))

  const menu = [
    phone && tab !== 'activity' && { label: 'Activity log', icon: 'activity', run: () => setTab('activity') },
    phone && tab !== 'chat' && { label: 'Conversation', icon: 'chat', run: () => setTab('chat') },
    { label: 'Model and effort', icon: 'settings', run: () => (modelSheet.value = name) },
    phone && '-',
    { label: down ? 'Start' : 'Restart', icon: 'restart', run: () => sessionAction(name, 'restart').catch(e => alert(e.message)) },
    !down && { label: 'Stop session', icon: 'stop', run: () => confirm(`Stop ${name}? Its conversation is kept and it can be started again.`) && sessionAction(name, 'stop').catch(e => alert(e.message)) },
    '-',
    { label: 'Remove from Neural', icon: 'trash', danger: true, run: async () => {
      if (!confirm(`Remove ${name}? This stops it and removes it from the list. Its messages stay in history.`)) return
      await removeSession(name).catch(e => alert(e.message))
      navigate('/')
    } },
  ]

  const back = () => (history.length > 1 ? history.back() : navigate('/'))
  const chip = modelChip(s)
  const subtitle = tab === 'terminal' ? 'terminal' : tab === 'activity' ? 'activity log' : [chip, shortPath(s.cwd, 30)].filter(Boolean).join(' · ')

  return html`<section class="session">
    ${phone
      ? html`<header class="session-head compact">
          <button class="btn ghost icon-only" aria-label="Back" onClick=${back}><${Icon} name="back" /></button>
          <button class="title-btn" onClick=${() => (switcherOpen.value = true)} aria-label=${`${name}, ${s.status}. Switch session`}>
            <span class="name"><${Dot} status=${s.status} />${name}</span>
            <span class="sub">${subtitle}${!s.channel_connected && !down ? ' · channel down' : ''}</span>
          </button>
          <button class=${`btn ghost icon-only ${tab === 'terminal' ? 'active' : ''}`} aria-label=${tab === 'terminal' ? 'Show conversation' : 'Show terminal'}
            aria-pressed=${tab === 'terminal'} onClick=${() => setTab(tab === 'terminal' ? 'chat' : 'terminal')}><${Icon} name="terminal" /></button>
          <${Menu} label="Session actions" items=${menu} />
        </header>`
      : html`<header class="session-head">
          <div class="title">
            <h1>${name} <${StatusPill} status=${s.status} /></h1>
            <div class="meta">
              ${s.role === 'orchestrator' && html`<span>orchestrator</span>`}
              ${chip && html`<button class="model-chip" title="Change model or effort" onClick=${() => (modelSheet.value = name)}>${chip}</button>`}
              <span title=${s.cwd}>${tilde(s.cwd)}</span>
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
        </header>`}

    ${showNotice && html`<div class=${`notice ${s.status === 'exited' ? 'bad' : ''}`}><pre>${s.status_detail}</pre></div>`}
    ${perms.length > 0 && html`<div class="inline-perms">${perms.map(p => html`<${PermissionCard} p=${p} showSession=${false} key=${p.id} />`)}</div>`}

    <div class=${`panes ${splitting ? 'split' : ''}`}>
      ${tab === 'chat' && html`<div class="pane"><${Conversation} s=${s} /></div>`}
      ${(tab === 'terminal' || splitting) && html`<div class="pane"><${Terminal} name=${name} key=${name} /></div>`}
      ${tab === 'activity' && html`<div class="pane"><${ActivityLog} name=${name} status=${s.status} /></div>`}
    </div>
  </section>`
}

function useMedia(query) {
  const [match, setMatch] = useState(matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setMatch(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return match
}

function Conversation({ s }) {
  const rows = threads.value[s.name]
  const pending = pendingSends.value.filter(p => p.to_name === s.name)
  const box = useRef(null)
  const composer = useRef(null)
  const stick = useRef(true)
  const [more, setMore] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const lastCount = useRef(0)
  const total = (rows?.length ?? 0) + pending.length

  const toBottom = (smooth = false) => {
    const el = box.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }
  // Stay pinned to the newest message unless the reader has scrolled up; count what arrives meanwhile.
  useLayoutEffect(() => {
    const grew = total > lastCount.current
    if (stick.current) toBottom()
    else if (grew && lastCount.current) setUnseen(n => n + (total - lastCount.current))
    lastCount.current = total
  }, [total, s.name])
  useLayoutEffect(() => {
    stick.current = true
    setUnseen(0)
    lastCount.current = 0
    toBottom()
  }, [s.name])
  // The keyboard opening or closing resizes the thread; keep the bottom in view if that's where we were.
  useEffect(() => {
    const el = box.current
    if (!el || !window.ResizeObserver) return
    const ro = new ResizeObserver(() => stick.current && toBottom())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = e => {
    const el = e.currentTarget
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (stick.current && unseen) setUnseen(0)
  }
  // Dragging the conversation puts the keyboard away, as in Messages and ChatGPT.
  const touchY = useRef(null)
  const onTouchStart = e => (touchY.current = e.touches[0].clientY)
  const onTouchMove = e => {
    if (touchY.current === null) return
    if (Math.abs(e.touches[0].clientY - touchY.current) > 24 && document.activeElement?.tagName === 'TEXTAREA') {
      document.activeElement.blur()
      touchY.current = null
    }
  }
  const older = async () => {
    const el = box.current
    const before = el.scrollHeight
    stick.current = false
    const n = await loadOlder(s.name)
    if (n < 100) setMore(false)
    requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - before))
  }
  const quote = text => composer.current?.insert(text)
  const send = (body, ids, previews) => {
    sendNow(s.name, body, ids, previews)
    // A command that opens a picker (plain /model, /effort, …) is answered in the terminal, so show it.
    if (!ids.length && isCommand(body) && opensPicker(body)) navigate(sessionPath(s.name, 'terminal'), { replace: true })
    stick.current = true
    requestAnimationFrame(() => toBottom(true))
  }

  const down = ['stopped', 'exited'].includes(s.status) || !s.channel_connected
  const items = []
  let lastDay = ''
  let prev = null
  for (const m of [...(rows ?? []), ...pending]) {
    const day = dayLabel(m.ts)
    if (day !== lastDay) {
      items.push(html`<div class="day" key=${`d${m.id ?? m.key}`}>${day}</div>`)
      lastDay = day
      prev = null
    }
    const continued = prev && prev.from_name === m.from_name && prev.to_name === m.to_name && Date.parse(m.ts) - Date.parse(prev.ts) < 5 * 60_000
    items.push(html`<${Message} m=${m} context=${s.name} continued=${continued} onQuote=${quote} key=${m.key ?? m.id} />`)
    prev = m
  }

  return html`<${DropZone} class="conversation" onFiles=${files => composer.current?.addFiles(files)} label=${`Drop to send to ${s.name}`}>
    <div class="thread" ref=${box} onScroll=${onScroll} onTouchStart=${onTouchStart} onTouchMove=${onTouchMove}>
      <div class="thread-inner">
        ${rows && rows.length >= 200 && more && html`<button class="btn ghost sm load-more" onClick=${older}>Load earlier messages</button>`}
        ${rows === undefined ? html`<div class="empty">Loading…</div>`
          : items.length === 0 ? html`<div class="empty">No messages yet. Say something to <span class="mono">${s.name}</span>.</div>`
          : items}
        <${ActivityLine} s=${s} />
      </div>
    </div>
    ${unseen > 0 && html`<button class="jump" onClick=${() => { stick.current = true; setUnseen(0); toBottom(true) }}>
      <${Icon} name="down" size=${14} />${unseen} new</button>`}
    <div class="composer-wrap">
      <${Composer} placeholder=${`Message ${s.name}`} autofocus=${true} draftKey=${s.name} onSend=${send}
        onReady=${apiRef => (composer.current = apiRef)}
        stoppable=${s.status === 'working'} onStop=${() => interrupt(s.name).catch(e => alert(e.message))} />
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
