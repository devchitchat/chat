# Call Tile Layout — Plan

Fix the call streaming UI so that video and screen share tiles never compete
with the message area for vertical space.

---

## Problem

The current structure is a flex column inside `.chat-panel`:

```
chat-header
call-status row
call-controls-bar
tile-grid          ← tiles live here, push messages down
messages           ← gets squeezed as tiles appear
composer
```

A single tile is 180px tall. Two tiles in a 2×2 grid are 280px. On a laptop or
phone, this leaves very little room for messages and makes the composer feel
buried. There is no way to get the tiles out of the way without leaving the call.

---

## Root fix

Move `#tile-grid` out of `.chat-panel` entirely. Make it a sibling of
`.chat-panel` inside `.main-content`. This lets CSS control where tiles render
relative to the message area independently of the chat column.

### Current DOM structure

```html
<div class="main-content">
  <section class="chat-panel" island="/client/islands/call.js">
    <header class="chat-header">…</header>
    <div class="call-status" hidden>…</div>
    <div class="call-controls-bar" id="call-controls-bar">…</div>
    <div class="tile-grid" id="tile-grid"></div>   <!-- problem: inside chat-panel -->
    <div class="messages" id="messages">…</div>
    <footer class="composer">…</footer>
  </section>
</div>
```

### Target DOM structure

```html
<div class="main-content">
  <section class="chat-panel" island="/client/islands/call.js">
    <header class="chat-header">…</header>
    <div class="call-status" hidden>…</div>
    <div class="call-controls-bar" id="call-controls-bar">…</div>
    <div class="messages" id="messages">…</div>
    <footer class="composer">…</footer>
  </section>

  <!-- tile-panel: sibling of chat-panel, never inside it -->
  <div class="tile-panel" id="tile-panel">
    <div class="tile-panel-header">
      <span class="tile-panel-title" id="tile-panel-title">Call</span>
      <button class="btn-icon tile-panel-collapse" id="tile-panel-collapse"
              aria-label="Collapse tile panel" type="button">⊟</button>
    </div>
    <div class="tile-grid" id="tile-grid"></div>
  </div>
</div>
```

Moving `#tile-grid` is a two-line HTML change and a one-line JS change
(`tileGridEl` reference in `call.js` already uses `getElementById` so the move
is transparent to the island logic).

---

## Layout modes

Two CSS-driven modes, plus a collapsed state. The active mode is stored in
`localStorage` under `devchitchat_tile_layout` and restored on mount.

### Mode A — Sidebar (default on desktop ≥ 1025px)

`.main-content` becomes a flex **row**. `.chat-panel` stays on the left and
fills remaining width. `.tile-panel` appears on the right as a fixed-width
column. Messages get the full height of the panel — no vertical competition.

```
┌──────────────────────────┬────────────────┐
│  chat-header             │  tile-panel    │
│  call-status             │  ┌──────────┐  │
│  call-controls           │  │  tile 1  │  │
│                          │  └──────────┘  │
│  messages (full height)  │  ┌──────────┐  │
│                          │  │  tile 2  │  │
│                          │  └──────────┘  │
│  composer                │                │
└──────────────────────────┴────────────────┘
```

### Mode B — Overlay (default on mobile < 1025px)

`.main-content` stays a flex column. `.tile-panel` is `position: absolute`,
anchored to the top-right corner of `.main-content`. It overlays the message
area rather than pushing it down. Messages remain full height; tiles float above
them. A semi-transparent background on the panel keeps text legible underneath.

```
┌────────────────────────────────┐
│  chat-header                   │
│  call-controls    ┌──────────┐ │
│                   │ tile 1   │ │
│  messages (full)  │ tile 2   │ │
│                   └──────────┘ │
│                                │
│  composer                      │
└────────────────────────────────┘
```

Overlay width: `min(220px, 45vw)`. Max height: `40vh`. The panel can be dragged
to any corner using touch/mouse (see below).

### Collapsed state (both modes)

The tile panel collapses to a single row: participant avatar strip + peer count
+ expand button. Height is 40px in sidebar mode, or just the toggle button in
overlay mode. All video streams pause rendering (`.tile-grid.collapsed video {
visibility: hidden }`) but the streams themselves stay alive.

```
Collapsed sidebar:  │ 👤👤👤  2 in call  [⊞] │
Collapsed overlay:  [⊞ 2]  (small floating button, top-right)
```

---

## CSS changes

**File:** `pages/public/themes/base.css`

Remove `tile-grid` from inside `.chat-panel` context. All tile-grid rules move
to work with `.tile-panel` as the container.

```css
/* ── Tile panel ───────────────────────────────────────────────────────────── */

.tile-panel {
  display: none;  /* hidden when no call; call.js adds .active */
  flex-direction: column;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border);
  overflow: hidden;
}
.tile-panel.active { display: flex; }

.tile-panel-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-topbar);
  flex-shrink: 0;
}
.tile-panel-title {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

/* ── Mode A: sidebar (desktop ≥ 1025px) ─────────────────────────────────── */

@media (min-width: 1025px) {
  .main-content.has-call {
    flex-direction: row;   /* switch from column to row */
  }
  .main-content.has-call .chat-panel {
    flex: 1;
    min-width: 0;
    height: 100%;   /* stretch to fill row */
  }
  .tile-panel {
    width: 280px;
    flex-shrink: 0;
    height: calc(100vh - var(--topbar-height));
    overflow-y: auto;
  }
  .tile-panel.collapsed {
    width: 40px;
    overflow: hidden;
  }
  .tile-panel.collapsed .tile-grid,
  .tile-panel.collapsed .tile-panel-title { display: none; }
  .tile-panel.collapsed .tile-panel-header {
    flex-direction: column;
    padding: 6px 4px;
    height: 100%;
    justify-content: flex-start;
    border-left: none;
  }
}

/* ── Mode B: overlay (mobile < 1025px) ──────────────────────────────────── */

@media (max-width: 1024px) {
  .main-content.has-call {
    position: relative;  /* anchor for absolute tile-panel */
  }
  .tile-panel {
    position: absolute;
    top: 0; right: 0;
    width: min(220px, 45vw);
    max-height: 40vh;
    z-index: 20;
    border-left: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    border-radius: 0 0 0 var(--radius-md);
    background: color-mix(in srgb, var(--bg-sidebar) 92%, transparent);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    overflow-y: auto;
  }
  .tile-panel.collapsed {
    width: auto;
    height: auto;
    max-height: none;
    border-radius: var(--radius-md);
    top: 8px; right: 8px;
  }
  .tile-panel.collapsed .tile-grid,
  .tile-panel.collapsed .tile-panel-title { display: none; }
  .tile-panel.collapsed .tile-panel-header {
    padding: 4px 8px;
    border-bottom: none;
  }
}

/* ── Tile grid (inside .tile-panel in both modes) ─────────────────────────  */

.tile-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px;
  flex: 1;
  overflow-y: auto;
  align-content: flex-start;
}

/* Collapsed: hide video, keep audio alive */
.tile-panel.collapsed .tile-grid video { visibility: hidden; }

/* Stream tiles: fill panel width, natural height */
.stream-tile {
  position: relative;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-sidebar);
  cursor: pointer;
  flex: 1 1 100%;
  aspect-ratio: 16 / 9;
}
.stream-tile video {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
}
.stream-tile .tile-label {
  position: absolute; bottom: 4px; left: 6px;
  font-size: 11px; font-weight: 600; color: white;
  text-shadow: 0 1px 3px rgba(0,0,0,0.6); pointer-events: none;
}

/* 2+ tiles in sidebar mode: side-by-side if panel is wide enough */
@media (min-width: 1025px) {
  .tile-grid:has(.stream-tile:nth-child(2)) .stream-tile {
    flex: 1 1 calc(50% - 3px);
  }
}

/* Pinned tile */
.tile-grid.pinned .stream-tile.pinned-tile {
  flex: 1 1 100%;
  order: -1;
}
.tile-grid.pinned .stream-tile:not(.pinned-tile) {
  flex: 1 1 calc(50% - 3px);
  aspect-ratio: 16/9;
}
```

---

## `call.js` changes

**File:** `pages/public/client/islands/call.js`

### 1. New DOM ref

```js
const tilePanelEl = document.getElementById('tile-panel')
```

### 2. Show/hide the panel

Replace direct manipulation of `.tile-grid.active` class. Use the panel:

```js
function _showTilePanel() {
  main-content.classList.add('has-call')   // toggles layout mode
  tilePanelEl?.classList.add('active')
}
function _hideTilePanel() {
  document.querySelector('.main-content')?.classList.remove('has-call')
  tilePanelEl?.classList.remove('active')
  tilePanelEl?.classList.remove('collapsed')
}
```

Call `_showTilePanel()` when the local stream is ready (on `rtc.joined`).
Call `_hideTilePanel()` in `_cleanupCall()`.

### 3. Collapse toggle

```js
const LAYOUT_KEY = 'devchitchat_tile_layout'

document.getElementById('tile-panel-collapse')?.addEventListener('click', () => {
  const collapsed = tilePanelEl?.classList.toggle('collapsed')
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ collapsed: !!collapsed }))
})

// Restore on mount
function _restoreTileLayout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}')
    if (saved.collapsed) tilePanelEl?.classList.add('collapsed')
  } catch {}
}
```

### 4. Overlay drag (mobile only)

A minimal drag implementation for the overlay panel. Attach to the
`.tile-panel-header` as the drag handle. Stores last position in localStorage
so it reappears where the user left it.

```js
function _attachOverlayDrag(panel) {
  if (window.matchMedia('(min-width: 1025px)').matches) return  // sidebar mode — no drag

  const header = panel.querySelector('.tile-panel-header')
  if (!header) return

  let startX, startY, startRight, startTop

  function onMove(e) {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const dx = startX - clientX
    const dy = clientY - startY
    const newRight = Math.max(0, Math.min(startRight + dx, window.innerWidth - 60))
    const newTop   = Math.max(0, Math.min(startTop  + dy, window.innerHeight - 60))
    panel.style.right = newRight + 'px'
    panel.style.top   = newTop   + 'px'
  }

  function onEnd() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup',   onEnd)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend',  onEnd)
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}'),
      overlayRight: panel.style.right,
      overlayTop:   panel.style.top,
    }))
  }

  header.addEventListener('mousedown', e => {
    startX = e.clientX; startY = e.clientY
    startRight = parseInt(panel.style.right) || 0
    startTop   = parseInt(panel.style.top)   || 0
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onEnd)
  })
  header.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY
    startRight = parseInt(panel.style.right) || 0
    startTop   = parseInt(panel.style.top)   || 0
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend',  onEnd)
  }, { passive: true })
}
```

Call `_attachOverlayDrag(tilePanelEl)` at the end of the island factory.

---

## HTML changes

**File:** `pages/channels/[channelId].phtml`

1. Remove `<div class="tile-grid" id="tile-grid">` from inside `.chat-panel`.
2. Add `.tile-panel` as a sibling of `.chat-panel`, after the closing `</section>`:

```html
</section><!-- /.chat-panel -->

<div class="tile-panel" id="tile-panel">
  <div class="tile-panel-header">
    <span class="tile-panel-title" id="tile-panel-title">Call</span>
    <button class="btn-icon tile-panel-collapse" id="tile-panel-collapse"
            aria-label="Collapse tile panel" type="button">⊟</button>
  </div>
  <div class="tile-grid" id="tile-grid"></div>
</div>
```

---

## File checklist

| File | Change |
|---|---|
| `pages/channels/[channelId].phtml` | Move `#tile-grid` out of `.chat-panel`; add `.tile-panel` sibling |
| `pages/public/themes/base.css` | Replace tile-grid rules with tile-panel sidebar/overlay modes |
| `pages/public/client/islands/call.js` | Add `tilePanelEl` ref; `_showTilePanel`/`_hideTilePanel`; collapse toggle; overlay drag |

No server changes. No schema changes.

---

## Build order

```
1. HTML: move tile-grid → tile-panel (structural change only, visual regression check)
2. CSS: sidebar mode on desktop (biggest win, least JS)
3. CSS: overlay mode on mobile
4. JS: show/hide panel, collapse toggle, localStorage restore
5. JS: overlay drag handle
```

---

## Out of scope

- Screen share gets its own tile by default (covered in channel-design.md Step 6).
  This plan doesn't change how tiles are created, only where they live in the DOM.
- Layout mode switcher button (sidebar ↔ overlay on desktop) — the CSS defaults
  are good enough for now; can add a toggle in the call controls bar later.
- Resizable sidebar splitter (drag handle between chat and tile panel) — follow-on.
- Participant audio level indicators on tiles — follow-on.
