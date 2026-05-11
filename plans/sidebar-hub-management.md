# Plan: Sidebar hub management improvements

## Problems to fix

### Bug 1 & 2 (same root cause): wrong hub when creating a channel, channel not appearing after save

**Root cause:** `attachManagementHandlers` reads `hubId` from `summary?.dataset.hubId`
(`data-hub-id="{{hub_id}}"` in the template). rdbljs strips / does not reliably update
`data-*` attributes on dynamically re-rendered nodes — the drag-and-drop comment in the
same file already documents this exact problem for `data-key`. When a hub is created via
WS (not SSR), the re-rendered `<summary data-hub-id>` is either empty or retains a stale
value from the previous render cycle, so `hubId` is `undefined`.

When `hub_id` is `undefined`, `ChatServer#handleChannelCreate` falls back to
`ensureDefaultHub()`, creating the channel under the wrong hub. The `channel.created` event
comes back with that wrong `hub_id`, which does match the default hub in client state, so
the channel appears there. On refresh the SSR data is correct, so both bugs vanish.

**Fix:** Replace all three `dataset.hubId` reads with `getItemContext(details)` on the
`details.hub-header` ancestor — exactly the same pattern the channel drag handlers use for
`data-key`. `getItemContext` uses a WeakMap that rdbljs maintains correctly across
re-renders.

Affected locations in `sidebar.js`:
- `attachManagementHandlers` → `btn-hub-gear` handler (line ~364)
- `attachManagementHandlers` → `btn-hub-add` handler (line ~375)
- `addLongPress` callback → long-press on `.hub-name` (line ~407)

### Feature: hub drag-and-drop reordering

Hubs currently sort by `name` in SQL. Need a `sort_order` column on `hubs` (same pattern
as `channels.sort_order`) and a `hub.reorder` WS round-trip.

---

## Implementation plan

### 1. Schema — add `sort_order` to `hubs`

In `src/db/initDb.js`, after the existing `channels` sort_order migration block, add:

```js
try { db.exec(`ALTER TABLE hubs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
```

### 2. Repository — `SqliteHubRepository`

- Change `ORDER BY h.name` → `ORDER BY h.sort_order ASC, h.name ASC` in both
  `listAllHubs()` and `listAccessibleHubs()`.
- Add `reorderHubs({ hubIds })`: runs a transaction that updates each hub's `sort_order`
  to its index in the provided array. Same pattern as `SqliteChannelRepository.reorderChannels`.

```js
reorderHubs({ hubIds }) {
  runTransaction(this.db, () => {
    const stmt = this.db.prepare('UPDATE hubs SET sort_order = ? WHERE hub_id = ?')
    hubIds.forEach((id, i) => stmt.run(i, id))
  })
}
```

### 3. Service — `HubService`

Add `reorderHubs({ hubIds, userId, userRoles })`:
- Require admin role or ownership (same permission check as `updateHub`).
- Call `this.hubRepo.reorderHubs({ hubIds })`.
- Return the updated hub list via `listHubs(userId, userRoles)`.

### 4. ChatServer — WS handler

Add route entry and handler:

```js
case 'hub.reorder': return this.#handleHubReorder(ws, msg)
```

```js
#handleHubReorder(ws, msg) {
  const user = this.auth.getUser(ws.data.userId)
  const { hub_ids } = msg.body || {}
  const hubs = this.hubService.reorderHubs({ hubIds: hub_ids, userId: ws.data.userId, userRoles: user?.roles || [] })
  // Broadcast to all connected users so everyone's sidebar updates
  this.#broadcastToAll({ t: 'hub.reordered', ok: true, body: { hubs } })
}
```

Add `#broadcastToAll(payload)` helper (iterates `this.connections`).

### 5. Client — `sidebar.js`

#### 5a. Fix the hub-id lookup bug

In `attachManagementHandlers`, replace the three `dataset.hubId` reads:

```js
// BEFORE
const summary = e.target.closest('.hub-name')
const hubId = summary?.dataset.hubId

// AFTER
const details = e.target.closest('.hub-header')
const ctx = getItemContext(details)
const hubId = ctx?.key
```

Apply the same fix in the long-press handler:
```js
// BEFORE
const summary = target?.closest?.('.hub-name')
if (summary) {
  const hubId = summary.dataset.hubId

// AFTER
const summary = target?.closest?.('.hub-name')
if (summary) {
  const details = summary.closest('.hub-header')
  const ctx = getItemContext(details)
  const hubId = ctx?.key
```

#### 5b. Hub drag-and-drop handlers

Add `attachHubDragHandlers(sidebarEl, { ws, hubs })` following the same structure as
`attachDragHandlers` for channels, but targeting `details.hub-header` elements:

- `dragstart` on `details.hub-header`: record `dragSrcHubId` via `getItemContext(details).key`
- `dragover` on `details.hub-header` (not inside a channel list): show drop indicator
- `drop`: reorder `hubs()` array and send `hub.reorder` with the new `hub_ids` order
- `dragend`: clean up indicators

The `details` element needs `draggable="true"` set in the template (only on desktop — check
`!isTouch()`), or set it dynamically after mount to avoid interfering with the
`<summary>` open/close click on mobile.

Add `hub.reordered` handler in the island:

```js
ws.on('hub.reordered', ({ hubs: updated }) => {
  // Merge server order into local state, preserving local channel arrays
  const channelMap = new Map(hubs().map(h => [h.hub_id, h.channels]))
  hubs.set(updated.map(h => ({ ...h, channels: channelMap.get(h.hub_id) ?? [] })))
})
```

#### 5c. Template — mark hub rows as draggable

In `[channelId].phtml`, add `draggable="true"` to `<details class="hub-header">`:

```html
<details class="hub-header" data-key="{{hub_id}}" draggable="true" open>
```

(The island can set `draggable=false` on touch devices after mount if the action sheet
long-press approach is preferred for mobile.)

#### 5d. CSS — drag indicators for hubs

Reuse the existing `.drop-before` / `.drop-after` styles already defined for channel items.
Add matching rules for `details.hub-header.drop-before` and `.drop-after`.

---

## File change summary

| File | Change |
|---|---|
| `src/db/initDb.js` | ALTER TABLE hubs ADD COLUMN sort_order |
| `src/adapters/SqliteHubRepository.js` | ORDER BY sort_order; add reorderHubs() |
| `src/services/HubService.js` | add reorderHubs() |
| `src/ws/ChatServer.js` | hub.reorder route + handler + broadcastToAll |
| `pages/channels/[channelId].phtml` | draggable="true" on details.hub-header |
| `pages/public/client/islands/sidebar.js` | fix hubId lookup; hub drag handlers; hub.reordered handler |
| `pages/public/themes/base.css` | drop indicator rules for hub rows |

## Order of work

1. Fix the bug first (5a only) — isolated, no schema changes, unblocks immediate testing
2. Schema + repo + service + WS handler (steps 1–4)
3. Client drag handlers + hub.reordered (5b–5d)
