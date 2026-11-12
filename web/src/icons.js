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
}

export function Icon({ name, size = 16, label }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden=${label ? undefined : 'true'} role=${label ? 'img' : undefined} aria-label=${label}>
    <path d=${PATHS[name]} />
  </svg>`
}

/** Three nodes, two links: the Neural mark. The live node carries the accent colour. */
export function Glyph({ size = 18 }) {
  return html`<svg class="glyph" width=${size} height=${size} viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.5 14.5 10 5.5l5.5 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
    <circle cx="4.5" cy="14.5" r="2.3" fill="currentColor" />
    <circle cx="15.5" cy="13.5" r="2.3" fill="currentColor" />
    <circle class="node-live" cx="10" cy="5.5" r="2.6" />
  </svg>`
}
