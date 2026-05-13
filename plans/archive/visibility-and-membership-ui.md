# Visibility & Membership Management UI

## Goal

Allow admins and channel owners to set and change hub and channel visibility through the UI,
and manage members of private channels. Currently visibility is hardcoded to `public` in all
create forms, and the server ignores visibility in update requests entirely.

---

## Current gaps

### Server

| Method | Gap |
|---|---|
| `HubService.updateHub` | Only patches `name` and `description` — ignores `visibility` |
| `ChannelService.updateChannel` | Only patches `name` and `topic` — ignores `visibility` |
| `hub.update` WS handler | Does not forward `visibility` to the service |
| `channel.update` WS handler | Does not forward `visibility` to the service |
| No `user.list` WS message | Needed for the member picker in private channel management |

### Client (sidebar.js)

| Form | Gap |
|---|---|
| `buildCreateHubForm` | Hardcodes `visibility: 'public'` |
| `buildCreateChannelForm` | Hardcodes `visibility: 'public'` |
| `buildHubForm` (edit) | No visibility picker; sends no visibility field |
| `buildChannelForm` (edit) | No visibility picker; no member management section |

No schema migration is required — `hubs.visibility` and `channels.visibility` already exist.

---

## Hub visibility

### Values

| Value | Meaning |
|---|---|
| `public` | Any authenticated user on the instance can see and join |
| `restricted` | Only explicitly added members can see it; guests are always restricted regardless |

### Service change — `HubService.updateHub`

Accept and apply an optional `visibility` field:

```js
updateHub({ hubId, userId, roles = [], name = null, description = null, visibility = null })
```

Validate that `visibility` is `'public'` or `'restricted'` if provided. Apply via
`hubRepo.patchHub`.

### `SqliteHubRepository.patchHub`

Already accepts arbitrary patch keys — add `visibility` to the allowed set.

---

## Channel visibility

### Values

| Value | Meaning |
|---|---|
| `public` | Any user who can access the hub can see and join |
| `private` | Only explicitly added members can see it |

### Service change — `ChannelService.updateChannel`

Accept and apply an optional `visibility` field:

```js
updateChannel({ channelId, userId, roles = [], name = null, topic = null, visibility = null })
```

Validate that `visibility` is `'public'` or `'private'` if provided. Apply via
`channelRepo.patchChannel`.

### Consequences of changing channel visibility

- `public` → `private`: existing members retain membership; non-members lose access immediately
- `private` → `public`: all hub members gain access; existing membership records are unaffected

No special migration of membership records is required for either direction.

---

## Member management for private channels

When a channel's visibility is `private`, the edit form needs a member section: who's currently
in the channel, and the ability to add anyone on the instance who isn't already a member.

### `user.list` WS message (new)

A lightweight non-admin query that returns basic user info for any authenticated user. Needed
so the member picker can show who's available to add without requiring admin access.

```
client → server: { t: 'user.list', body: {} }
server → client: { t: 'user.list_result', body: { users: [{ user_id, handle, display_name }] } }
```

Bots are excluded from the result — the picker is for human users only.

### `channel.list_members` WS message (new)

Returns the current active members of a channel. Required by the owner/mod to know who's
already in before offering the add picker.

```
client → server: { t: 'channel.list_members', body: { channel_id } }
server → client: { t: 'channel.list_members_result', body: { channel_id, members: [{ user_id, handle, display_name, role }] } }
```

`ChannelService.listChannelMembers` already exists — this is a thin transport wrapper.
The handler must verify the requester is a member with `owner` or `mod` role, or is `admin`.

---

## WS message changes

| Message | Change |
|---|---|
| `hub.update` | Forward optional `visibility` field to `HubService.updateHub` |
| `hub.updated` event | Include `visibility` in the broadcast body |
| `channel.update` | Forward optional `visibility` field to `ChannelService.updateChannel` |
| `channel.updated` event | Include `visibility` in the broadcast body |
| `user.list` | New — returns all non-bot users (user_id, handle, display_name) |
| `user.list_result` | New |
| `channel.list_members` | New — returns active members of a channel |
| `channel.list_members_result` | New |

---

## UI changes (sidebar.js)

### Create hub form

Add a visibility select below the description field:

```
Visibility
  ○ Public — visible to everyone on this instance
  ○ Restricted — only added members can see it
```

Default: Public.

### Create channel form

Add a visibility select below the topic field:

```
Visibility
  ○ Public — visible to everyone in this hub
  ○ Private — only added members can see it
```

Default: Public.

### Edit hub form (`buildHubForm`)

Add the same visibility select, pre-selected to the hub's current visibility. The current
visibility must be passed into the form builder (it is available in the `hubs` signal).

### Edit channel form (`buildChannelForm`)

Two additions:

**1. Visibility select** — same as create, pre-selected to the channel's current visibility.
The current visibility must be passed into the form builder.

**2. Members section** — shown only when `visibility === 'private'` (or after the user selects
private). On open, dispatches `channel.list_members` and `user.list`. Renders:

- Current members list with role badge (`owner`, `mod`, `member`)
- "Add member" picker: a `<select>` or filtered list of users not already in the channel,
  with an Add button that dispatches `channel.add_member`

The members section does not need to update reactively in real time — a single load on form
open is sufficient for a small team.

### Sidebar signal updates

The `channel.updated` event handler in the island must propagate `visibility` changes back
into the `hubs` signal so the form reflects the current state if reopened.

---

## Current state

| Thing | State |
|---|---|
| `HubService.updateHub` accepts `visibility` | Not built |
| `ChannelService.updateChannel` accepts `visibility` | Not built |
| `hub.update` WS forwards visibility | Not built |
| `channel.update` WS forwards visibility | Not built |
| `user.list` WS message | Not built |
| `channel.list_members` WS message | Not built |
| Visibility picker in create hub form | Not built |
| Visibility picker in create channel form | Not built |
| Visibility picker in edit hub form | Not built |
| Visibility picker in edit channel form | Not built |
| Member management section in edit channel form | Not built |

---

## Build sequence

1. **Service** — extend `HubService.updateHub` to accept and apply `visibility`
2. **Service** — extend `ChannelService.updateChannel` to accept and apply `visibility`
3. **Adapter** — extend `SqliteHubRepository.patchHub` and `SqliteChannelRepository.patchChannel`
   to include `visibility` in the patch set
4. **Test** — `updateHub` and `updateChannel` with visibility changes
5. **Transport** — update `hub.update` and `channel.update` WS handlers to forward `visibility`;
   include `visibility` in `hub.updated` and `channel.updated` broadcast bodies
6. **Transport** — add `user.list` WS handler (exclude bots from result)
7. **Transport** — add `channel.list_members` WS handler (auth: owner, mod, or admin)
8. **Client** — add visibility pickers to `buildCreateHubForm` and `buildCreateChannelForm`
9. **Client** — add visibility picker to `buildHubForm` (edit); pass current visibility in
10. **Client** — add visibility picker to `buildChannelForm` (edit); pass current visibility in
11. **Client** — add members section to `buildChannelForm`; load on open via `user.list` and
    `channel.list_members`; wire `channel.add_member` dispatch from the picker
12. **Client** — update `channel.updated` handler in the island to propagate `visibility` into
    the `hubs` signal

---

## Key files to modify

| File | Change |
|---|---|
| `src/services/HubService.js` | `updateHub` accepts `visibility` |
| `src/services/ChannelService.js` | `updateChannel` accepts `visibility` |
| `src/adapters/SqliteHubRepository.js` | `patchHub` applies `visibility` |
| `src/adapters/SqliteChannelRepository.js` | `patchChannel` applies `visibility` |
| `src/adapters/InMemoryHubRepository.js` | Same, for tests |
| `src/adapters/InMemoryChannelRepository.js` | Same, for tests |
| `src/ws/ChatServer.js` | Forward visibility in update handlers; add `user.list` and `channel.list_members` handlers |
| `pages/public/client/islands/sidebar.js` | Visibility pickers in all forms; member section in channel edit form |
