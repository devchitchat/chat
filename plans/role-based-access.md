# Role-Based Access

## Goal

Extend the current binary role model (`admin` / `user`) with a `guest` role that restricts
visibility to explicitly granted channels only. Keep the model simple enough that a 1–10 person
team never needs to think about permissions.

---

## Design principles

1. **No permission tables.** Roles are values in `users.roles_json`. Access is computed at
   query/check time, not stored as a separate grant record.
2. **Guest overrides public visibility.** A guest can only see channels they are explicitly
   added to — public hub and channel visibility is invisible to them.
3. **Membership is still the primary gate.** The role system modifies *when* the membership
   check is required, not how membership works.

---

## Role hierarchy (system level)

| Role | Access |
|---|---|
| `admin` | Full access to everything; bypasses all visibility checks |
| `user` | Sees public hubs and channels; sees private channels they are a member of (current behaviour) |
| `guest` | Sees **only** channels they are explicitly added to; public visibility is invisible to them |

No other system roles in scope. Channel-level roles (`owner`, `mod`, `member`) are unchanged.

---

## Access logic changes

### `HubService.canAccessHub`

```js
// Current
if (hub.visibility === 'public') return true

// New — guests skip the public shortcut
if (hub.visibility === 'public' && !roles.includes('guest')) return true
```

A guest can still *technically* be in a public hub's channel if an admin adds them directly
— the hub membership check is skipped in favour of the channel membership check alone.

### `ChannelService.canAccessChannel`

```js
// Current
if (channel.visibility === 'public') return true

// New — guests must be explicit members regardless of channel visibility
if (channel.visibility === 'public' && !roles.includes('guest')) return true
```

### `ChannelService.listChannels` / `listAccessible`

The `listAccessible` repository query must be updated to exclude public channels for guest
users. Add a `isGuest` parameter to the query and wrap the public-visibility clause:

```sql
AND (
  (? = 0 AND c.visibility = 'public')   -- non-guest: public channels are visible
  OR EXISTS (
    SELECT 1 FROM channel_members cm
    WHERE cm.channel_id = c.channel_id
    AND cm.user_id = ?
    AND cm.left_at IS NULL AND cm.banned_at IS NULL
  )
)
```

### WS auth handshake

Guest role is carried in `ws.data.roles` (already present from session validation) — no
transport-layer changes needed.

---

## Admin operations

Admins can set any user's roles via the existing `AuthService.setUserRoles`. No new methods
needed. The admin panel UI (`pages/admin/users/`) should expose a role picker that includes
`guest` as an option.

---

## `readonly` channel member role (deferred)

A `readonly` value for `channel_members.role` is acknowledged as useful (bots that broadcast
but shouldn't receive @mentions, audit log pipes) but is out of scope for this plan. The slot
exists — add it when there is a concrete use case.

---

## Current state

| Thing | State |
|---|---|
| `admin` / `user` system roles | Exists |
| `guest` system role | Not built |
| `canAccessHub` guest check | Not built |
| `canAccessChannel` guest check | Not built |
| `listAccessible` guest filter | Not built |
| Admin panel role picker | Not built (UI only) |

---

## Build sequence

1. **Core** — `isGuest(roles)` helper in `src/core/roles.js`; `ROLES` constant list
2. **Test** — `HubService.canAccessHub` and `ChannelService.canAccessChannel` with a guest user
3. **Service** — update `canAccessHub`, `canAccessChannel` to check for guest role
4. **Adapter** — update `SqliteChannelRepository.listAccessible` with the `isGuest` branch;
   mirror in `InMemoryChannelRepository`
5. **Transport** — no WS changes needed; roles already flow through `ws.data.roles`
6. **Client (admin panel)** — add `guest` option to the role picker in
   `pages/admin/users/[userId].js`

---

## Key files to create or modify

| File | Change |
|---|---|
| `src/core/roles.js` | New — `ROLES` constant, `isGuest(roles)`, `isAdmin(roles)` helpers |
| `src/services/HubService.js` | Guest check in `canAccessHub` |
| `src/services/ChannelService.js` | Guest check in `canAccessChannel` |
| `src/adapters/SqliteChannelRepository.js` | `isGuest` branch in `listAccessible` query |
| `src/adapters/InMemoryChannelRepository.js` | Same, for tests |
| `pages/admin/users/[userId].js` | Role picker UI: add `guest` option |
