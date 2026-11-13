// Line icons (paths adapted from Lucide, ISC licence) and the Neural mark.
import { html } from './lib.js'

const PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  timeline: 'M4 6h16M4 12h10M4 18h13',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  restart: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  stop: 'M6 6h12v12H6z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  back: 'M15 18l-6-6 6-6',
  send: 'M12 19V5M5 12l7-7 7 7',
  split: 'M4 4h16v16H4zM12 4v16',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  history: 'M3 12a9 9 0 1 0 9-9 9.7 9.7 0 0 0-6.7 2.7L3 8M3 3v5h5M12 7v5l4 2',
  sessions: 'M4 5h16v5H4zM4 14h16v5H4z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  next: 'M9 18l6-6-6-6',
  down: 'M12 5v14M5 12l7 7 7-7',
  image: 'M4 5h16v14H4zM9 11a1.6 1.6 0 1 0 0-.01M20 15.5 15 11l-9 8',
  camera: 'M4 8h3.2l1.8-3h6l1.8 3H20v11H4zM12 16.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.5v5M8 14.5v5',
  quote: 'M10 7H6v5h4c0 2-1 3-3 4M18 7h-4v5h4c0 2-1 3-3 4',
  clip: 'M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 1 1 18 8.8l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  alert: 'M12 8v5M12 16.5v.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
}

export function Icon({ name, size = 16, label }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden=${label ? undefined : 'true'} role=${label ? 'img' : undefined} aria-label=${label}>
    <path d=${PATHS[name]} />
  </svg>`
}

/** The Neural mark: a brain drawn as a network, simplified so it holds up at 20-28px. The live node is green. */
const O = [[4, 13.5], [4.5, 7.5], [9.5, 3.5], [15.5, 4], [19.5, 9], [18, 14.5], [11, 15.5]]
const STEM = [13.5, 20]
const LIVE = [9.5, 9.5]
const LINKS = [...O.map((p, i) => [p, O[(i + 1) % O.length]]), [O[6], STEM], [LIVE, O[1]], [LIVE, O[3]], [LIVE, O[6]], [LIVE, O[5]]]

export function Glyph({ size = 24 }) {
  return html`<svg class="glyph" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true">
    ${LINKS.map(([a, b]) => html`<line x1=${a[0]} y1=${a[1]} x2=${b[0]} y2=${b[1]} stroke="currentColor" stroke-opacity="0.7" stroke-width="1.3" stroke-linecap="round" />`)}
    ${[...O, STEM].map(([x, y]) => html`<circle cx=${x} cy=${y} r="1.75" fill="currentColor" />`)}
    <circle class="node-live" cx=${LIVE[0]} cy=${LIVE[1]} r="2.5" />
  </svg>`
}
