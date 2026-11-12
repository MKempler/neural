// Notifications: service worker registration, subscribing this device, and the Home setup card.
import { signal } from '@preact/signals'
import { html, api, local } from './lib.js'
import { Icon } from './icons.js'
import { navigate, sessionPath } from './store.js'

// unsupported | needs-install | blocked | off | on
export const pushState = signal('unsupported')
let registration = null

const b64ToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const iOS = /iPhone|iPad/.test(navigator.userAgent)

export async function setupPush() {
  if (!('serviceWorker' in navigator)) return
  registration = await navigator.serviceWorker.register('/sw.js')
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'open' && e.data.session) navigate(sessionPath(e.data.session))
  })
  if (!('PushManager' in window) || !('Notification' in window)) {
    // On iPhone, push only exists once the page is installed on the Home Screen.
    if (iOS && !navigator.standalone) pushState.value = 'needs-install'
    return
  }
  await refresh()
}

async function refresh() {
  const sub = await registration.pushManager.getSubscription()
  pushState.value = Notification.permission === 'denied' ? 'blocked' : sub ? 'on' : 'off'
  // Browsers rotate subscriptions; keep the server's copy current.
  if (sub) api('POST', '/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {})
}

export async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') return refresh()
  const { publicKey } = await api('GET', '/api/push')
  const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) })
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() })
  await refresh()
  await api('POST', '/api/push/test')
}

export async function testPush() {
  const { sent } = await api('POST', '/api/push/test')
  if (!sent) alert('The notification could not be delivered to this device. Try turning notifications off and on in the browser settings.')
}

const dismissed = signal(local.get('neural.pushCardDismissed', false))

/** Shown on Home until notifications are on for this device (or dismissed). */
export function NotifySetup() {
  const state = pushState.value
  if (dismissed.value || state === 'on' || state === 'unsupported') return null
  const dismiss = () => {
    dismissed.value = true
    local.set('neural.pushCardDismissed', true)
  }
  const text = {
    'needs-install': 'To get notifications on this iPhone, add Neural to the Home Screen (Share, then Add to Home Screen) and open it from there.',
    blocked: 'Notifications are blocked for this site in the browser settings.',
    off: 'Get a notification on this device when a session answers, needs approval, or stops.',
  }[state]
  return html`<div class="setup">
    <${Icon} name="bell" />
    <span class="grow">${text}</span>
    ${state === 'off' && html`<button class="btn primary sm" onClick=${() => enablePush().catch(e => alert(e.message))}>Turn on</button>`}
    <button class="btn ghost sm" onClick=${dismiss}>Not now</button>
  </div>`
}
