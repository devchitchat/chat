# User Settings & App State Persistence

## Goal

Persist per-user app state across sessions and devices:
- **Last channel visited** — redirect the user back to it on next load
- **Mobile view state** — remember whether the message panel or sidebar was showing

## Approach: Local-First with Server Sync

`localStorage` is the primary read/write target. It is synchronous, instant, and works offline. The server is a backup and cross-device sync target — not the source of truth during normal use.

The sync contract is simple: **last-write-wins**, using a Unix timestamp stored alongside the settings. When a fresh browser has no `localStorage` (new device, cleared storage), the server bootstraps it.

---

## Current State

- No `user_settings` table exists in the SQLite schema (`src/db/initDb.js`)
- `localStorage` is only used for theme preference (`pages/public/client/theme.js`)
- No API endpoints for user preferences exist
- The channel page handler (`pages/channels/[channelId].js`) does not read or write any user state beyond rendering

---

## Settings to Persist (initial scope)

| Key | Type | Description |
|---|---|---|
| `last_channel_id` | `string \| null` | The `channel_id` of the last channel the user visited |
| `mobile_chat_open` | `boolean` | Whether the message panel was visible on last mobile session |

The schema is extensible — new keys can be added without schema changes on either end.

---

## Architecture

```
On any setting change:
  localStorage.setItem(...)  ← immediate, synchronous
  syncToServer()             ← fire-and-forget in background

On page load (known device):
  read localStorage          ← instant, no network
  apply immediately          ← no layout flash
  syncFromServer()           ← background: reconcile if server is newer

On page load (fresh device / cleared storage):
  localStorage is empty
  GET /api/user/settings     ← bootstrap from server
  write to localStorage
  apply settings
```

```
Browser localStorage
  ↕  (background sync)
pages/api/user/settings.js   ← GET + PUT handler
  ↕
src/services/UserSettingsService.js
  ↕
SQLite: user_settings table
```

Server-side redirect (on `/` load) still uses the server's `last_channel_id` as a fallback for fresh devices before the client JS runs.

---

## Implementation Plan

---

### Step 1 — Add `user_settings` table to the schema

**File:** `src/db/initDb.js`

Add after the existing `deliveries` table definition:

```sql
CREATE TABLE IF NOT EXISTS user_settings (
  user_id       TEXT    NOT NULL PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  settings_json TEXT    NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
```

**Design notes:**
- One row per user — a single JSON blob keeps reads/writes to one query
- `updated_at` is a Unix timestamp used for last-write-wins reconciliation on the client
- `ON DELETE CASCADE` cleans up when a user is deleted
- `CREATE TABLE IF NOT EXISTS` is idempotent — safe to run on existing databases

---

### Step 2 — Create `UserSettingsService`

**File:** `src/services/UserSettingsService.js` (new file)

Follows the constructor-based DI pattern used by all existing services.

```js
export class UserSettingsService {
  #db
  #stmts

  constructor({ db }) {
    this.#db = db
    this.#stmts = {
      get: db.prepare(`
        SELECT settings_json, updated_at FROM user_settings WHERE user_id = ?
      `),
      upsert: db.prepare(`
        INSERT INTO user_settings (user_id, settings_json, updated_at)
          VALUES (?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE
          SET settings_json = excluded.settings_json,
              updated_at    = excluded.updated_at
        WHERE excluded.updated_at >= user_settings.updated_at
      `)
    }
  }

  // Returns { settings, updated_at } for a user, or { settings: {}, updated_at: 0 }
  getSettings(userId) {
    const row = this.#stmts.get.get(userId)
    if (!row) return { settings: {}, updated_at: 0 }
    try {
      return { settings: JSON.parse(row.settings_json), updated_at: row.updated_at }
    } catch {
      return { settings: {}, updated_at: 0 }
    }
  }

  // Saves settings only if client_updated_at >= stored updated_at (last-write-wins)
  putSettings(userId, settings, clientUpdatedAt) {
    this.#stmts.upsert.run(userId, JSON.stringify(settings), clientUpdatedAt)
    return this.getSettings(userId)
  }
}
```

**Key design:** The `WHERE excluded.updated_at >= user_settings.updated_at` clause in the upsert means a stale client can never overwrite a newer server record. The client always sends its own `updated_at` timestamp.

---

### Step 3 — Register the service in context

**File:** `src/context.js`

```js
import { UserSettingsService } from './services/UserSettingsService.js'

// Inside initContext():
export const userSettingsService = new UserSettingsService({ db })
```

---

### Step 4 — Create the API route handler

**File:** `pages/api/user/settings.js` (new file)

```js
import { sessionFromRequest, userSettingsService } from '../../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) return new Response('Unauthorized', { status: 401 })

  const result = userSettingsService.getSettings(session.user.user_id)
  return Response.json(result)  // { settings, updated_at }
}

export async function PUT(req) {
  const session = sessionFromRequest(req)
  if (!session) return new Response('Unauthorized', { status: 401 })

  let body
  try {
    body = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const { settings, updated_at } = body
  if (typeof updated_at !== 'number') return new Response('Bad Request', { status: 400 })

  // Allow-list keys — never persist arbitrary client data
  const allowed = new Set(['last_channel_id', 'mobile_chat_open'])
  const safe = Object.fromEntries(
    Object.entries(settings ?? {}).filter(([k]) => allowed.has(k))
  )

  const result = userSettingsService.putSettings(session.user.user_id, safe, updated_at)
  return Response.json(result)
}
```

**Request shape for PUT:**
```json
{ "settings": { "last_channel_id": "c_abc" }, "updated_at": 1714000000 }
```

**Response shape (both GET and PUT):**
```json
{ "settings": { "last_channel_id": "c_abc", "mobile_chat_open": false }, "updated_at": 1714000000 }
```

---

### Step 5 — Create the client-side sync module

**File:** `pages/public/client/settings-sync.js` (new file)

This module owns all `localStorage` reads/writes and background server sync. Islands import from here — they never touch `localStorage` or the API directly.

```js
const STORAGE_KEY = 'devchitchat_settings'
const ALLOWED_KEYS = new Set(['last_channel_id', 'mobile_chat_open'])

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeLocal(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

// Returns current settings object (instant, synchronous)
export function getSettings() {
  return readLocal().settings ?? {}
}

// Writes one or more keys, updates local timestamp, queues server sync
export function patchSettings(patch) {
  const local = readLocal()
  const updated_at = Math.floor(Date.now() / 1000)
  const settings = { ...(local.settings ?? {}), ...patch }
  writeLocal({ settings, updated_at })
  syncToServer(settings, updated_at)  // fire-and-forget
}

// Push local state to server (fire-and-forget)
async function syncToServer(settings, updated_at) {
  try {
    await fetch('/api/user/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, updated_at })
    })
  } catch {
    // Network failure — local state is still correct, server will sync next time
  }
}

// Pull from server and reconcile. Call once on page load.
// If localStorage is empty (fresh device), server wins.
// If both exist, the newer updated_at wins.
export async function syncFromServer() {
  try {
    const res = await fetch('/api/user/settings')
    if (!res.ok) return

    const remote = await res.json()  // { settings, updated_at }
    const local  = readLocal()
    const localUpdatedAt = local.updated_at ?? 0

    if (remote.updated_at > localUpdatedAt) {
      // Server is newer — overwrite local
      writeLocal({ settings: remote.settings, updated_at: remote.updated_at })
      return remote.settings
    } else if (localUpdatedAt > remote.updated_at) {
      // Local is newer — push to server
      syncToServer(local.settings, localUpdatedAt)
    }
    // Equal timestamps — no action needed
  } catch {
    // Network failure — proceed with local state
  }
}
```

---

### Step 6 — Bootstrap on page load

**File:** `pages/public/client/app.js`

Before islands mount, read local settings and apply them synchronously. Then kick off the background server reconciliation.

```js
import { getSettings, syncFromServer } from './settings-sync.js'

// --- Synchronous: apply settings before islands mount (no layout flash) ---
const settings = getSettings()

if (window.matchMedia('(max-width: 700px)').matches && settings.mobile_chat_open) {
  document.querySelector('.main-content')?.classList.add('channel-open')
}

// --- Async: reconcile with server in background ---
syncFromServer().then(remoteSettings => {
  if (!remoteSettings) return
  // If server had newer settings, re-apply them
  if (window.matchMedia('(max-width: 700px)').matches) {
    document.querySelector('.main-content')
      ?.classList.toggle('channel-open', !!remoteSettings.mobile_chat_open)
  }
})

// ...existing island mounting logic...
```

---

### Step 7 — Save `last_channel_id` from islands

**File:** `pages/public/client/islands/chat.js`

On mount, record the current channel:

```js
import { patchSettings } from '../settings-sync.js'

// In island mount — channelId is already available on the page
const channelId = document.querySelector('[data-channel-id]')?.dataset.channelId
if (channelId) patchSettings({ last_channel_id: channelId })
```

---

### Step 8 — Save `mobile_chat_open` on panel transitions

**File:** `pages/public/client/islands/chat.js` (or `mobile-nav.js` from the mobile-nav-slide plan)

```js
import { patchSettings } from '../settings-sync.js'

function openChannelOnMobile() {
  document.querySelector('.main-content')?.classList.add('channel-open')
  patchSettings({ mobile_chat_open: true })
}

function closeChannelOnMobile() {
  document.querySelector('.main-content')?.classList.remove('channel-open')
  patchSettings({ mobile_chat_open: false })
}
```

---

### Step 9 — Server-side redirect on root load (fresh-device fallback)

**File:** `pages/index.js` (or whichever handler serves `/` for authenticated users)

This only matters when `localStorage` is empty (new device, cleared storage) and client JS hasn't run yet. Read `last_channel_id` from the DB and redirect before the page renders:

```js
import { sessionFromRequest, userSettingsService } from '../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) return Response.redirect('/login', 302)

  const { settings } = userSettingsService.getSettings(session.user.user_id)
  if (settings.last_channel_id) {
    return Response.redirect(`/channels/${settings.last_channel_id}`, 302)
  }

  // Fall through to default landing page
}
```

On subsequent loads, the client-side `syncFromServer()` in `app.js` handles reconciliation without a server redirect.

---

## File Checklist

| File | Change | Type |
|---|---|---|
| `src/db/initDb.js` | Add `user_settings` table | Schema |
| `src/services/UserSettingsService.js` | New service: `getSettings`, `putSettings` | New file |
| `src/context.js` | Import + instantiate `UserSettingsService` | Edit |
| `pages/api/user/settings.js` | New `GET` + `PUT` handler with allow-list | New file |
| `pages/public/client/settings-sync.js` | New sync module: `getSettings`, `patchSettings`, `syncFromServer` | New file |
| `pages/public/client/app.js` | Apply settings synchronously on load; call `syncFromServer()` in background | Edit |
| `pages/public/client/islands/chat.js` | Import `patchSettings`; save channel + panel state | Edit |
| `pages/index.js` (or root handler) | Redirect to `last_channel_id` for fresh-device fallback | Edit |

---

## Data Flow Summary

```
Known device (localStorage populated)
──────────────────────────────────────
  1. app.js reads localStorage synchronously → applies settings (no flash)
  2. app.js calls syncFromServer() in background
  3. If server updated_at > local → overwrite local, re-apply
  4. If local updated_at > server → push local to server
  5. Islands mount with correct state already in place

Fresh device (empty localStorage)
───────────────────────────────────
  1. Browser hits / → server reads DB → 302 to /channels/<last_id>
  2. app.js reads localStorage → empty, nothing to apply
  3. syncFromServer() fetches settings → writes to localStorage → applies
  4. Islands mount (slight delay acceptable — only happens once per device)

Setting change (channel tap / panel toggle)
────────────────────────────────────────────
  1. Island calls patchSettings({ key: value })
  2. localStorage updated immediately with new updated_at timestamp
  3. syncToServer() fires in background (fire-and-forget)
  4. If network is down — local state is correct, server syncs on next load
```

---

## Out of Scope (future settings candidates)

- Notification preferences
- Theme (currently in `localStorage` via `theme.js`; could migrate into this system)
- Message density (compact vs. cozy)
- Sidebar collapsed state (which `<details>` hub elements are open)
