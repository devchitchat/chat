# User Settings

## Goal

Give each user a settings page (or panel) where they can manage personal preferences.
The `user_settings` table and `settings_json` column already exist — this plan is about
surfacing them through a UI and WS API.

## Initial settings to expose

| Setting | Type | Default | Notes |
|---|---|---|---|
| `push_enabled` | boolean | `true` | Opt out of browser push notifications |
| `push_subscription` | object | `null` | Stored server-side, not user-visible — managed via `push.subscribe` / `push.unsubscribe` |

More settings will be added as features are built (e.g. notification quiet hours,
theme preference, display name).

---

## WS API

| Message type | Direction | Body | Purpose |
|---|---|---|---|
| `settings.get` | client → server | — | Fetch current user's settings |
| `settings.get_result` | server → client | `{ settings }` | Current settings object |
| `settings.update` | client → server | `{ patch }` | Merge patch into settings |
| `settings.updated` | server → client | `{ settings }` | Confirmed updated settings |

`patch` is a shallow merge — only keys present in `patch` are changed. Unknown keys
are ignored (whitelist enforced server-side).

### Allowed keys (server whitelist)

```js
const ALLOWED_KEYS = new Set(['push_enabled'])
```

---

## Implementation steps

### 1. Service (`src/services/UserSettingsService.js`)

```js
export class UserSettingsService {
  constructor({ settingsRepo }) {
    this.settingsRepo = settingsRepo
  }

  getSettings(userId) {
    return this.settingsRepo.findByUser(userId) ?? {}
  }

  updateSettings(userId, patch) {
    const allowed = ['push_enabled']
    const safe = Object.fromEntries(
      Object.entries(patch).filter(([k]) => allowed.includes(k))
    )
    if (Object.keys(safe).length === 0) return this.getSettings(userId)
    const current = this.getSettings(userId)
    const merged = { ...current, ...safe }
    this.settingsRepo.upsert(userId, merged)
    return merged
  }
}
```

### 2. Repository (`src/adapters/SqliteUserSettingsRepository.js`)

```js
findByUser(userId) {
  const row = this.db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(userId)
  return row ? JSON.parse(row.settings_json) : null
}

upsert(userId, settings) {
  this.db.prepare(
    `INSERT INTO user_settings (user_id, settings_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(settings), Date.now())
}
```

### 3. WS handlers (`src/ws/handlers/settingsHandlers.js`)

Plain `(ws, msg, ctx)` functions, added to the router in `ChatServer.js`.

### 4. UI

A settings panel accessible from the topbar (gear icon or user avatar click).
Renders the user's current settings and allows editing. Sends `settings.update` on change.

Initially just a toggle: **"Browser push notifications"** (on/off).
If toggled off while a push subscription exists, also send `push.unsubscribe`.

### 5. Wire into `ChatServer.js`

- Add `UserSettingsService` and `SqliteUserSettingsRepository` to the constructor
- Add `settingsService` to `#ctx()`
- Add `settings.get` and `settings.update` cases to `#route`

---

## Key files

| File | Role |
|---|---|
| `src/services/UserSettingsService.js` | Business logic (new) |
| `src/adapters/SqliteUserSettingsRepository.js` | SQL (new) |
| `src/ws/handlers/settingsHandlers.js` | WS handlers (new) |
| `src/ws/ChatServer.js` | Wire service + handlers |
| `pages/channels/[channelId].phtml` | Settings panel trigger in topbar |
| `pages/public/client/islands/settings.js` | Settings island (new) |
| `pages/public/themes/base.css` | Settings panel styles |
