# Channel Design: Capability Model + Call UX

## Summary of decisions

- **Any channel can host a call** — no server-side gate based on `kind`
- **`kind`** is presentational: `text` = call UI is subtle/secondary; `voice` = call UI is front and centre, call presence shown prominently in sidebar
- **`voice` is additive** — text history is always present; voice adds audio, video, and screen share streaming
- **Voice-only channels** dropped from scope
- **Explicit join** — no auto-join on navigation; calls must be started or joined deliberately
- **One call per channel at a time**
- **Calls persist across server restarts** — `calls` and `call_participants` tables
- **A call stays active as long as at least one participant is connected** — rejoining an in-progress call is one continuous record
- **Visibility governs both** — channel membership controls access to text history and the ability to join the call; no split-visibility model
- **Screen sharing is a separate tile** — does not replace the camera tile; shown alongside all other tiles
- **Tile grid layout**: 1 → full width; 2 → side by side; 3–4 → 2×2 grid; 5+ → avatar-only strip; tap/click any tile to pin it (expands to main view, others become thumbnail row)
- **Call controls live in two places**: chat header when in the channel; persistent mini-bar when in a call and navigated away
- **Mini-bar location**: bottom of sidebar on desktop; fixed bar above the composer on mobile

---

## Prior art: reference the v1 codebase before building WebRTC

**Before implementing any WebRTC code** (audio, video, screen sharing, peer connections,
signaling), analyse the v1 codebase at `/Users/joeyguerra/src/devchitchat/devchitchat`. A
significant amount of debugging time was invested there working through real-world WebRTC issues
— NAT traversal, track negotiation, connection state edge cases, screen share, and signaling
race conditions. The solutions and patterns in that codebase should be carried forward rather
than rediscovered.

Specifically, before touching `call.js` or `SignalingService.js`, read:
- The v1 WebRTC client implementation (equivalent of `call.js`) — look for how it handles
  renegotiation when adding a screen share track, and how it recovers from failed/disconnected
  peer connections
- The v1 signaling server — look for any ordering guarantees, retry logic, or edge-case handling
  that isn't obvious from the current v2 `SignalingService`
- Any notes, comments, or commit messages in the v1 code that explain *why* something was done
  a certain way — these are the most valuable artefacts of the debugging sessions

The screen share renegotiation (Step 6 of this plan) is the highest-risk part of the
implementation. The v1 codebase is the first place to look for a working reference.

---

## Current state

- `kind` is validated as `'text' | 'voice'` but has no behavioural effect — calls work on any channel
- All call state is in-memory via `SignalingService` — lost on server restart
- No `calls` or `call_participants` tables
- The call island (`call.js`) is mounted on `.call-bar` inside the sidebar footer — controls are always in the sidebar regardless of context
- `toggleScreen` currently replaces the video track on peer connections (camera → screen) rather than adding a separate stream
- No visual distinction between text and voice channels in the sidebar
- No per-channel call presence indicator

---

## New files

| File | Purpose |
|---|---|
| `scripts/migrate-add-calls.js` | One-time migration to add `calls` and `call_participants` tables to existing databases |

---

## Step 1 — Schema: add `calls` and `call_participants` tables

**File:** `src/db/initDb.js`

Add after the `deliveries` table definition:

```sql
CREATE TABLE IF NOT EXISTS calls (
  call_id             TEXT    NOT NULL PRIMARY KEY,
  channel_id          TEXT    NOT NULL REFERENCES channels(channel_id),
  created_by_user_id  TEXT    NOT NULL REFERENCES users(user_id),
  topology            TEXT    NOT NULL DEFAULT 'mesh',
  started_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at            INTEGER           -- NULL while the call is active
);

CREATE TABLE IF NOT EXISTS call_participants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id     TEXT    NOT NULL REFERENCES calls(call_id),
  user_id     TEXT    NOT NULL REFERENCES users(user_id),
  peer_id     TEXT    NOT NULL,
  joined_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  left_at     INTEGER           -- NULL while still connected
);

CREATE INDEX IF NOT EXISTS idx_calls_channel_active
  ON calls (channel_id) WHERE ended_at IS NULL;
```

The partial index on `(channel_id) WHERE ended_at IS NULL` makes the "is there an active call in
this channel?" query fast without scanning the full history.

---

## Step 2 — `UserSettingsService` → `SignalingService`: add DB persistence

**File:** `src/services/SignalingService.js`

Inject `db` as a constructor dependency. Add prepared statements. Keep the in-memory `Map` as the
live call state (fast signaling lookups). DB writes happen alongside in-memory mutations.

```js
export class SignalingService {
  constructor({ db, nowFn = () => Date.now() } = {}) {
    this.nowFn = nowFn
    this.db = db
    this.calls = new Map()   // in-memory: call_id → Call (for signaling speed)
    this.emitter = new EventEmitter()

    this.#stmts = {
      insertCall: db.prepare(`
        INSERT INTO calls (call_id, channel_id, created_by_user_id, topology, started_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      endCall: db.prepare(`
        UPDATE calls SET ended_at = ? WHERE call_id = ?
      `),
      activeCallForChannel: db.prepare(`
        SELECT * FROM calls WHERE channel_id = ? AND ended_at IS NULL LIMIT 1
      `),
      insertParticipant: db.prepare(`
        INSERT INTO call_participants (call_id, user_id, peer_id, joined_at)
        VALUES (?, ?, ?, ?)
      `),
      leaveParticipant: db.prepare(`
        UPDATE call_participants SET left_at = ? WHERE call_id = ? AND peer_id = ?
      `),
      loadActiveCalls: db.prepare(`
        SELECT * FROM calls WHERE ended_at IS NULL
      `)
    }

    this.#loadActiveCallsFromDb()
  }

  // On startup: restore active calls into in-memory map so signaling continues
  // across restarts for calls that were in progress (participants will reconnect
  // and rejoin via normal join flow)
  #loadActiveCallsFromDb() {
    const rows = this.#stmts.loadActiveCalls.all()
    for (const row of rows) {
      this.calls.set(row.call_id, {
        call_id: row.call_id,
        room_id: row.channel_id,
        created_by_user_id: row.created_by_user_id,
        topology: row.topology,
        peers: new Map()  // peers reconnect fresh; their previous peer_ids are gone
      })
    }
  }
}
```

**Update `createCall`** — check DB for an active call first, not just in-memory:

```js
createCall({ roomId, createdByUserId, topology = 'mesh' }) {
  // Check in-memory first (fast path)
  for (const call of this.calls.values()) {
    if (call.room_id === roomId) {
      return { call_id: call.call_id, room_id: call.room_id, topology: call.topology }
    }
  }
  // Check DB (covers calls restored from a previous server run)
  const existing = this.#stmts.activeCallForChannel.get(roomId)
  if (existing) {
    // Re-hydrate into memory if somehow missing
    if (!this.calls.has(existing.call_id)) {
      this.calls.set(existing.call_id, {
        call_id: existing.call_id, room_id: existing.channel_id,
        created_by_user_id: existing.created_by_user_id,
        topology: existing.topology, peers: new Map()
      })
    }
    return { call_id: existing.call_id, room_id: existing.channel_id, topology: existing.topology }
  }
  // Create new
  const callId = newId('call')
  const now = Math.floor(this.nowFn() / 1000)
  this.calls.set(callId, { call_id: callId, room_id: roomId, created_by_user_id: createdByUserId, topology, peers: new Map() })
  this.#stmts.insertCall.run(callId, roomId, createdByUserId, topology, now)
  return { call_id: callId, room_id: roomId, topology }
}
```

**Update `joinCall`** — persist participant join:

```js
joinCall({ callId, userId }) {
  const call = this.calls.get(callId)
  if (!call) throw new ServiceError('NOT_FOUND', 'Call not found')
  const peerId = newId('peer')
  const now = Math.floor(this.nowFn() / 1000)
  call.peers.set(peerId, { peer_id: peerId, user_id: userId, joined_at: now })
  this.#stmts.insertParticipant.run(callId, userId, peerId, now)
  const peers = Array.from(call.peers.values()).map(p => ({ peer_id: p.peer_id, user_id: p.user_id }))
  return { peerId, peers }
}
```

**Update `leaveCall`** — persist participant departure; end call when last peer leaves:

```js
leaveCall({ callId, peerId }) {
  const call = this.calls.get(callId)
  if (!call) return { removed: false, peers: [], ended: false, room_id: null }
  const now = Math.floor(this.nowFn() / 1000)
  this.#stmts.leaveParticipant.run(now, callId, peerId)
  const removed = call.peers.delete(peerId)
  const peers = Array.from(call.peers.values()).map(p => ({ peer_id: p.peer_id, user_id: p.user_id }))
  const roomId = call.room_id
  const ended = call.peers.size === 0
  if (ended) {
    this.calls.delete(callId)
    this.#stmts.endCall.run(now, callId)
  }
  return { removed, peers, ended, room_id: roomId }
}
```

**Update `endCall`** — persist end:

```js
endCall({ callId }) {
  const call = this.calls.get(callId)
  if (!call) return null
  const now = Math.floor(this.nowFn() / 1000)
  this.calls.delete(callId)
  this.#stmts.endCall.run(now, callId)
  return { call_id: call.call_id, room_id: call.room_id, peers: Array.from(call.peers.values()) }
}
```

---

## Step 3 — Register `db` in `SignalingService` instantiation

**File:** `src/context.js`

```js
export const signalingService = new SignalingService({ db, nowFn: Date.now })
```

---

## Step 4 — CSS: tile grid, call header UI, mini-bar, sidebar badge

**File:** `pages/public/themes/base.css`

### 4a — Remove call controls from sidebar footer

Remove or empty the `.call-bar` block. The call island moves its mount point; the sidebar footer
only contains the user avatar row going forward.

### 4b — Tile grid

```css
/* Tile grid — sits between chat header and messages when a call is active */
.tile-grid {
  display: none;               /* hidden when no call */
  padding: 8px 12px;
  background: var(--bg-topbar);
  border-bottom: 1px solid var(--border);
  gap: 6px;
}
.tile-grid.active { display: flex; flex-wrap: wrap; }

/* 1 tile: full width */
.tile-grid .stream-tile { flex: 1 1 100%; max-height: 180px; }

/* 2 tiles: side by side */
.tile-grid:has(.stream-tile:nth-child(2):last-child) .stream-tile {
  flex: 1 1 calc(50% - 3px); max-height: 180px;
}

/* 3–4 tiles: 2×2 grid */
.tile-grid:has(.stream-tile:nth-child(3)) .stream-tile {
  flex: 1 1 calc(50% - 3px); max-height: 140px;
}

/* 5+ tiles: collapse to avatar strip — JS toggles .avatars-only on .tile-grid */
.tile-grid.avatars-only .stream-tile video { display: none; }
.tile-grid.avatars-only .stream-tile {
  flex: 0 0 36px; height: 36px; border-radius: 50%; overflow: hidden;
}

/* Pinned tile — JS adds .pinned to the grid and .pinned-tile to one tile */
.tile-grid.pinned { flex-direction: row; align-items: flex-start; }
.tile-grid.pinned .stream-tile.pinned-tile {
  flex: 1 1 100%;
  max-height: 320px;
  order: -1;
}
.tile-grid.pinned .stream-tile:not(.pinned-tile) {
  flex: 0 0 80px; height: 60px;
}

.stream-tile {
  position: relative;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-sidebar);
  cursor: pointer;
}
.stream-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
.stream-tile .tile-label {
  position: absolute; bottom: 4px; left: 6px;
  font-size: 11px; font-weight: 600; color: white;
  text-shadow: 0 1px 3px rgba(0,0,0,0.6);
}
```

### 4c — Chat header call UI

```css
/* Call state row below the channel title — shown when call is active or available */
.call-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 20px;
  background: var(--bg-topbar);
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.call-status-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--color-success); flex-shrink: 0;
}
.call-status-info { flex: 1; color: var(--text-secondary); }
.call-status-avatars { display: flex; gap: -4px; }
.call-status-avatar {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--accent); border: 2px solid var(--bg-topbar);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700; color: white; margin-left: -4px;
}
.call-status-avatar:first-child { margin-left: 0; }

/* In-call controls row */
.call-controls-bar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: var(--bg-topbar);
  border-bottom: 1px solid var(--border);
}
.call-controls-bar.active { display: flex; }
.call-controls-bar .btn-leave {
  margin-left: auto;
  padding: 4px 12px;
  background: var(--color-danger);
  color: white; border: none; border-radius: var(--radius-sm);
  font-weight: 600; cursor: pointer; font-size: 13px;
}
```

### 4d — Mini-bar

```css
/* Desktop: sits above the sidebar footer user row */
.call-mini-bar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-call, var(--bg-topbar));
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.call-mini-bar.active { display: flex; }
.call-mini-bar-channel {
  flex: 1; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer;
}
.call-mini-bar-channel:hover { color: var(--accent); }

/* Mobile: fixed above the composer when in a call */
@media (max-width: 1024px) {
  .call-mini-bar {
    position: sticky;
    bottom: 0;
    z-index: 10;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  /* Shown only when .main-content has .in-call AND we've navigated away */
  .main-content:not(.call-channel) .call-mini-bar.active { display: flex; }
  .main-content.call-channel .call-mini-bar { display: none !important; }
}
```

### 4e — Sidebar call-active badge

```css
/* Badge on channel item when a call is live */
.channel-item .call-badge {
  display: none;
  margin-left: auto;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-success);
  align-items: center;
  gap: 3px;
}
.channel-item.call-active .call-badge { display: flex; }
.channel-item.call-active .call-badge::before {
  content: '';
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-success);
  display: inline-block;
}
```

---

## Step 5 — HTML: restructure the channel page template

**File:** `pages/channels/[channelId].phtml`

### 5a — Sidebar: add call badge to channel items, mini-bar to footer

```html
<!-- Channel item (inside the each loop) -->
<li data-key="{{channel_id}}" class="{{className}}">
  <a attr="href:url" text="name" class="channel-link"
     href="/channels/{{channel_id}}"
     data-channel-id="{{channel_id}}"
     data-channel-name="{{name}}"
     data-channel-kind="{{kind}}">{{name}}</a>
  <span class="call-badge" aria-label="Call active">0</span>
</li>

<!-- Sidebar footer: add mini-bar above user row -->
<footer class="sidebar-footer">
  <div class="call-mini-bar" id="call-mini-bar">
    <span class="call-mini-bar-channel" id="mini-bar-channel-name"></span>
    <button class="btn-icon" id="mini-bar-mic" aria-label="Toggle mic">🎙</button>
    <button class="btn-ghost" id="mini-bar-return" aria-label="Return to call">↩</button>
    <button class="btn-ghost" id="mini-bar-leave" aria-label="Leave call"
            style="color: var(--color-danger)">✕</button>
  </div>
  <!-- existing user avatar row -->
</footer>
```

### 5b — Chat panel: replace call-bar with contextual call UI

Remove the `<div class="call-bar" island="/client/islands/call.js">` from the sidebar footer.

In the chat panel, add call UI between the header and the messages:

```html
<section class="chat-panel" island="/client/islands/call.js"
  data-id="{{channel.channel_id}}"
  data-kind="{{channel.kind}}"
  ...existing data attrs...
>
  <header class="chat-header">
    <hgroup>
      <h2 class="chat-title">{{channel.name}}</h2>
      <p class="chat-topic">{{channel.topic}}</p>
    </hgroup>
    <div class="chat-header-actions">
      <!-- Shown on voice channels or when a call is active on any channel -->
      <button class="btn-ghost btn-start-call" id="btn-start-call"
              aria-label="Start call">Start call</button>
    </div>
  </header>

  <!-- Call status row: shown when call is active and user hasn't joined -->
  <div class="call-status" id="call-status" hidden>
    <span class="call-status-dot"></span>
    <span class="call-status-info" id="call-status-info"></span>
    <div class="call-status-avatars" id="call-status-avatars"></div>
    <button class="btn-primary" id="btn-join-call" style="padding: 6px 14px; font-size: 13px">
      Join call
    </button>
  </div>

  <!-- In-call controls: shown when user is in the call -->
  <div class="call-controls-bar" id="call-controls-bar">
    <button class="btn-icon" id="ctrl-mic" aria-label="Toggle microphone">🎙</button>
    <button class="btn-icon" id="ctrl-cam" aria-label="Toggle camera">📷</button>
    <button class="btn-icon" id="ctrl-screen" aria-label="Share screen">🖥</button>
    <span class="call-peer-count" id="call-peer-count" style="color: var(--text-muted); font-size: 13px"></span>
    <button class="btn-leave" id="btn-leave-call">Leave</button>
  </div>

  <!-- Tile grid: shown when user is in the call -->
  <div class="tile-grid" id="tile-grid"></div>

  <!-- messages, composer unchanged -->
</section>
```

**The call island now mounts on `.chat-panel`** — giving it access to all call UI elements within
the panel plus the ability to reach the sidebar mini-bar and channel badges via `document`.

---

## Step 6 — `call.js` island: full rewrite

**File:** `pages/public/client/islands/call.js`

The island now mounts on `.chat-panel`. Key changes:

**State added:**
- `activeCallId` — the call currently active in this channel (may exist before user joins)
- `callParticipants` — array of `{ peer_id, user_id, display_name }` for all participants
- `pinnedPeerId` — which tile is currently pinned (`null` = grid mode)
- `screenStreams` — separate Map for screen share streams `peerId → MediaStream`

**Screen sharing — separate stream, no track replacement:**

```js
async function toggleScreen() {
  if (screenSharing()) {
    screenSharing.set(false)
    const screenStream = screenStreams.get('local')
    screenStream?.getTracks().forEach(t => t.stop())
    screenStreams.delete('local')
    _removeTile('screen-local')
    // Renegotiate: remove screen track from all peer connections
    for (const [peerId, pc] of peerConnections) {
      const screenSender = pc.getSenders().find(s => s.track?.label?.includes('screen'))
      if (screenSender) pc.removeTrack(screenSender)
      // Trigger renegotiation via onnegotiationneeded → new offer
    }
    return
  }
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
    screenSharing.set(true)
    screenStreams.set('local', screenStream)
    _renderTile('screen-local', screenStream, true, 'Your screen')
    const screenTrack = screenStream.getVideoTracks()[0]
    screenTrack.onended = () => toggleScreen()
    for (const [peerId, pc] of peerConnections) {
      pc.addTrack(screenTrack, screenStream)
      // Renegotiation triggered via pc.onnegotiationneeded
    }
  } catch { /* user cancelled */ }
}
```

**Tile grid management:**

```js
function _updateTileLayout() {
  const tileCount = tileGridEl.querySelectorAll('.stream-tile').length
  tileGridEl.classList.toggle('active', tileCount > 0)
  tileGridEl.classList.toggle('avatars-only', tileCount >= 5)
}

function _pinTile(peerId) {
  const current = pinnedPeerId()
  if (current === peerId) {
    // Unpin
    tileGridEl.classList.remove('pinned')
    tileGridEl.querySelectorAll('.stream-tile').forEach(t => t.classList.remove('pinned-tile'))
    pinnedPeerId.set(null)
  } else {
    tileGridEl.classList.add('pinned')
    tileGridEl.querySelectorAll('.stream-tile').forEach(t => t.classList.remove('pinned-tile'))
    tileGridEl.querySelector(`[data-peer="${peerId}"]`)?.classList.add('pinned-tile')
    pinnedPeerId.set(peerId)
  }
}

// Wire click-to-pin on every tile
function _renderTile(peerId, stream, muted, label) {
  let tile = tileGridEl.querySelector(`[data-peer="${peerId}"]`)
  if (!tile) {
    tile = document.createElement('div')
    tile.className = 'stream-tile'
    tile.dataset.peer = peerId
    tile.innerHTML = `<video autoplay playsinline ${muted ? 'muted' : ''}></video>
                      <span class="tile-label">${label}</span>`
    tile.addEventListener('click', () => _pinTile(peerId))
    tileGridEl.appendChild(tile)
    _updateTileLayout()
  }
  const video = tile.querySelector('video')
  if (video && stream) video.srcObject = stream
  return tile
}
```

**Mini-bar management (reaches into sidebar DOM):**

```js
const miniBar       = document.getElementById('call-mini-bar')
const miniBarName   = document.getElementById('mini-bar-channel-name')
const miniBarMic    = document.getElementById('mini-bar-mic')
const miniBarReturn = document.getElementById('mini-bar-return')
const miniBarLeave  = document.getElementById('mini-bar-leave')

const channelName = root.dataset.name   // from data-name on .chat-panel

function _showMiniBar() {
  if (!miniBar) return
  miniBarName.textContent = channelName
  miniBar.classList.add('active')
}
function _hideMiniBar() {
  miniBar?.classList.remove('active')
}

miniBarMic?.addEventListener('click', toggleMic)
miniBarReturn?.addEventListener('click', () => {
  // Navigate back to the call channel
  window.location.href = `/channels/${channelId}`
})
miniBarLeave?.addEventListener('click', () => {
  leaveCall()
  _hideMiniBar()
})

// Show mini-bar when user navigates away while in a call
// sidebar.js dispatches 'channelnavigated' when a different channel is clicked
document.addEventListener('channelnavigated', (e) => {
  if (inCall() && e.detail.channelId !== channelId) {
    _showMiniBar()
  }
})
```

**Sidebar call-presence badge updates:**

```js
function _updateChannelBadge(count) {
  const li = document.querySelector(`.channel-item a[data-channel-id="${channelId}"]`)?.closest('li')
  if (!li) return
  li.classList.toggle('call-active', count > 0)
  const badge = li.querySelector('.call-badge')
  if (badge) badge.textContent = count
}
```

**Server push: subscribe to channel call state**

Add a new WS message type (see Step 7) so all clients in a channel receive call participant count
updates, not just those in the call. This drives the sidebar badge for non-participants.

---

## Step 7 — New WS message: `rtc.call_state`

**File:** `src/ws/ChatServer.js`

Broadcast to all channel subscribers (not just call participants) whenever the participant count
changes:

```js
// Called after every join/leave
function publishCallState(channelId, callId, participantCount, participants) {
  this.#server.publish(`channel:${channelId}`, this.#envelope({
    t: 'rtc.call_state',
    body: {
      channel_id: channelId,
      call_id:    callId,
      count:      participantCount,
      users:      participants.map(p => ({ user_id: p.user_id }))
    }
  }))
}
```

The `call.js` island on every connected client (in that channel) receives `rtc.call_state` and
updates the call status row and sidebar badge regardless of whether they are in the call.

Also: when a user navigates to a channel, the server sends the current call state as part of the
channel join response (or as an immediate `rtc.call_state` push after subscribe) so they see the
"N in call / Join call" UI without waiting for a participant event.

---

## Step 8 — `sidebar.js`: dispatch navigation events

**File:** `pages/public/client/islands/sidebar.js`

When a channel link is clicked, dispatch a `channelnavigated` event so `call.js` can show the
mini-bar if a call is in progress:

```js
sidebarEl.addEventListener('click', e => {
  const link = e.target.closest('.channel-link')
  if (!link) return
  document.dispatchEvent(new CustomEvent('channelnavigated', {
    detail: { channelId: link.dataset.channelId }
  }))
})
```

---

## Data flow

```
User starts a call
──────────────────
  1. Clicks "Start call" in chat header
  2. call.js → ws.send({ t: 'rtc.call_create', body: { channel_id, kind: 'mesh' } })
  3. Server: SignalingService.createCall() → inserts row in calls table
  4. Server → rtc.call response to caller
  5. Server → rtc.call_state broadcast to all channel subscribers (count: 0 until join)
  6. call.js receives rtc.call → sends rtc.join
  7. Server: SignalingService.joinCall() → inserts call_participants row
  8. Server → rtc.joined to caller; rtc.call_state broadcast (count: 1)
  9. call.js: acquires media, renders local tile, shows call controls bar
  10. Other clients see "1 in call / Join call" in their chat header and sidebar badge

User joins an active call
──────────────────────────
  1. Sees "N in call / Join call" row in chat header
  2. Clicks "Join call"
  3. call.js → ws.send({ t: 'rtc.call_create', body: { channel_id, ... } })
     (server returns existing call_id since one is active)
  4. call.js → ws.send({ t: 'rtc.join', body: { call_id } })
  5. Server → rtc.joined with existing peers list
  6. P2P offer/answer exchange with each existing peer
  7. rtc.call_state broadcast (count: N+1)

User navigates away while in a call
──────────────────────────────────────
  1. Clicks a different channel in the sidebar
  2. sidebar.js dispatches 'channelnavigated' event
  3. call.js hears event → shows mini-bar with channel name, mic toggle, return, leave
  4. On mobile: mini-bar appears above composer in the new channel
  5. P2P connections remain active — audio/video continues
  6. User clicks ↩ in mini-bar → navigates back to call channel → mini-bar hides

Last participant leaves
────────────────────────
  1. call.js → ws.send({ t: 'rtc.leave', body: { call_id } })
  2. Server: SignalingService.leaveCall() → sets call_participants.left_at
     → peers.size === 0 → sets calls.ended_at
  3. rtc.call_state broadcast (count: 0, call_id: null)
  4. All clients clear their call status rows and sidebar badges

Server restarts with active calls
───────────────────────────────────
  1. SignalingService constructor reads calls WHERE ended_at IS NULL from DB
  2. Re-hydrates in-memory Map with empty peers (connected participants are gone)
  3. Participants reconnect via normal WebSocket hello/resume flow
  4. Each participant's client detects the call is still active via rtc.call_state
     push (sent on channel subscribe) and re-joins via rtc.call_create + rtc.join
```

---

## File checklist

| File | Change | Type |
|---|---|---|
| `src/db/initDb.js` | Add `calls`, `call_participants` tables + index | Edit |
| `src/services/SignalingService.js` | Inject `db`; persist create/join/leave/end; restore on startup | Edit |
| `src/context.js` | Pass `db` to `SignalingService` | Edit |
| `src/ws/ChatServer.js` | Broadcast `rtc.call_state` on join/leave; send on channel subscribe | Edit |
| `pages/public/themes/base.css` | Tile grid, call status row, call controls bar, mini-bar, sidebar badge | Edit |
| `pages/channels/[channelId].phtml` | Move call island to `.chat-panel`; add call status/controls/tile grid HTML; add mini-bar to sidebar footer; add call badge to channel items | Edit |
| `pages/public/client/islands/call.js` | Rewrite: new mount point, screen share as separate tile, tile grid + pin-to-expand, mini-bar management, sidebar badge updates | Edit |
| `pages/public/client/islands/sidebar.js` | Dispatch `channelnavigated` event on channel link click | Edit |
| `scripts/migrate-add-calls.js` | One-time migration for existing databases | New file |

---

## Out of scope (follow-on)

- STUN/TURN server configuration (currently hardcoded to Google STUN) — needed for calls across
  NAT in production deployments
- Call history UI in the channel (a log of past calls with participants and duration)
- Push-to-talk mode
- Audio-only mode (no video) as a per-participant toggle at join time
- Recording
