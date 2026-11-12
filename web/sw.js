// Neural service worker: shows push notifications and opens the right session when one is tapped.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let data = {}
  try {
    data = event.data.json()
  } catch {
    data = { title: 'Neural', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Neural', {
    body: data.body || '',
    tag: data.tag,
    renotify: Boolean(data.tag),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { session: data.session || null },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const session = event.notification.data && event.notification.data.session
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.length) {
      await windows[0].focus()
      if (session) windows[0].postMessage({ type: 'open', session })
      return
    }
    await self.clients.openWindow(session ? '/s/' + encodeURIComponent(session) : '/')
  })())
})
