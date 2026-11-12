import { render } from 'preact'
import { useEffect } from 'preact/hooks'
import { html } from './lib.js'
import { Rail, TopBar, TabBar, Strip } from './components/shell.js'
import { Palette, NewSession, Lightbox } from './components/overlays.js'
import { Home, Sessions } from './views/Home.js'
import { Session } from './views/Session.js'
import { Timeline, Search } from './views/Lists.js'
import { setupPush } from './push.js'
import { connect, loaded, route, paletteOpen, totalUnread } from './store.js'

function App() {
  const r = route.value

  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        paletteOpen.value = !paletteOpen.value
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const n = totalUnread.value
    document.title = n ? `(${n}) Neural` : 'Neural'
  }, [totalUnread.value])

  const view = !loaded.value ? html`<div class="scroll"><div class="empty">Connecting…</div></div>`
    : r.view === 'session' ? html`<${Session} key=${r.name} />`
    : r.view === 'timeline' ? html`<${Timeline} />`
    : r.view === 'search' ? html`<${Search} key=${r.q} />`
    : r.view === 'sessions' ? html`<${Sessions} />`
    : html`<${Home} />`

  const inSession = r.view === 'session'
  return html`<div class=${`app ${inSession ? 'in-session' : ''}`}>
    <${Rail} />
    <main class="main">
      ${!inSession && html`<${TopBar} />`}
      <${Strip} />
      ${view}
      ${!inSession && html`<${TabBar} />`}
    </main>
    <${Palette} />
    <${NewSession} />
    <${Lightbox} />
  </div>`
}

render(html`<${App} />`, document.getElementById('root'))
connect()
setupPush().catch(() => {})
