# Notifications — Revision

## What is already built

The initial notifications plan (`plans/archive/notifications.md`) has been fully
implemented:

- `mention_seq` cursor in `deliveries` (migration 004)
- `parseMentions` pure function (`src/core/mentions.js`)
- `DeliveryService.advanceMention` and `SqliteDeliveryRepository` support
- `NotificationService.buildDigest` — unread counts and mention flags per channel/DM
- `notification.digest` sent on every WS connect / sign-in
- `notification.mention` broadcast to online mentioned users in real time
- `priority` field on messages (normal / async / now) — stored, not yet surfaced in UI
- Mention dot (`.has-mention`) on channel items in sidebar, cleared on channel visit
- Digest banner in sidebar — "N unread messages (away Xm)" with dismiss button

## What needs to change

_To be filled in. Describe what's wrong with the current UX and what the desired
behaviour is. Example prompts:_

- Is the digest banner appearing at the wrong time or in the wrong place?
- Does the mention dot clear at the right moment?
- Is the `priority` send UI (hold-send / escalation) still needed?
- Should the digest show per-channel detail (channel name + count) rather than a total?
- Is the "away duration" calculation correct?
- Does the `async` / `now` priority path need to be surfaced in the message composer?

---

## Key files

| File | Role |
|---|---|
| `src/services/NotificationService.js` | `buildDigest` — reads delivery cursors |
| `src/services/DeliveryService.js` | `advanceMention`, `advance`, `getOrCreate` |
| `src/adapters/SqliteDeliveryRepository.js` | All delivery cursor SQL |
| `src/ws/ChatServer.js` | `#sendDigest`, `#dispatchMentions` |
| `src/ws/handlers/authHandlers.js` | Calls `sendDigest` after hello/signin |
| `src/ws/handlers/messageHandlers.js` | Calls `dispatchMentions` after msg.send |
| `pages/public/client/islands/sidebar.js` | Mention dots, digest banner, clear-on-click |
| `pages/public/client/islands/chat.js` | Message composer (priority send gesture) |
