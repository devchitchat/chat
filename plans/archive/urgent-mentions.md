# Urgent Mentions — `now` Priority + Web Push

## Goal

When a sender sends a message containing an `@mention` with `priority: 'now'`, each
mentioned user receives:

1. A **red dot** next to the channel/DM in their sidebar (instead of the normal blue dot)
2. A **browser push notification** if they have granted permission — works even when the
   tab is in the background or the browser is closed

If the user has not granted notification permission, the red dot is the sole escalation
signal. Permission is requested the first time a `now` mention arrives for them.

---

## Phase 1 — Red dot ✓ DONE

### What was built

- `.has-urgent` CSS rule in `base.css` — red dot using `var(--color-danger)`
- `priority` flows from `msg.send` → `messageHandlers.js` → `dispatchMentions` →
  `#dispatchMentions` in `ChatServer.js` → included in `notification.mention` WS publish
- `sidebar.js` — `urgentChannels` signal; `notification.mention` handler splits on
  `priority`; `updateMentionDots` applies `.has-urgent` (red) or `.has-mention` (blue);
  channel click clears both sets
- `notification.digest` handler seeds both `urgentChannels` and `mentionedChannels` from
  the `urgent` flag on digest channel entries

---

## Phase 2 — Urgent send gesture ✓ DONE

Two ways to send with `priority: 'now'`:

1. **Ctrl+Enter** (or Cmd+Enter on Mac) — one-shot urgent send, no latch
2. **Bell toggle button** (🔔) in the composer — latches into urgent mode; all subsequent
   Enter / Send button presses send as urgent until toggled off

Plain **Enter** sends at the current mode (normal or latched urgent).
Shift+Enter inserts a newline regardless.

### What was built

- `chat.js` — `urgentMode` signal; `handleComposerKey` checks `e.ctrlKey || e.metaKey`;
  `sendMessage` resolves priority from explicit arg or `urgentMode()`; `toggleUrgentMode`
  flips signal and applies `.composer-urgent` CSS class
- `[channelId].phtml` — bell button with `onclick="toggleUrgentMode"` and
  `cls="is-urgent:urgentMode"`; only `onkeydown` needed (no `onkeyup`)
- `base.css` — `.btn-urgent-toggle` (dims when off, full when on);
  `.composer.composer-urgent textarea` border turns `--color-danger`

---

## Phase 3 — `mention_priority` persistence ✓ DONE

### What was built

- `scripts/migrate/006-mention-priority.js` — adds `mention_priority TEXT NOT NULL DEFAULT 'normal'`
  to `deliveries`
- `src/db/initDb.js` — column added to `CREATE TABLE deliveries` definition + idempotent
  `ALTER TABLE` fallback
- `SqliteDeliveryRepository.advanceMention` — stores `priority`; `buildDigestData` selects
  `mention_priority`
- `DeliveryService.advanceMention` — passes `priority` through
- `NotificationService.buildDigest` — `urgent: hasMention && row.mention_priority === 'now'`
  on each channel entry

---

## Phase 4 — Web Push API (not yet built)

### Overview

```
Server generates VAPID key pair (once, stored in env)
  ↓
Client requests Notification permission on first now-mention received
  ↓
Client calls pushManager.subscribe() → gets PushSubscription object
  ↓
Client sends subscription to server via WS (push.subscribe)
  ↓
Server stores subscription in push_subscriptions table
  ↓
On now-mention: server sends Web Push to all subscriptions for that user_id
  ↓
Service worker receives push event → shows Notification
```

### Schema

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  sub_id       TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  endpoint     TEXT    NOT NULL UNIQUE,
  p256dh       TEXT    NOT NULL,
  auth         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
```

### VAPID keys

Generate once:

```bash
npx web-push generate-vapid-keys
```

Store in `.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com
```

Expose `VAPID_PUBLIC_KEY` to the client via a server-rendered template variable — no
separate HTTP endpoint needed.

### Service worker (`pages/public/sw.js`)

```js
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'devchitchat', {
      body: data.body,
      icon: '/favicon.png',
      data: { url: data.url },
      tag: data.channel_id, // collapse multiple from same channel
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.openWindow(event.notification.data.url))
})
```

Register from the client island:

```js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/public/sw.js')
}
```

### Client subscription flow

Triggered when `notification.mention` arrives with `priority: 'now'` and
`Notification.permission === 'default'`:

```js
async function requestPushPermission() {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  })
  ws.send({ t: 'push.subscribe', body: { subscription: sub.toJSON() } })
}
```

### New WS message types

| Type | Direction | Purpose |
|---|---|---|
| `push.subscribe` | client → server | Store a PushSubscription for this user |
| `push.unsubscribe` | client → server | Remove a PushSubscription |

### Server-side push send (`src/services/PushService.js`)

On `now` @mention, after `advanceMention`:

```js
pushService.sendToUser({
  userId: user_id,
  title: `@${senderHandle} mentioned you`,
  body: text.slice(0, 120),
  url: `/channels/${channelId}`,
  channelId,
})
```

Use the `web-push` npm package or a minimal VAPID implementation via `SubtleCrypto`.

### Files to create

| File | Role |
|---|---|
| `src/services/PushService.js` | Send Web Push notifications |
| `src/adapters/SqlitePushRepository.js` | Store/fetch push subscriptions |
| `src/ws/handlers/pushHandlers.js` | `push.subscribe`, `push.unsubscribe` handlers |
| `pages/public/sw.js` | Service worker — push + notificationclick events |
| `scripts/migrate/007-push-subscriptions.js` | Migration |

---

## Phase 5 — Remove digest banner ✓ DONE

The `notification.digest` WS event is still sent on connect to seed dot state from the
DB. Only the visible UI element was removed:

- `#digest-banner` div removed from `pages/channels/[channelId].phtml`
- `.digest-banner` CSS removed from `base.css`
- `showDigestBanner` function and `digestBannerEl` removed from `sidebar.js`
- `notification.digest` handler simplified — only seeds `mentionedChannels` /
  `urgentChannels` signals, no banner logic

---

## Key files

| File | Role |
|---|---|
| `src/ws/handlers/messageHandlers.js` | Passes `priority` to `dispatchMentions` |
| `src/ws/ChatServer.js` | `#dispatchMentions` — candidate list + `priority` in publish |
| `src/services/NotificationService.js` | `urgent` flag in digest channel entries |
| `src/services/DeliveryService.js` | `advanceMention` with `getOrCreate` + `priority` |
| `src/adapters/SqliteDeliveryRepository.js` | `mention_priority` column + digest SQL |
| `scripts/migrate/006-mention-priority.js` | Migration — `mention_priority` column |
| `pages/public/client/islands/chat.js` | `urgentMode`, Ctrl+Enter, bell toggle |
| `pages/public/client/islands/sidebar.js` | `urgentChannels`, red/blue dot logic |
| `pages/public/themes/base.css` | `.has-urgent`, `.btn-urgent-toggle`, `.composer-urgent` |
