# Notifications

## Goal

Build a notification system that restores context rather than interrupts flow. Designed for
small teams (5–25 people) where ambient social awareness is already high.

## Design principles

1. **Sender decides urgency; receiver sets threshold.** Interrupts should carry social weight.
2. **Restoring context is more valuable than alerting presence.** Orientation over alarm.
3. **Don't count things that create anxiety.** Soft pings don't accumulate — presence, not quantity.

---

## Notification layers

### Layer 1 — Passive catch-up (default)

No push, no badge. Unread counts in the sidebar come from the existing `DeliveryService` read
cursor (`after_seq`). The UI surfaces "N messages since you were here" when you open a channel.
This already exists in skeleton form — the innovation is making it a named, intentional UX
rather than a fallback.

### Layer 2 — Soft pings (@mentions in channels you're a member of)

An @mention in a channel you're not actively viewing creates a **soft ping**:
- A distinct dot badge on the channel in the sidebar (different colour from unread count)
- No sound, no push notification
- **The badge does not count** — 1 or 14 mentions look the same; anxiety comes from counting
- Cleared when you visit the channel and advance your delivery cursor past the mention

Stored as a `mention_seq` cursor alongside the existing `after_seq` in `deliveries`.

### Layer 3 — Hard pings (DMs and escalated sends)

DMs always produce a hard ping. For channel messages, the **sender** chooses urgency at send time:

| Tier | Gesture | Receiver experience |
|---|---|---|
| `normal` | send key | no interrupt; passive catch-up only |
| `async` | hold send / swipe | subtle sound + queued into reconnect digest |
| `now` | deliberate escalation UI | push notification + sound, bypasses DND |

`async` and `now` are stored on the message as a `priority` field. `now` should be used rarely
— make the cost visible (e.g. show sender name in the notification so the receiver knows who
escalated).

### Layer 4 — Reconnect digest

When a user's WebSocket reconnects (presence transitions offline → online), the server sends a
single `notification.digest` message summarising activity since the last delivery cursor:

```js
{
  v: 1, t: 'notification.digest', body: {
    channels: [
      { channel_id: 'c_abc', name: 'dev', unread: 12, mentions: 1 },
      { channel_id: 'c_xyz', name: 'general', unread: 3, mentions: 0 }
    ],
    dms: [
      { channel_id: 'c_dm1', with_user: { user_id: 'u_123', display_name: 'Marisol' }, unread: 2 }
    ],
    away_duration_ms: 8040000
  }
}
```

The client renders a single "while you were away" banner — not a flood of badges. The user
dismisses or clicks through.

---

## WebSocket message types

| Type | Direction | Body |
|---|---|---|
| `notification.digest` | server → client | see above; sent on every reconnect |
| `notification.mention` | server → client | `{ channel_id, msg_id, seq, from_user_id }` — real-time, for online users |

---

## Schema changes (migration)

- `deliveries` — add `mention_seq INTEGER NOT NULL DEFAULT 0` column
- `messages` — add `priority TEXT NOT NULL DEFAULT 'normal'` column

---

## What NOT to build (explicit scope boundary)

- Notification sounds on every channel message
- A notification history drawer / second inbox
- Per-channel notification preference settings
- Email fallback notifications
- Push notification infrastructure (Web Push API) — design for it via `INotificationDelivery`
  port, but don't implement it in this iteration

---

## Current state

| Thing | State |
|---|---|
| Unread counts via `DeliveryService` | Exists (skeleton) |
| @mention parsing | Not built |
| `mention_seq` cursor | Not built |
| `priority` on messages | Not built |
| Reconnect digest | Not built |
| `notification.*` WS types | Not built |

---

## Build sequence

Follow the inside-out rule from CLAUDE.md.

### Phase 1 — Mentions

1. **Migration** — add `mention_seq` to `deliveries`, `priority` to `messages`
2. **Core** — `parseMentions(text, members)` → `[{ userId, handle }]` pure function in `src/core/mentions.js`
3. **Test** — `MessageService` extracts mentions and writes `mention_seq` on delivery
4. **Service** — call `parseMentions` in `MessageService.sendMessage`; advance `mention_seq`
   on the delivery records of mentioned users via `DeliveryService`
5. **Transport** — broadcast `notification.mention` to online mentioned users in `ChatServer.js`
6. **Client** — render soft ping dot on channel in sidebar; distinct from unread badge

### Phase 2 — Priority sends & digest

1. **Transport** — accept `priority` field in `msg.send` body; validate in `MessageService`
2. **Service** — implement `NotificationService.buildDigest(userId)` — reads delivery cursors
   for all channels and DMs the user belongs to
3. **Transport** — send `notification.digest` on WS connect (after auth, before channel join)
4. **Client** — "while you were away" banner rendered from digest payload
5. **Client** — hold-send / escalation gesture for `async` and `now` priority

---

## Key files to create or modify

| File | Change |
|---|---|
| `scripts/migrate/NNN-notifications.js` | Add `mention_seq` to deliveries, `priority` to messages |
| `src/core/mentions.js` | `parseMentions` pure function |
| `src/services/MessageService.js` | Extract mentions, set `priority` |
| `src/services/DeliveryService.js` | `mention_seq` advancement |
| `src/services/NotificationService.js` | New — `buildDigest(userId)` |
| `src/adapters/SqliteDeliveryRepository.js` | `mention_seq` read/write |
| `src/ws/ChatServer.js` | Digest on connect, `notification.mention` broadcast |
| `pages/public/client/islands/sidebar.js` | Soft ping dots on channels |
| `pages/public/client/islands/chat.js` | Hold-send gesture, priority indicator |
