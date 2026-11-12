import fs from 'node:fs'
import path from 'node:path'
import * as webpush from 'web-push'
import { config } from './config.ts'
import { db } from './db.ts'
import { uiClients } from './live.ts'

// Web Push: notifications on the phone or desktop when a session answers, needs approval, or dies.
// The payload is encrypted for the receiving browser, so the push service that relays it cannot read it.

type Keys = { publicKey: string; privateKey: string }

function loadKeys(): Keys {
  const file = path.join(config.dataDir, 'vapid.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    const keys = webpush.generateVAPIDKeys()
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 })
    return keys
  }
}

const keys = loadKeys()
export const publicKey = keys.publicKey

export type Notice = { title: string; body: string; session?: string; tag?: string }
type Sender = (subscription: any, payload: string) => Promise<unknown>

let sender: Sender = (subscription, payload) =>
  webpush.sendNotification(subscription, payload, {
    vapidDetails: { subject: config.pushSubject, publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 3600,
    urgency: 'high',
  })

/** Tests replace the network call. */
export function setSender(fn: Sender) {
  sender = fn
}

const all = db.prepare('SELECT endpoint, subscription FROM push_subscriptions')
const upsert = db.prepare(
  `INSERT INTO push_subscriptions (endpoint, subscription, user_agent) VALUES (?, ?, ?)
   ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription, user_agent = excluded.user_agent, last_error = NULL`,
)
const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
const ok = db.prepare("UPDATE push_subscriptions SET last_ok_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL WHERE endpoint = ?")
const failed = db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?')

export function subscribe(subscription: any, userAgent: string | undefined) {
  if (typeof subscription?.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    throw new Error('not a valid push subscription')
  }
  upsert.run(subscription.endpoint, JSON.stringify(subscription), userAgent ?? null)
}

export function unsubscribe(endpoint: string) {
  remove.run(endpoint)
}

export function subscriptionCount() {
  return all.all().length
}

/** True while some browser tab has the hub open and in front; there is no need to notify then. */
/** True while some tab has Neural in front and someone used it in the last two minutes (tabs report every minute while active). */
function someoneWatching() {
  const fresh = Date.now() - 150_000
  for (const ws of uiClients) if ((ws as any).hubVisible && ((ws as any).hubSeen ?? 0) > fresh) return true
  return false
}

export async function notify(notice: Notice, opts: { evenIfWatching?: boolean } = {}) {
  if (!opts.evenIfWatching && someoneWatching()) return 0
  const payload = JSON.stringify({ ...notice, body: clip(notice.body, 180) })
  let sent = 0
  await Promise.all((all.all() as { endpoint: string; subscription: string }[]).map(async row => {
    try {
      await sender(JSON.parse(row.subscription), payload)
      ok.run(row.endpoint)
      sent++
    } catch (e: any) {
      // 404 and 410 mean the browser dropped the subscription; anything else may be temporary.
      if (e?.statusCode === 404 || e?.statusCode === 410) remove.run(row.endpoint)
      else failed.run(String(e?.body || e?.message || e).slice(0, 300), row.endpoint)
    }
  }))
  return sent
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}
