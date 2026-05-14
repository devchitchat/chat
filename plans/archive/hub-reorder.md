# Hub Drag-and-Drop Reordering

## Goal

Allow users to drag hubs in the sidebar to reorder them, persisted server-side via a
`sort_order` column on `hubs` (same pattern as `channels.sort_order`).

The `dataset.hubId` bug that caused wrong hub lookups has already been fixed — hub ID
is now read via `getItemContext(details)` throughout `sidebar.js`.

---

## Build sequence

### 1. Schema — `src/db/initDb.js`

After the existing `channels` sort_order migration block, add:

```js
try { db.exec(`ALTER TABLE hubs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
```

### 2. Repository — `src/adapters/SqliteHubRepository.js`

- Change `ORDER BY h.name` → `ORDER BY h.sort_order ASC, h.name ASC` in both
  `listAllHubs()` and `listAccessibleHubs()`.
- Add `reorderHubs({ hubIds })`:

```js
reorderHubs({ hubIds }) {
  runTransaction(this.db, () => {
    const stmt = this.db.prepare('UPDATE hubs SET sort_order = ? WHERE hub_id = ?')
    hubIds.forEach((id, i) => stmt.run(i, id))
  })
}
```

### 3. Service — `src/services/HubService.js`

Add `reorderHubs({ hubIds, userId, userRoles })`:
- Require admin role or hub ownership (same permission as `updateHub`).
- Call `this.hubRepo.reorderHubs({ hubIds })`.
- Return `this.listHubs(userId, userRoles)` so the client gets the canonical order.

### 4. Transport — `src/ws/handlers/hubHandlers.js`

Add handler and route entry in `ChatServer.js` router:

```js
export function handleHubReorder(ws, msg, ctx) {
  const { auth, hubService, sendWs } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_ids } = msg.body || {}
  const hubs = hubService.reorderHubs({ hubIds: hub_ids, userId: ws.data.userId, userRoles: user?.roles || [] })
  // Broadcast to all connected users so every sidebar updates
  for (const [, conn] of ctx.connections) {
    if (conn.data.userId) sendWs(conn, { t: 'hub.reordered', ok: true, body: { hubs } })
  }
}
```

Route entry in `ChatServer.#route`:
```js
case 'hub.reorder': return handleHubReorder(ws, msg, ctx)
```

### 5. Client — `pages/public/client/islands/sidebar.js`

#### 5a. Drag handlers

Add `attachHubDragHandlers(sidebarEl, { ws, hubs })` following the same structure as
the existing `attachDragHandlers` for channels, targeting `details.hub-header` elements:

- `dragstart` on `details.hub-header`: record `dragSrcHubId` via `getItemContext(details).key`
- `dragover` on `details.hub-header` (not inside a channel list): show `.drop-before` / `.drop-after`
- `drop`: reorder `hubs()` array locally and send `hub.reorder` with new `hub_ids` order
- `dragend`: clean up indicators

Only enable on non-touch devices: check `!isTouch()` or set `draggable` dynamically after mount.

#### 5b. `hub.reordered` handler in the island

```js
ws.on('hub.reordered', ({ hubs: updated }) => {
  // Merge server order into local state, preserving local channel arrays
  const channelMap = new Map(hubs().map(h => [h.hub_id, h.channels]))
  hubs.set(updated.map(h => ({ ...h, channels: channelMap.get(h.hub_id) ?? [] })))
})
```

#### 5c. Template — `pages/channels/[channelId].phtml`

Mark hub rows as draggable:

```html
<details class="hub-header" data-key="{{hub_id}}" draggable="true" open>
```

The island can set `draggable=false` on touch devices after mount if the long-press
action-sheet approach is preferred for mobile.

#### 5d. CSS — `pages/public/themes/base.css`

Reuse existing `.drop-before` / `.drop-after` styles. Add matching rules for hub rows:

```css
details.hub-header.drop-before { ... }
details.hub-header.drop-after  { ... }
```

---

## File change summary

| File | Change |
|---|---|
| `src/db/initDb.js` | ALTER TABLE hubs ADD COLUMN sort_order |
| `src/adapters/SqliteHubRepository.js` | ORDER BY sort_order; add `reorderHubs()` |
| `src/services/HubService.js` | Add `reorderHubs()` |
| `src/ws/handlers/hubHandlers.js` | Add `handleHubReorder` |
| `src/ws/ChatServer.js` | Route `hub.reorder` |
| `pages/channels/[channelId].phtml` | `draggable="true"` on `details.hub-header` |
| `pages/public/client/islands/sidebar.js` | Hub drag handlers; `hub.reordered` handler |
| `pages/public/themes/base.css` | Drop indicator rules for hub rows |
