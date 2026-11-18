// Clock times for people to read, in the machine's time zone: "1:50 pm" today, "Thu 9:00 am" within a week,
// "Nov 25 9:00 am" further out. Display only; stored timestamps stay ISO/UTC. web/src/lib.js has the same pair.

/** "1:50 pm" */
export function clock(at: Date | number | string): string {
  const d = at instanceof Date ? at : new Date(at)
  const h = d.getHours()
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

/** "1:50 pm" today, "Thu 9:00 am" within a week either side, "Nov 25 9:00 am" further out. */
export function when(at: Date | number | string, now = new Date()): string {
  const d = at instanceof Date ? at : new Date(at)
  if (d.toDateString() === now.toDateString()) return clock(d)
  const days = Math.abs(d.getTime() - now.getTime()) / 86400000
  const day = days < 6.5 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${day} ${clock(d)}`
}
