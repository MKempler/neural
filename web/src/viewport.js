// Fit the app to the part of the screen that is actually visible. iPhone home-screen apps don't report a
// usable 100vh, and the on-screen keyboard shrinks the visible area without resizing the layout; the
// visual viewport tracks both. Also marks the page while the keyboard is open.
import { signal } from '@preact/signals'

export const viewportInfo = signal('')
const root = document.documentElement
const vv = window.visualViewport

const standalone = Boolean(navigator.standalone || matchMedia('(display-mode: standalone)').matches)
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent)

/** The physical screen height in CSS pixels for the current orientation (iOS doesn't swap screen.width/height). */
function screenHeight() {
  const portrait = matchMedia('(orientation: portrait)').matches
  return portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height)
}

let applied = 0
function fit() {
  let h = vv ? vv.height : window.innerHeight
  const top = vv ? vv.offsetTop : 0
  const keyboard = window.innerHeight - h > 120
  // An installed iPhone app with a see-through status bar is drawn from the very top of the screen, but iOS
  // reports (and paints) only the screen height minus the status bar. The strip left at the bottom can't hold
  // anything tappable, so it serves as the home-indicator area: bars drop their own bottom padding by that
  // much, and the page colour behind fills the strip.
  const short = standalone && iOS && !keyboard ? Math.max(0, screenHeight() - window.innerHeight) : 0
  root.style.setProperty('--vp-short', `${Math.round(short)}px`)
  applied = h
  root.style.setProperty('--app-h', `${Math.round(h)}px`)
  root.style.setProperty('--app-top', `${Math.round(top)}px`)
  root.classList.toggle('keyboard', keyboard)
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
    `app box       ${app ? `${Math.round(app.top)}..${Math.round(app.bottom)}` : 'n/a'} (sized ${Math.round(applied)})`,
    `keyboard      ${root.classList.contains('keyboard') ? 'open' : 'closed'}`,
    `strip below   ${getComputedStyle(root).getPropertyValue('--vp-short') || '0px'}`,
    `safe area     ${safe} (top / bottom)`,
    `standalone    ${Boolean(navigator.standalone || matchMedia('(display-mode: standalone)').matches)}`,
    `user agent    ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90)}`,
  ].join('\n')
}

export function toggleViewportInfo() {
  viewportInfo.value = viewportInfo.value ? '' : describe()
}

// Installed iPhone apps have a WebKit bug: after the keyboard closes, the viewport can stay shrunk until the
// app is force-quit, leaving a band at the bottom. Briefly hiding and showing the full-height app makes
// WebKit measure again. Only done when the height really is stuck, and scroll positions are kept.
let tallest = window.innerHeight
const typing = () => /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable
function heal() {
  if (typing()) return
  if (tallest - window.innerHeight <= 4) return
  const app = document.querySelector('.app')
  if (!app) return
  const scrollers = [...document.querySelectorAll('.thread, .scroll')].map(el => [el, el.scrollTop])
  app.style.display = 'none'
  void app.offsetHeight
  app.style.display = ''
  for (const [el, top] of scrollers) el.scrollTop = top
  fit()
}
addEventListener('resize', () => {
  if (!typing()) tallest = Math.max(tallest, window.innerHeight)
})
addEventListener('orientationchange', () => (tallest = 0))
document.addEventListener('focusout', () => setTimeout(heal, 160))
document.addEventListener('visibilitychange', () => !document.hidden && setTimeout(heal, 200))
addEventListener('pageshow', () => setTimeout(heal, 200))

fit()
vv?.addEventListener('resize', fit)
vv?.addEventListener('scroll', fit)
addEventListener('resize', fit)
addEventListener('orientationchange', () => setTimeout(fit, 300))
