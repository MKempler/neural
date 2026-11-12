// Fit the app to the part of the screen that is actually visible. iPhone home-screen apps don't report a
// usable 100vh, and the on-screen keyboard shrinks the visible area without resizing the layout; the
// visual viewport tracks both. Also marks the page while the keyboard is open.
import { signal } from '@preact/signals'

export const viewportInfo = signal('')
const root = document.documentElement
const vv = window.visualViewport

function fit() {
  const h = vv ? vv.height : window.innerHeight
  const top = vv ? vv.offsetTop : 0
  root.style.setProperty('--app-h', `${Math.round(h)}px`)
  root.style.setProperty('--app-top', `${Math.round(top)}px`)
  root.classList.toggle('keyboard', window.innerHeight - h > 120)
  // Keep the page itself from scrolling under the fixed app when iOS nudges it.
  if (!vv || vv.offsetTop === 0) window.scrollTo(0, 0)
  if (viewportInfo.value) viewportInfo.value = describe()
}

/** Numbers for diagnosing layout on a device: tap the connection dot on a phone to show them. */
export function describe() {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);visibility:hidden'
  document.body.append(probe)
  const cs = getComputedStyle(probe)
  const safe = `${cs.paddingTop} / ${cs.paddingBottom}`
  probe.remove()
  const app = document.querySelector('.app')?.getBoundingClientRect()
  return [
    `screen        ${screen.width}×${screen.height}`,
    `window inner  ${innerWidth}×${innerHeight}`,
    `visual vp     ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} top ${Math.round(vv.offsetTop)}` : 'n/a'}`,
    `app box       ${app ? `${Math.round(app.top)}..${Math.round(app.bottom)}` : 'n/a'}`,
    `safe area     ${safe} (top / bottom)`,
    `standalone    ${Boolean(navigator.standalone || matchMedia('(display-mode: standalone)').matches)}`,
    `user agent    ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90)}`,
  ].join('\n')
}

export function toggleViewportInfo() {
  viewportInfo.value = viewportInfo.value ? '' : describe()
}

fit()
vv?.addEventListener('resize', fit)
vv?.addEventListener('scroll', fit)
addEventListener('resize', fit)
addEventListener('orientationchange', () => setTimeout(fit, 300))
