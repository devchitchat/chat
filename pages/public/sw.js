/**
 * Service worker for Web Push notifications.
 * Served at BASE_PATH/sw.js via a custom route in index.js.
 * Registered with scope BASE_PATH/ so it covers all app pages.
 */

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch { /* ignore malformed payloads */ }

  // Use the registered scope as the default notification URL so it works at any BASE_PATH
  const defaultUrl = self.registration.scope

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'chat', {
      body:  data.body  ?? '',
      icon:  './favicon.png',
      badge: './favicon.png',
      tag:   data.channel_id ?? 'chat', // collapse multiple from the same channel
      data:  { url: data.url ?? defaultUrl },
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url ?? self.registration.scope
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
