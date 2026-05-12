# Hub Membership Management

## Goal

Allow admins and hub owners to create restricted hubs and manage who can access them. A user
with access to a restricted hub sees all public channels inside it. A user without access sees
nothing — not even the hub's public channels.

---

## Access model (stated clearly)

| Hub visibility | Channel visibility | User state | Can see channel? |
|---|---|---|---|
| `public` | `public` | any authenticated user | yes |
| `public` | `private` | not a channel member | no |
| `public` | `private` | channel member | yes |
| `restricted` | `public` | not a hub member | no |
| `restricted` | `public` | hub member | yes |
| `restricted` | `private` | hub member, not channel member | no |
| `restricted` | `private` | hub member + channel member | yes |
| `restricted` | `private` | not a hub member | no |

---

## Bug: `listAccessible` shows private channels to hub members

`SqliteChannelRepository.listAccessible` (and its `InMemoryChannelRepository` mirror) contains:

```sql
OR EXISTS (
  SELECT 1 FROM hub_members hm
  WHERE hm.hub_id = h.hub_id AND hm.user_id = ? AND hm.left_at IS NULL
)
```

This makes **all** channels — including private ones — visible to hub members. The correct
behaviour is that hub membership only grants visibility to **public** channels in the hub.

### Fix

```sql
OR (c.visibility = 'public' AND EXISTS (
  SELECT 1 FROM hub_members hm
  WHERE hm.hub_id = h.hub_id AND hm.user_id = ? AND hm.left_at IS NULL
))
```

`canAccessChannel` is already correct — the bug is only in the list query.

The same fix applies to `listAccessibleInHub` if it has a similar clause.

---

## New service methods on `HubService`

```js
addHubMember({ hubId, targetUserId, requestingUserId, requestingRoles })
// → admin or hub creator only
// → upserts hub_members row (handles re-add after left_at)
// → throws NOT_FOUND if hub does not exist
// → throws FORBIDDEN if requester is not admin or hub creator
// → returns { hub_id, user_id }

removeHubMember({ hubId, targetUserId, requestingUserId, requestingRoles })
// → admin or hub creator only
// → sets left_at on the hub_members row
// → returns { hub_id, user_id }

listHubMembers({ hubId, requestingUserId, requestingRoles })
// → any hub member or admin
// → returns [{ user_id, handle, display_name, joined_at }]
```

`joinHub` and `leaveHub` (self-service) remain unchanged — they are still the mechanism for
public hubs where users join themselves.

---

## New repository methods on `SqliteHubRepository`

```js
listMembers({ hubId })
// → SELECT users.user_id, users.handle, users.display_name, hub_members.joined_at
//   FROM hub_members JOIN users ... WHERE hub_id = ? AND left_at IS NULL
```

`upsertMembership` already exists and handles the add case. `setMemberLeft` already handles
the remove case. No new write methods needed.

---

## WebSocket message types

| Type | Direction | Auth | Body |
|---|---|---|---|
| `hub.add_member` | client → server | admin or hub creator | `{ hub_id, user_id }` |
| `hub.member_added` | server → client | — | `{ hub_id, user_id }` |
| `hub.remove_member` | client → server | admin or hub creator | `{ hub_id, user_id }` |
| `hub.member_removed` | server → client | — | `{ hub_id, user_id }` |
| `hub.list_members` | client → server | hub member or admin | `{ hub_id }` |
| `hub.list_members_result` | server → client | — | `{ hub_id, members: [{ user_id, handle, display_name, joined_at }] }` |

`hub.member_added` and `hub.member_removed` are broadcast to all current hub members so their
sidebar can react (e.g., if the hub is renamed or deleted while they're viewing it). The newly
added member receives the broadcast via their `user:<id>` topic since they may not be subscribed
to the hub topic yet.

`user.list` (from `visibility-and-membership-ui.md`) is reused by the member picker to get the
full user list to select from.

---

## UI changes (sidebar.js)

### Hub edit form (`buildHubForm`)

Add a **Members** section below the name/description fields, visible only when
`visibility === 'restricted'` (or after the user switches to restricted via the visibility
picker from `visibility-and-membership-ui.md`).

On form open, dispatches `hub.list_members` and `user.list`. Renders:

**Current members list:**
```
Joey Guerra  [owner]
Marisol Vega  [member]  [Remove]
```
The hub creator/owner row has no Remove button — owners cannot remove themselves via this UI.

**Add member picker:**
A `<select>` populated with users not already in the hub. "Add" button dispatches
`hub.add_member`. Bots are excluded.

The members list does not need real-time reactivity — a single load on form open is sufficient.

### Visibility picker interaction

When the admin switches a hub from `public` to `restricted` in the edit form, the members
section appears. It is empty except for the creator. The admin adds members before saving, or
saves first and adds members after.

Switching from `restricted` back to `public` hides the members section in the form. Existing
membership records are not removed — if the hub is made restricted again, those members still
have access.

---

## Access enforcement on `hub.add_member` / `hub.remove_member`

Only **admin** or the **hub creator** (`hub.created_by_user_id === requestingUserId`) may add
or remove members. Channel owners/mods have no hub-level management rights.

---

## Current state

| Thing | State |
|---|---|
| `listAccessible` hub-member clause filters by channel visibility | Bug — does not filter |
| `listAccessibleInHub` same check | Needs audit |
| `HubService.addHubMember` | Not built |
| `HubService.removeHubMember` | Not built |
| `HubService.listHubMembers` | Not built |
| `SqliteHubRepository.listMembers` | Not built |
| `InMemoryHubRepository.listMembers` | Not built |
| `hub.add_member` WS handler | Not built |
| `hub.remove_member` WS handler | Not built |
| `hub.list_members` WS handler | Not built |
| Members section in hub edit form | Not built |

---

## Build sequence

1. **Bug fix** — correct the `listAccessible` query in `SqliteChannelRepository` and
   `InMemoryChannelRepository`; audit `listAccessibleInHub` for the same issue
2. **Test** — hub member can see public channels but not private channels in a restricted hub;
   non-member cannot see any channels in a restricted hub
3. **Repository** — add `listMembers({ hubId })` to `SqliteHubRepository` and
   `InMemoryHubRepository`
4. **Service** — implement `addHubMember`, `removeHubMember`, `listHubMembers` on `HubService`
5. **Test** — `addHubMember` and `removeHubMember` access control; `listHubMembers` visibility
6. **Transport** — `hub.add_member`, `hub.remove_member`, `hub.list_members` WS handlers in
   `ChatServer.js`
7. **Client** — members section in `buildHubForm`; wire `hub.list_members`, `user.list`,
   `hub.add_member`, `hub.remove_member` dispatches

Note: the visibility picker in `buildHubForm` (to set `restricted` vs `public`) is specified
in `visibility-and-membership-ui.md` and must be built first or in parallel for the members
section to appear at the right time.

---

## Key files to create or modify

| File | Change |
|---|---|
| `src/adapters/SqliteChannelRepository.js` | Fix `listAccessible` hub-member clause; audit `listAccessibleInHub` |
| `src/adapters/InMemoryChannelRepository.js` | Same fix |
| `src/adapters/SqliteHubRepository.js` | Add `listMembers` |
| `src/adapters/InMemoryHubRepository.js` | Add `listMembers` |
| `src/services/HubService.js` | Add `addHubMember`, `removeHubMember`, `listHubMembers` |
| `src/ws/ChatServer.js` | Add `hub.add_member`, `hub.remove_member`, `hub.list_members` handlers |
| `pages/public/client/islands/sidebar.js` | Members section in `buildHubForm` |
