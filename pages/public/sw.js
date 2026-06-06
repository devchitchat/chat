/**
 * Service worker for Web Push notifications.
 * Served at /sw.js (root scope) via a custom route in index.js.
 */

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch { /* ignore malformed payloads */ }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'chat', {
      body:  data.body  ?? '',
      icon:  '/public/favicon.png',
      badge: '/public/favicon.png',
      tag:   data.channel_id ?? 'chat', // collapse multiple from the same channel
      data:  { url: data.url ?? '/' },
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Focus an existing tab if one is open at the target URL
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus()
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
