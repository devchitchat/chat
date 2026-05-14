/**
 * Web Push subscription WS handlers.
 */

export function handlePushSubscribe(ws, msg, ctx) {
  const { pushRepo, sendWs } = ctx
  const { subscription } = msg.body ?? {}
  const endpoint = subscription?.endpoint
  const p256dh   = subscription?.keys?.p256dh
  const auth     = subscription?.keys?.auth

  if (!endpoint || !p256dh || !auth) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'BAD_REQUEST', message: 'Invalid push subscription' } })
  }

  pushRepo.upsertSubscription({ userId: ws.data.userId, endpoint, p256dh, auth })
  sendWs(ws, { t: 'push.subscribed', reply_to: msg.id, ok: true, body: {} })
}

export function handlePushUnsubscribe(ws, msg, ctx) {
  const { pushRepo, sendWs } = ctx
  const { endpoint } = msg.body ?? {}
  if (endpoint) pushRepo.removeSubscription(endpoint)
  sendWs(ws, { t: 'push.unsubscribed', reply_to: msg.id, ok: true, body: {} })
}
