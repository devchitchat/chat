# Direct Messages

## Goal

Add DMs as a first-class feature without a separate data model. DMs reuse the full channel
infrastructure — messages, deliveries, search, and WebSocket handlers all work unchanged.

---

## Model

DMs are private channels with `kind = 'dm'`. They are not attached to a hub (`hub_id = null`).

```
channels.kind       = 'dm'
channels.visibility = 'private'
channels.hub_id     = NULL
channels.name       = canonical form: 'dm:{sorted_user_a}:{sorted_user_b}'
```

The canonical name is a deterministic key — `findOrCreateDm` looks up by name and never creates
a duplicate. Sorting the two user IDs alphabetically before joining ensures
`dm:u_abc:u_xyz` is always the same regardless of who initiates.

---

## New service methods on `ChannelService`

```js
findOrCreateDm({ userId, targetUserId, now })
// → finds channel by canonical name, or creates it with both users as members
// → returns { channel_id, is_new }

listDms({ userId })
// → returns all channels where kind = 'dm' and userId is an active member
// → includes the other participant's display_name and online status (joined with PresenceService)
```

---

## Schema changes (migration)

- `channels.hub_id` — make nullable. `ALTER TABLE ... ALTER COLUMN` is not supported in SQLite;
  use the CREATE/INSERT/DROP/RENAME sequence:
  1. `CREATE TABLE channels_new (... hub_id TEXT, ...)`
  2. `INSERT INTO channels_new SELECT * FROM channels`
  3. `DROP TABLE channels`
  4. `ALTER TABLE channels_new RENAME TO channels`
- `channels.kind` — add `'dm'` to the valid set. Enforced in service, not a DB constraint.

---

## WebSocket message types

| Type | Direction | Body |
|---|---|---|
| `dm.open` | client → server | `{ target_user_id }` |
| `dm.opened` | server → client | `{ channel_id, is_new, with_user: { user_id, display_name } }` |

`dm.open` is the single entry point — the server handles find-or-create transparently. The
client never calls a "create DM" command directly.

---

## Current state

| Thing | State |
|---|---|
| `kind = 'dm'` on channels | Not built |
| Nullable `hub_id` | Not built |
| `findOrCreateDm` service method | Not built |
| `listDms` service method | Not built |
| `dm.open` / `dm.opened` WS handlers | Not built |
| DMs section in sidebar | Not built |
| User avatar → open DM gesture | Not built |

---

## Build sequence

Follow the inside-out rule from CLAUDE.md.

1. **Migration** — nullable `hub_id` on channels (CREATE/INSERT/DROP/RENAME)
2. **Core** — `buildDmChannelName(userIdA, userIdB)` pure function in `src/core/dm.js`
3. **Test** — `ChannelService.findOrCreateDm` with `InMemoryChannelRepository`; assert
   idempotency (calling twice returns the same `channel_id`)
4. **Service** — implement `findOrCreateDm`, `listDms` on `ChannelService`
5. **Adapter** — `findDmByName({ name })` and `listDmsByUser({ userId })` on
   `SqliteChannelRepository` and `InMemoryChannelRepository`
6. **Transport** — `dm.open` / `dm.opened` WS handler in `ChatServer.js`
7. **Client** — DMs section in sidebar fed by `listDms` on connect; clicking a user's
   avatar or name dispatches `dm.open`

---

## Key files to create or modify

| File | Change |
|---|---|
| `scripts/migrate/NNN-dm-channels.js` | Nullable `hub_id` migration |
| `src/core/dm.js` | `buildDmChannelName` pure function |
| `src/services/ChannelService.js` | `findOrCreateDm`, `listDms` |
| `src/adapters/SqliteChannelRepository.js` | `findDmByName`, `listDmsByUser` |
| `src/adapters/InMemoryChannelRepository.js` | Same, for tests |
| `src/ws/ChatServer.js` | `dm.open` handler, send DM list on connect |
| `pages/public/client/islands/sidebar.js` | DMs section |
| `pages/public/client/islands/chat.js` | User avatar → open DM tap/click target |
