# Notifications — Revision

## What was already built (before this revision)

- `mention_seq` cursor in `deliveries` (migration 004)
- `parseMentions` pure function (`src/core/mentions.js`)
- `DeliveryService.advanceMention` and `SqliteDeliveryRepository` support
- `NotificationService.buildDigest` — unread counts and mention flags per channel/DM
- `notification.digest` sent on every WS connect / sign-in
- `notification.mention` broadcast to online mentioned users in real time
- `priority` field on messages (normal / async / now) — stored, not surfaced in UI
- Mention dot (`.has-mention`) on channel/DM items in sidebar, cleared on channel visit
- Digest banner in sidebar — "N unread messages (away Xm)" with dismiss button

## Decisions made in revision

### Simplified notification model

| Signal | When | Recipient experience |
|---|---|---|
| Blue dot | Any new DM or `@mention` (normal priority) | See it on normal app-checking cadence |
| Red dot | `@mention` + `now` priority | Urgent — stands out immediately on next visit |
| Browser push notification | `@mention` + `now` priority | Interrupts even when tab is in background or browser is closed |

- `async` priority is dropped — behaviourally identical to `normal` from the recipient's
  perspective and adds no value.
- Channel-wide `@here now` is explicitly out of scope for now.
- `now` only applies per-mentioned-user — never notifies the whole channel.

### Digest banner — removed

Redundant with the blue/red dots already in the sidebar. The `notification.digest` WS
event is still sent on connect to seed the dot state from the DB — only the visible
banner element is gone.

### Urgent send gestures

Two ways to send with `priority: 'now'`:
1. **Ctrl+Enter** (Cmd+Enter on Mac) — one-shot, no latch
2. **Bell toggle button** (🔔) in the composer — latches into urgent mode; subsequent
   Enter / Send button presses send as urgent until toggled off

Plain Enter sends at the current mode. Shift+Enter inserts a newline.

---

## What is implemented ✓

| Phase | What | Status |
|---|---|---|
| 1 | Red dot (`.has-urgent`) + `priority` in `notification.mention` | ✓ Done |
| 2 | Ctrl+Enter + bell toggle composer gesture | ✓ Done |
| 3 | `mention_priority` in `deliveries` (migration 006) + digest `urgent` flag | ✓ Done |
| 5 | Digest banner removed | ✓ Done |

Also fixed in this revision:
- `dispatchMentions` now uses `listUsersBasic()` for public channels so any user on the
  instance can be @mentioned, not just those with explicit `channel_members` rows
- `DeliveryService.advanceMention` calls `getOrCreate` first so the delivery row is
  always created before the mention cursor is written (fixes silent 0-row UPDATE)
- `.channel-item.has-mention .channel-link::after` CSS added (was missing — only DM
  items had the blue dot style)

## What remains

| Phase | What | Complexity | Plan |
|---|---|---|---|
| 4 | Web Push API — service worker, VAPID, subscription storage, server-side send | High | `plans/urgent-mentions.md` |
| — | User settings UI — push opt-in/out, future preferences | Medium | `plans/user-settings.md` |

---

## Key files

| File | Role |
|---|---|
| `src/services/NotificationService.js` | `buildDigest` — `urgent` flag per channel |
| `src/services/DeliveryService.js` | `advanceMention` (with `getOrCreate` + `priority`) |
| `src/adapters/SqliteDeliveryRepository.js` | `mention_priority` column, digest SQL |
| `scripts/migrate/006-mention-priority.js` | Migration — adds `mention_priority` |
| `src/ws/ChatServer.js` | `#dispatchMentions` — `listUsersBasic` + `priority` in publish |
| `src/ws/handlers/messageHandlers.js` | Passes `priority` to `dispatchMentions` |
| `src/ws/handlers/authHandlers.js` | Calls `sendDigest` after hello/signin |
| `pages/public/client/islands/sidebar.js` | Blue/red dots, `urgentChannels` signal |
| `pages/public/client/islands/chat.js` | Ctrl+Enter, bell toggle, `urgentMode` signal |
| `pages/public/themes/base.css` | `.has-urgent`, `.btn-urgent-toggle`, `.composer-urgent` |
| `pages/public/sw.js` | Service worker — push events (phase 4, not yet built) |
