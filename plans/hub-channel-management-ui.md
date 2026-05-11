# Hub & Channel Management UI

## Goal

Give users a way to create, rename, and configure hubs and channels. The interaction model is
device-appropriate:

- **Mobile (≤ 700px)** — long-press on a hub or channel name → action sheet slides up from the bottom
- **iPad (701px–1024px)** — identical to mobile (it's a touch UI)
- **Desktop (≥ 1025px)** — gear icon appears on hover → click opens a centered modal

The server already supports full CRUD via WebSocket (`hub.create`, `hub.update`, `hub.delete`,
`channel.create`, `channel.update`, `channel.delete`). The sidebar island already listens for those
events to update the list reactively. This plan is entirely about the UI layer.

---

## Current State

- `.hub-name` `<summary>` contains a `+` button that calls `createChannelButtonClicked` — currently
  returns `false` (no-op)
- Channel `<li>` items contain only an `<a>` link — no action affordances
- No modals, action sheets, or forms exist anywhere in the client
- Long-press detection does not exist (the mobile-nav-slide plan adds it for swipe-dismiss, but
  only on the `.main-content` panel)

---

## Breakpoints

| Range | Device | Interaction model |
|---|---|---|
| ≤ 700px | Phone | Long-press → action sheet |
| 701px–1024px | iPad (all sizes) | Long-press → action sheet |
| ≥ 1025px | Desktop / laptop | Hover gear icon → modal |

CSS uses `(max-width: 1024px)` and `(min-width: 1025px)`. JavaScript gesture code checks
`window.matchMedia('(pointer: coarse)')` so an iPad with an attached keyboard + trackpad
automatically gets the desktop gear-icon behaviour.

---

## Actions in scope

| Surface | Actions |
|---|---|
| Hub | Edit name, Edit description, Create channel, Delete hub |
| Channel | Edit name, Edit topic, Delete channel |

Delete is destructive and requires a confirmation step before the WS message is sent.

### Confirmation pattern

**Touch (action sheet):** Tapping "Delete …" in the first sheet dismisses it and opens a second
sheet. The second sheet shows only a red "Delete" confirm button and a "Cancel" button — no form.

**Desktop (modal):** The existing edit modal gains a danger zone below the form: a short warning
sentence and a red "Delete" button. Clicking it sends the delete message immediately (the modal
already has explicit Save/Cancel flow so a double-confirm is overkill).

The server already handles both `hub.delete` and `channel.delete` fully. No server changes needed.

---

## New Files

| File | Purpose |
|---|---|
| `pages/public/client/long-press.js` | Reusable long-press gesture utility |
| `pages/public/client/action-sheet.js` | Action sheet component (mobile + iPad) |
| `pages/public/client/modal.js` | Modal component (desktop) |

---

## Implementation Plan

---

### Step 1 — Add management affordances to the sidebar HTML

**File:** `pages/channels/[channelId].phtml`

**Hub row — add `data-hub-id` and a gear button:**

```html
<details class="hub-header" data-key="{{hub_id}}" open>
  <summary class="hub-name" data-hub-id="{{hub_id}}" data-hub-name="{{name}}">
    <span text="name">{{name}}</span>
    <button class="btn-hub-gear btn-icon" title="Hub settings" aria-label="Hub settings">&#9881;</button>
    <button class="btn-hub-add btn-icon" title="Create a channel" onclick="createChannelButtonClicked"
            aria-label="Create a channel">+</button>
  </summary>
  ...
```

**Channel row — add `data-channel-id` and a gear button:**

```html
<li data-key="{{channel_id}}" class="{{className}}">
  <a attr="href:url" text="name" class="channel-link"
     href="/channels/{{channel_id}}"
     data-channel-id="{{channel_id}}"
     data-channel-name="{{name}}"
     data-channel-topic="{{topic}}">{{name}}</a>
  <button class="btn-channel-gear btn-icon" title="Channel settings"
          aria-label="Channel settings">&#9881;</button>
</li>
```

---

### Step 2 — CSS: gear icons, action sheet, modal

**File:** `pages/public/themes/base.css`

#### 2a — Gear icon visibility

On touch devices (≤ 1024px) gear icons are hidden — long-press is the trigger instead.
On desktop (≥ 1025px) they appear on row hover.

```css
/* Hidden on touch devices; shown on desktop via hover */
.btn-hub-gear,
.btn-channel-gear {
  display: none;
  margin-left: auto;
  flex-shrink: 0;
}

@media (min-width: 1025px) {
  .hub-name:hover .btn-hub-gear,
  .channel-item:hover .btn-channel-gear {
    display: flex;
  }
}
```

Also update `.hub-name` and `.channel-item a` to `display: flex; align-items: center` so the gear
button sits inline.

#### 2b — Action sheet (mobile + iPad)

The action sheet is a fixed panel that slides up from the bottom. A semi-transparent backdrop sits
behind it and dismisses it on tap.

```css
/* Backdrop */
.action-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition);
}
.action-sheet-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

/* Sheet */
.action-sheet {
  position: fixed;
  left: 0; right: 0; bottom: 0;
  z-index: 201;
  background: var(--bg-sidebar);
  border-top: 1px solid var(--border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  padding: 12px 0 env(safe-area-inset-bottom, 16px);
  transform: translateY(100%);
  transition: transform var(--transition);
  max-width: 640px;        /* centred on iPad */
  margin: 0 auto;
}
.action-sheet.open {
  transform: translateY(0);
}

/* Handle bar */
.action-sheet-handle {
  width: 36px; height: 4px;
  background: var(--border);
  border-radius: 2px;
  margin: 0 auto 12px;
}

/* Section label */
.action-sheet-label {
  padding: 4px 20px 8px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-muted);
}

/* Individual action rows */
.action-sheet-item {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 20px;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 1rem;
  text-align: left;
  cursor: pointer;
}
.action-sheet-item:hover,
.action-sheet-item:active {
  background: var(--bg-hover);
}
.action-sheet-item.danger { color: var(--color-danger); }
.action-sheet-item:disabled {
  color: var(--text-muted);
  cursor: default;
}
```

#### 2c — Modal (desktop)

```css
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition);
}
.modal-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

.modal {
  background: var(--bg-sidebar);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 100%;
  max-width: 480px;
  padding: 28px 32px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  transform: scale(0.97);
  transition: transform var(--transition);
}
.modal-backdrop.open .modal {
  transform: scale(1);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-title { font-size: 1.1rem; font-weight: 700; }
.modal-close {
  background: none; border: none; cursor: pointer;
  color: var(--text-muted); font-size: 1.2rem; padding: 4px;
}
.modal-close:hover { color: var(--text-primary); }

.modal-body { display: flex; flex-direction: column; gap: 16px; }

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding-top: 20px;
}

/* Danger zone inside modals */
.modal-danger-zone {
  border-top: 1px solid var(--border);
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.modal-danger-zone p {
  font-size: 13px;
  color: var(--text-muted);
}
.btn-danger {
  padding: 8px 16px; border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm); background: none;
  color: var(--color-danger); font-weight: 600; cursor: pointer;
  align-self: flex-start;
}
.btn-danger:hover { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
```

---

### Step 3 — Long-press utility

**File:** `pages/public/client/long-press.js` (new file)

A small utility that fires a `longpress` custom event on an element after the pointer has been held
still for the threshold duration. Cancels on move or pointer-up.

```js
const THRESHOLD_MS = 500
const MOVE_TOLERANCE_PX = 6

export function addLongPress(el, onLongPress) {
  let timer = null
  let startX = 0
  let startY = 0

  function start(e) {
    const pt = e.touches?.[0] ?? e
    startX = pt.clientX
    startY = pt.clientY
    timer = setTimeout(() => {
      timer = null
      onLongPress(e, el)
    }, THRESHOLD_MS)
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  function move(e) {
    const pt = e.touches?.[0] ?? e
    const dx = Math.abs(pt.clientX - startX)
    const dy = Math.abs(pt.clientY - startY)
    if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) cancel()
  }

  el.addEventListener('touchstart',  start,  { passive: true })
  el.addEventListener('touchmove',   move,   { passive: true })
  el.addEventListener('touchend',    cancel)
  el.addEventListener('touchcancel', cancel)

  // Also support mouse (for desktop testing)
  el.addEventListener('mousedown', start)
  el.addEventListener('mousemove', move)
  el.addEventListener('mouseup',   cancel)

  return () => {
    el.removeEventListener('touchstart',  start)
    el.removeEventListener('touchmove',   move)
    el.removeEventListener('touchend',    cancel)
    el.removeEventListener('touchcancel', cancel)
    el.removeEventListener('mousedown', start)
    el.removeEventListener('mousemove', move)
    el.removeEventListener('mouseup',   cancel)
  }
}
```

---

### Step 4 — Action sheet component

**File:** `pages/public/client/action-sheet.js` (new file)

Manages the shared action sheet DOM node. Only one sheet can be open at a time.

```js
let backdropEl = null
let sheetEl    = null

function ensureDOM() {
  if (backdropEl) return

  backdropEl = document.createElement('div')
  backdropEl.className = 'action-sheet-backdrop'
  backdropEl.innerHTML = `
    <div class="action-sheet" role="dialog" aria-modal="true">
      <div class="action-sheet-handle"></div>
      <div class="action-sheet-label"></div>
      <div class="action-sheet-items"></div>
    </div>
  `
  document.body.appendChild(backdropEl)
  sheetEl = backdropEl.querySelector('.action-sheet')

  // Tap backdrop to dismiss
  backdropEl.addEventListener('click', e => {
    if (e.target === backdropEl) dismiss()
  })

  // Swipe down to dismiss
  let startY = 0
  sheetEl.addEventListener('touchstart', e => { startY = e.touches[0].clientY }, { passive: true })
  sheetEl.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - startY > 60) dismiss()
  })
}

export function showActionSheet({ label, items }) {
  ensureDOM()

  backdropEl.querySelector('.action-sheet-label').textContent = label ?? ''
  const container = backdropEl.querySelector('.action-sheet-items')
  container.innerHTML = ''

  for (const item of items) {
    const btn = document.createElement('button')
    btn.className = 'action-sheet-item' + (item.danger ? ' danger' : '')
    btn.textContent = item.label
    btn.disabled = !!item.disabled
    btn.addEventListener('click', () => {
      dismiss()
      item.action?.()
    })
    container.appendChild(btn)
  }

  // Trigger open after a microtask so the CSS transition fires
  requestAnimationFrame(() => {
    backdropEl.classList.add('open')
    sheetEl.classList.add('open')
  })
}

export function dismiss() {
  backdropEl?.classList.remove('open')
  sheetEl?.classList.remove('open')
}
```

---

### Step 5 — Modal component

**File:** `pages/public/client/modal.js` (new file)

A generic modal host. Callers pass a title and a content-builder function that receives the modal
body element.

```js
let backdropEl = null
let modalEl    = null

function ensureDOM() {
  if (backdropEl) return

  backdropEl = document.createElement('div')
  backdropEl.className = 'modal-backdrop'
  backdropEl.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title"></span>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `
  document.body.appendChild(backdropEl)
  modalEl = backdropEl.querySelector('.modal')

  backdropEl.addEventListener('click', e => { if (e.target === backdropEl) dismiss() })
  backdropEl.querySelector('.modal-close').addEventListener('click', dismiss)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss() })
}

export function showModal({ title, build }) {
  ensureDOM()
  modalEl.querySelector('.modal-title').textContent = title
  const body = modalEl.querySelector('.modal-body')
  body.innerHTML = ''
  build(body)

  requestAnimationFrame(() => backdropEl.classList.add('open'))
}

export function dismiss() {
  backdropEl?.classList.remove('open')
}
```

---

### Step 6 — Hub management forms

These are helper functions used by both the action sheet (touch) and the modal (desktop). They build
the form HTML and wire up the WS send, keeping the logic in one place.

**File:** `pages/public/client/islands/sidebar.js`

```js
import { addLongPress }    from '../long-press.js'
import { showActionSheet } from '../action-sheet.js'
import { showModal, dismiss } from '../modal.js'

// ── Detect touch UI ──────────────────────────────────────────────────────────
const isTouch = () => window.matchMedia('(pointer: coarse)').matches

// ── Hub management ───────────────────────────────────────────────────────────

function buildHubForm(container, { hubId, hubName, hubDescription }) {
  container.innerHTML = `
    <div class="field">
      <label for="hub-name-input">Hub name</label>
      <input id="hub-name-input" type="text" value="${escHtml(hubName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="hub-desc-input">Description <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="hub-desc-input" type="text" value="${escHtml(hubDescription ?? '')}" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="hub-cancel-btn">Cancel</button>
      <button class="btn-primary" id="hub-save-btn">Save</button>
    </div>
  `
  container.querySelector('#hub-cancel-btn')?.addEventListener('click', dismiss)
  container.querySelector('#hub-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#hub-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'hub.update', body: {
      hub_id:      hubId,
      name,
      description: container.querySelector('#hub-desc-input').value.trim() || null
    }})
    dismiss()
  })
}

function openHubSheet(hubId, hubName) {
  showActionSheet({
    label: hubName,
    items: [
      { label: 'Edit hub name & description', action: () => openHubEditSheet(hubId, hubName) },
      { label: 'Create channel',              action: () => openCreateChannelSheet(hubId, hubName) },
      { label: 'Delete hub',                  disabled: true }  // future
    ]
  })
}

function openHubEditSheet(hubId, hubName) {
  // On touch: a second action sheet with an inline mini-form
  // Reuses buildHubForm inside the sheet's item container
  showActionSheet({
    label: 'Edit hub',
    items: []  // items area is replaced by the form below
  })
  const container = document.querySelector('.action-sheet-items')
  buildHubForm(container, { hubId, hubName })
}

function openHubModal(hubId, hubName, hubDescription) {
  showModal({
    title: 'Hub settings',
    build: (body) => buildHubForm(body, { hubId, hubName, hubDescription })
  })
}

// ── Channel management ───────────────────────────────────────────────────────

function buildChannelForm(container, { channelId, channelName, channelTopic }) {
  container.innerHTML = `
    <div class="field">
      <label for="ch-name-input">Channel name</label>
      <input id="ch-name-input" type="text" value="${escHtml(channelName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="ch-topic-input">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="ch-topic-input" type="text" value="${escHtml(channelTopic ?? '')}" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="ch-cancel-btn">Cancel</button>
      <button class="btn-primary" id="ch-save-btn">Save</button>
    </div>
  `
  container.querySelector('#ch-cancel-btn')?.addEventListener('click', dismiss)
  container.querySelector('#ch-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#ch-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'channel.update', body: {
      channel_id: channelId,
      name,
      topic: container.querySelector('#ch-topic-input').value.trim() || null
    }})
    dismiss()
  })
}

function openChannelSheet(channelId, channelName, channelTopic) {
  showActionSheet({
    label: channelName,
    items: [
      { label: 'Edit channel', action: () => openChannelEditSheet(channelId, channelName, channelTopic) },
      { label: 'Delete channel', disabled: true }  // future
    ]
  })
}

function openChannelModal(channelId, channelName, channelTopic) {
  showModal({
    title: 'Channel settings',
    build: (body) => buildChannelForm(body, { channelId, channelName, channelTopic })
  })
}

// ── Create channel ───────────────────────────────────────────────────────────

function buildCreateChannelForm(container, { hubId }) {
  container.innerHTML = `
    <div class="field">
      <label for="new-ch-name">Channel name</label>
      <input id="new-ch-name" type="text" placeholder="e.g. general" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-ch-topic">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="new-ch-topic" type="text" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="new-ch-cancel">Cancel</button>
      <button class="btn-primary" id="new-ch-save">Create</button>
    </div>
  `
  container.querySelector('#new-ch-cancel')?.addEventListener('click', dismiss)
  container.querySelector('#new-ch-save').addEventListener('click', () => {
    const name = container.querySelector('#new-ch-name').value.trim()
    if (!name) return
    ws.send({ t: 'channel.create', body: {
      hub_id: hubId,
      kind:   'text',
      name,
      topic:  container.querySelector('#new-ch-topic').value.trim() || null,
      visibility: 'public'
    }})
    dismiss()
  })
}

function openCreateChannelSheet(hubId, hubName) {
  showActionSheet({ label: `New channel in ${hubName}`, items: [] })
  buildCreateChannelForm(
    document.querySelector('.action-sheet-items'),
    { hubId }
  )
}

function openCreateChannelModal(hubId, hubName) {
  showModal({
    title: `New channel in ${hubName}`,
    build: (body) => buildCreateChannelForm(body, { hubId })
  })
}

// ── Attach handlers after island mounts ──────────────────────────────────────

function attachManagementHandlers(sidebarEl) {
  // Hub: long-press on summary (touch) or gear button click (desktop)
  sidebarEl.querySelectorAll('.hub-name').forEach(summary => {
    const hubId   = summary.dataset.hubId
    const hubName = summary.dataset.hubName

    if (isTouch()) {
      addLongPress(summary, () => openHubSheet(hubId, hubName))
    } else {
      summary.querySelector('.btn-hub-gear')?.addEventListener('click', e => {
        e.stopPropagation()   // prevent <details> toggle
        openHubModal(hubId, hubName, null)
      })
      summary.querySelector('.btn-hub-add')?.addEventListener('click', e => {
        e.stopPropagation()
        openCreateChannelModal(hubId, hubName)
      })
    }
  })

  // Channel: long-press on <a> (touch) or gear button click (desktop)
  sidebarEl.querySelectorAll('.channel-item').forEach(li => {
    const link        = li.querySelector('.channel-link')
    const channelId   = link?.dataset.channelId
    const channelName = link?.dataset.channelName
    const channelTopic = link?.dataset.channelTopic ?? null

    if (isTouch()) {
      addLongPress(link, () => openChannelSheet(channelId, channelName, channelTopic))
    } else {
      li.querySelector('.btn-channel-gear')?.addEventListener('click', e => {
        e.preventDefault()
        openChannelModal(channelId, channelName, channelTopic)
      })
    }
  })
}

// ── Escape-HTML helper ───────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c])
}
```

Call `attachManagementHandlers(sidebarEl)` at the end of the sidebar island's mount function, and
re-call it whenever new hub/channel rows are added reactively (after `hub.created` /
`channel.created` WS events update the DOM).

---

## Data Flow

```
Touch device (mobile + iPad)
─────────────────────────────
  User long-presses hub name (500ms hold)
    → long-press.js fires callback
    → openHubSheet() calls showActionSheet()
    → backdrop + sheet animate in
  User taps "Edit hub name & description"
    → dismiss() closes sheet
    → openHubEditSheet() opens a new sheet with inline form
  User fills in name, taps Save
    → ws.send({ t: 'hub.update', body: { hub_id, name, description } })
    → dismiss() closes sheet
    → sidebar.js ws.on('hub.updated') handler updates the hub name reactively

Desktop
────────
  User hovers over hub row
    → CSS reveals .btn-hub-gear via :hover
  User clicks gear icon
    → e.stopPropagation() prevents <details> toggle
    → openHubModal() calls showModal()
    → modal animates in (scale + opacity)
  User fills in form, clicks Save
    → ws.send({ t: 'hub.update', ... })
    → dismiss() closes modal
    → reactive update via WS event

Create channel (both surfaces)
───────────────────────────────
  Touch: long-press hub → "Create channel" → second sheet with form
  Desktop: click + button on hub row → modal with form
  → ws.send({ t: 'channel.create', body: { hub_id, kind, name, topic } })
  → sidebar.js ws.on('channel.created') adds new channel row
  → attachManagementHandlers() called again to wire the new row
```

---

## File Checklist

| File | Change | Type |
|---|---|---|
| `pages/channels/[channelId].phtml` | Add `data-hub-id`, `data-hub-name`, `data-channel-id`, `data-channel-name`, `data-channel-topic` attributes; add `.btn-hub-gear` and `.btn-channel-gear` buttons | Edit |
| `pages/public/themes/base.css` | Gear icon visibility rules; action sheet styles; modal styles; danger zone styles | Edit |
| `pages/public/client/long-press.js` | Reusable long-press gesture utility | New file |
| `pages/public/client/action-sheet.js` | Singleton action sheet: `showActionSheet()`, `dismiss()` | New file |
| `pages/public/client/modal.js` | Singleton modal: `showModal()`, `dismiss()` | New file |
| `pages/public/client/islands/sidebar.js` | `buildHubForm`, `buildChannelForm`, `buildCreateChannelForm`, `openHub*`, `openChannel*`, `attachManagementHandlers` — wire long-press (touch) and gear-click (desktop) | Edit |

---

## Out of Scope (follow-on)

- Hub visibility setting (public vs restricted)
- Channel visibility setting (public vs private)
- Channel kind (text vs voice) — set on creation only
- Member management (add, remove, ban)
- Channel invite link generation (`channel.invite_create`)
