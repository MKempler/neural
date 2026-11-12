// App chrome: the rail on wide screens, the top bar and tab bar on phones, and the connection strip.
import { html } from '../lib.js'
import { Icon, Glyph } from '../icons.js'
import { Dot, Link } from './parts.js'
import {
  connected, route, sessionList, totalUnread, paletteOpen, newSessionOpen, navigate, sessionPath,
} from '../store.js'

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const hostLabel = () => (/^[\d.]+$|^localhost$/.test(location.hostname) ? 'this Mac' : location.hostname.split('.')[0])

export function Brand() {
  return html`<${Link} href="/" class="brand" aria-label="Neural home"><${Glyph} /><span class="wordmark">neural</span></${Link}>`
}

function NavItem({ href, icon, label, active, end, onClick }) {
  const cls = `nav-item ${active ? 'active' : ''}`
  const inner = html`<${Icon} name=${icon} />${label}${end && html`<span class="end">${end}</span>`}`
  return onClick
    ? html`<button class=${cls} onClick=${onClick}>${inner}</button>`
    : html`<${Link} href=${href} class=${cls} aria-current=${active ? 'page' : undefined}>${inner}</${Link}>`
}

export function Rail() {
  const r = route.value
  const list = sessionList.value
  return html`<nav class="rail" aria-label="Main">
    <${Brand} />
    <div class="nav">
      <${NavItem} href="/" icon="home" label="Home" active=${r.view === 'home'} />
      <${NavItem} href="/timeline" icon="timeline" label="Timeline" active=${r.view === 'timeline'} />
      <${NavItem} icon="search" label="Search" active=${r.view === 'search'} end=${html`<kbd>${isMac ? '⌘' : 'Ctrl '}K</kbd>`}
        onClick=${() => (paletteOpen.value = true)} />
    </div>
    <div class="rail-section"><span class="label">Sessions</span><span class="label">${list.length}</span></div>
    <div class="rail-sessions">
      ${list.map(s => html`<${Link} href=${sessionPath(s.name)}
          class=${`nav-item rail-session ${r.view === 'session' && r.name === s.name ? 'active' : ''}`}>
        <${Dot} status=${s.status} /><span class="name">${s.name}</span>
        ${s.unread > 0 && html`<span class="end badge">${s.unread}</span>`}
      </${Link}>`)}
    </div>
    <div class="rail-foot">
      <button class="btn block" onClick=${() => (newSessionOpen.value = true)}><${Icon} name="plus" />New session</button>
      <div class="conn" title=${connected.value ? 'Live connection to this Mac' : 'Reconnecting'}>
        <${Dot} status=${connected.value ? 'online' : 'offline'} />
        <span class="host">${connected.value ? hostLabel() : 'reconnecting…'}</span>
      </div>
    </div>
  </nav>`
}

export function TopBar() {
  return html`<header class="topbar">
    <${Brand} />
    <div class="end">
      <${Dot} status=${connected.value ? 'online' : 'offline'} />
    </div>
  </header>`
}

export function TabBar() {
  const r = route.value
  const tab = (icon, label, active, onClick, badge) => html`<button class=${active ? 'active' : ''} onClick=${onClick} aria-label=${label}>
    <${Icon} name=${icon} />${label}${badge > 0 && html`<span class="badge">${badge}</span>`}
  </button>`
  return html`<nav class="tabbar" aria-label="Main">
    ${tab('home', 'Home', r.view === 'home', () => navigate('/'))}
    ${tab('sessions', 'Sessions', r.view === 'sessions', () => navigate('/sessions'), totalUnread.value)}
    ${tab('search', 'Search', r.view === 'search', () => navigate('/search'))}
    ${tab('plus', 'New', false, () => (newSessionOpen.value = true))}
  </nav>`
}

export function Strip() {
  if (connected.value) return null
  return html`<div class="strip" role="status"><${Dot} status="offline" />Reconnecting to your Mac… messages you send will wait until it is back.</div>`
}
