// Clock times for people to read, in the browser's time zone. Display only: stored timestamps stay ISO/UTC.
// No imports, so the tests can load it; server/src/clock.ts is the same pair for the hub.

/** "1:50 pm" */
export function clock(ts) {
  const d = ts instanceof Date ? ts : new Date(ts)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** "1:50 pm" today, "Thu 9:00 am" within a week either side, "Nov 25 9:00 am" further out. */
export function when(ts, now = new Date()) {
  const d = ts instanceof Date ? ts : new Date(ts)
  if (d.toDateString() === now.toDateString()) return clock(d)
  const days = Math.abs(d - now) / 86400000
  const day = days < 6.5 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${day} ${clock(d)}`
}
