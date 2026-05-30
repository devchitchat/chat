# Admin Panel — Plan

Two admin pages served at `/admin/*`: invite management and bot management.
Both share the same admin auth middleware and layout.

---

## Shared admin infrastructure

### Auth middleware

Every `/admin/*` route needs an auth gate — no admin role → 302 to `/login`.
index97 has no middleware layer, so each handler does it explicitly via a shared
helper:

```js
// src/adminAuth.js
import { sessionFromRequest } from './context.js'
import { ServiceError } from './errors.js'

export function requireAdminSession(req) {
  const session = sessionFromRequest(req)
  if (!session) return Response.redirect(new URL('/login', req.url), 302)
  if (!session.user.roles.includes('admin')) {
    return new Response('Forbidden', { status: 403 })
  }
  return null   // null = access granted
}
```

Each handler calls `const deny = requireAdminSession(req); if (deny) return deny` at the top.

### Admin layout

A new `pages/admin/_layout.html` (or inline in each phtml) with a simple nav bar
linking between `/admin/invites` and `/admin/bots`. Extends the base CSS — no
new stylesheets needed; use existing `.btn-primary`, `.btn-ghost`, `.btn-danger`,
form and table patterns from base.css.

### Navigation link from the topbar

Add an "Admin" link in `pages/_layout.html` that renders only when
`{{#if isAdmin}}`. The layout handler in `pages/_layout.js` (or inlined per
route) appends `isAdmin: session?.user?.roles?.includes('admin') ?? false` to
the template context.

---

## Part 1 — Invite management (`/admin/invites`)

### What it does

- List all invites with their status, creator, expiry, use count, and note
- Create a new invite (note, TTL preset, max uses)
- Copy the shareable link to clipboard
- Revoke (hard-delete) an invite before it expires

### Screen layout

```
Admin › Invites

[+ Create invite]

Token (truncated)  Note       Expires        Uses     Status    Action
────────────────────────────────────────────────────────────────────────
abc123…            For Alice  in 2 days      0 / 1    active    [Copy] [Revoke]
def456…            —          2 days ago     1 / 1    used      —
ghi789…            For Bob    3 hours ago    0 / 3    expired   [Revoke]
```

Create form (inline above the table, toggles open):
- Note (optional free text)
- Expires in: 1 day / 7 days / 30 days / never  (select, default 7 days)
- Max uses: 1 / 5 / unlimited  (select, default 1)
- [Create] button → POST /admin/invites → redirect back

### Backend additions

#### Repository — `SqliteAuthRepository`

Add two methods:

```js
listInvites() {
  return this.db.query(`
    SELECT i.*, u.handle AS created_by_handle
    FROM invites i
    LEFT JOIN users u ON u.user_id = i.created_by_user_id
    ORDER BY i.created_at DESC
  `).all()
}

deleteInvite(inviteId) {
  this.db.query(`DELETE FROM invites WHERE invite_id = ?`).run(inviteId)
}
```

#### Service — `AuthService`

```js
listInvites({ requestingUserId }) {
  this.requireAdmin(requestingUserId)
  return this.authRepo.listInvites()
}

revokeInvite({ inviteId, requestingUserId }) {
  this.requireAdmin(requestingUserId)
  this.authRepo.deleteInvite(inviteId)
}
```

#### WS handlers — `ChatServer.js`

Two new message types (so admins can also do this programmatically):

```
admin.invite_list   → admin.invite_list_result  (body: { invites: [...] })
admin.invite_revoke → admin.invite_revoked       (body: { invite_id })
```

#### HTTP routes — `pages/admin/invites/`

```
pages/admin/invites/index.js    GET (list) + POST (create + revoke via ?_action=)
pages/admin/invites/index.phtml template
```

`GET /admin/invites`:
```js
export async function GET(req) {
  const deny = requireAdminSession(req)
  if (deny) return deny
  const session = sessionFromRequest(req)
  const invites = auth.listInvites({ requestingUserId: session.user.user_id })
  const base = new URL(req.url).origin
  return { invites: invites.map(i => ({
    ...i,
    link: `${base}/invite/${i.token}`,   // NOTE: token must be stored or re-derivable
    status: deriveStatus(i),
  })) }
}
```

**Problem:** the invite token is hashed before storage; only the hash is stored.
The plain token is returned once at creation time and not stored. So the admin
list can't show a usable link for old invites.

**Fix:** store the plain token (or a reversible encoding) in a new
`token_display` column, or return the full invite link only at creation time
(already done — the create response returns `invite_token`). The list shows a
`[Copy]` button only for newly-created invites (stored in the session flash or
returned in the POST redirect location).

Simplest implementation: the list shows the `invite_id` (truncated) and the
`note`, but the copyable link is shown immediately after creation via the
redirect URL carrying the token in a query param (one-time display, like a
password manager). Example:

```
POST /admin/invites → 302 /admin/invites?created=<token>&note=For+Alice
```

The GET handler checks for `?created=` and shows a dismissable banner:
```
✓ Invite created for "For Alice"
  https://yourhost/invite/abc123def456…   [Copy]
```

`POST /admin/invites`:
```js
export async function POST(req) {
  const deny = requireAdminSession(req)
  if (deny) return deny
  const session = sessionFromRequest(req)
  const form = await req.formData()
  const action = form.get('_action')

  if (action === 'create') {
    const note    = form.get('note')?.trim() || null
    const ttlDays = parseInt(form.get('ttl_days') ?? '7', 10)
    const maxUses = form.get('max_uses') === 'unlimited' ? 999999 : parseInt(form.get('max_uses') ?? '1', 10)
    const result  = auth.createInvite({
      createdByUserId: session.user.user_id,
      ttlMs:   ttlDays > 0 ? ttlDays * 86400_000 : 100 * 365 * 86400_000,
      maxUses,
      note,
    })
    const params = new URLSearchParams({ created: result.inviteToken, note: note ?? '' })
    return Response.redirect(new URL(`/admin/invites?${params}`, req.url), 302)
  }

  if (action === 'revoke') {
    const inviteId = form.get('invite_id')
    auth.revokeInvite({ inviteId, requestingUserId: session.user.user_id })
    return Response.redirect(new URL('/admin/invites', req.url), 302)
  }
}
```

### No schema changes needed

The `invites` table already has everything required. The `listInvites` query joins
with `users` to get the creator's handle.

---

## Part 2 — Bot management (`/admin/bots`)

### What a bot is

A bot is a user account with the `bot` role in `roles_json`. It authenticates
to the WebSocket using a long-lived API token (not a session cookie). The bot
appears in channels like a regular user and can send messages, but it cannot
log in through the browser.

The chatops-bot service (from `plans/chatbot-system.md`) connects using one of these
bot tokens.

### Schema additions

#### Migration: `scripts/migrate/NNN-add-bot-tokens.js`

```js
export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_tokens (
      token_id    TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      label       TEXT,
      created_at  INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at  INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );
  `)
}
```

No changes to the `users` table. The `bot` role is another value in `roles_json`
(same mechanism as `admin` and `user`).

### What admin bot management does

- List bot user accounts (users with `bot` in roles)
- Create a new bot (name, handle) — generates user record + first API token
- Show/copy API token only at creation time (same one-time-display pattern)
- Revoke a token, generate a replacement
- See which channels the bot is a member of
- Add/remove the bot from channels (calls `channel.join` / `channel.leave` on
  behalf of the bot via the service layer directly, no WS needed)
- Delete a bot (soft: revoke all tokens + remove from channels)

### Screen layout

```
Admin › Bots

[+ Create bot]

Handle         Display name   Channels          Tokens    Action
──────────────────────────────────────────────────────────────────
@chatops-bot   Chatops Bot        #general, #dev    1 active  [Manage]
```

Bot detail / manage view (`/admin/bots/:userId`):

```
@chatops-bot  —  Chatops Bot

Tokens
──────────────────────────────
"devchitchat-prod"  created 3 days ago  last used 1 hour ago  [Revoke]
[+ New token]

Channels
────────────────────────────────────────────────────────────────
☑  #general (hub: Main)
☐  #dev     (hub: Main)
[Save channels]
```

### Backend additions

#### Repository — `SqliteAuthRepository`

```js
// Bot user creation (no password — bots don't log in via browser)
insertBotUser({ userId, handle, displayName, now }) {
  this.db.query(`
    INSERT INTO users (user_id, handle, display_name, roles_json, password_hash, created_at)
    VALUES (?, ?, ?, '["bot"]', NULL, ?)
  `).run(userId, handle, displayName, now)
}

listBotUsers() {
  return this.db.query(`SELECT * FROM users WHERE roles_json LIKE '%"bot"%' ORDER BY created_at DESC`).all()
}

insertBotToken({ tokenId, userId, tokenHash, label, now }) {
  this.db.query(`
    INSERT INTO bot_tokens (token_id, user_id, token_hash, label, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenId, userId, tokenHash, label, now)
}

listBotTokens(userId) {
  return this.db.query(`SELECT * FROM bot_tokens WHERE user_id = ? AND revoked_at IS NULL`).all(userId)
}

revokeBotToken({ tokenId, now }) {
  this.db.query(`UPDATE bot_tokens SET revoked_at = ? WHERE token_id = ?`).run(now, tokenId)
}

findBotTokenByHash(tokenHash) {
  return this.db.query(
    `SELECT bt.*, u.user_id, u.handle, u.display_name, u.roles_json
     FROM bot_tokens bt JOIN users u ON u.user_id = bt.user_id
     WHERE bt.token_hash = ? AND bt.revoked_at IS NULL`
  ).get(tokenHash)
}

touchBotToken({ tokenId, now }) {
  this.db.query(`UPDATE bot_tokens SET last_used_at = ? WHERE token_id = ?`).run(now, tokenId)
}
```

#### Service — `BotService` (new file: `src/services/BotService.js`)

```js
export class BotService {
  constructor({ authRepo, channelRepo, channelService, nowFn = Date.now }) { ... }

  createBot({ handle, displayName, tokenLabel, createdByUserId }) {
    // check handle uniqueness, create user, generate first token
    const userId = newId('u')
    const token  = randomToken()
    this.authRepo.insertBotUser({ userId, handle, displayName, now: this.nowFn() })
    const tokenResult = this._createToken({ userId, label: tokenLabel })
    return { userId, handle, displayName, ...tokenResult }
  }

  createToken({ userId, label, requestingUserId }) {
    this._requireAdminOrSelf(requestingUserId, userId)
    return this._createToken({ userId, label })
  }

  _createToken({ userId, label }) {
    const token = randomToken()
    const tokenId = newId('bt')
    this.authRepo.insertBotToken({
      tokenId, userId,
      tokenHash: hashToken(token),
      label: label ?? null,
      now: this.nowFn(),
    })
    return { tokenId, token }   // plain token returned once; hash stored
  }

  revokeToken({ tokenId, requestingUserId }) {
    // admin check …
    this.authRepo.revokeBotToken({ tokenId, now: this.nowFn() })
  }

  listBots({ requestingUserId }) {
    // admin check …
    return this.authRepo.listBotUsers()
  }

  authenticateToken(plainToken) {
    const row = this.authRepo.findBotTokenByHash(hashToken(plainToken))
    if (!row) throw new ServiceError('UNAUTHORIZED', 'Invalid bot token')
    this.authRepo.touchBotToken({ tokenId: row.token_id, now: this.nowFn() })
    return { userId: row.user_id, handle: row.handle, displayName: row.display_name, roles: JSON.parse(row.roles_json) }
  }
}
```

Wire `BotService` in `src/context.js` alongside the existing services.

#### WS auth — `ChatServer.js` `hello` handler

The `hello` message currently accepts `{ resume: { session_token } }`. Extend it
to also accept a `bot_token`:

```js
#handleHello(ws, msg) {
  const { session_token, bot_token } = msg.body?.resume ?? {}

  if (bot_token) {
    const bot = this.botService.authenticateToken(bot_token)
    ws.data.userId = bot.userId
    ws.data.roles  = bot.roles
    this.#sendWs(ws, { t: 'hello_ack', body: { user_id: bot.userId } })
    return
  }
  // …existing session_token path
}
```

Bots then send `channel.join` for each channel they want to listen to, exactly
like a human client. No special handling needed in message handlers.

#### WS handlers for bot management (programmatic access)

```
admin.bot_create   → admin.bot          (body: { user_id, handle, token })
admin.bot_list     → admin.bot_list_result
admin.bot_token_create → admin.bot_token  (body: { token })
admin.bot_token_revoke → admin.bot_token_revoked
```

#### HTTP routes — `pages/admin/bots/`

```
pages/admin/bots/index.js        GET (list)
pages/admin/bots/index.phtml
pages/admin/bots/create/index.js POST (create bot)
pages/admin/bots/[userId].js     GET (detail) + POST (revoke token, save channels)
pages/admin/bots/[userId].phtml
```

`GET /admin/bots`: list all bot users. Server-rendered, no island needed.

`POST /admin/bots/create`:
- `_action=create`: creates bot + first token, redirects to detail page with
  `?token=<plain>` for one-time display.

`GET /admin/bots/:userId`: show tokens and channel membership.
- Calls `botService.listBots()` for the user
- Calls `channelService.listChannels(botUserId, ['bot'])` to get joined channels
- Calls `channelService.listAllChannels()` (admin view) for the checkbox list

`POST /admin/bots/:userId`:
- `_action=new_token`: generate a replacement token, redirect with `?token=<plain>`
- `_action=revoke_token`: revoke `token_id` from form
- `_action=save_channels`: diff the current channel membership vs the submitted
  checkbox set, call `channelService.joinChannel` / `leaveChannel` for each delta

### Channel membership for bots

Bots join channels via the existing `channel_members` table — same path as
human users. The admin UI's "save channels" POST calls the service directly,
not via WS. The bot's WS client (when running) will then call `channel.join`
on startup to subscribe to the pub/sub topic for live events.

---

## File checklist

| File | Change |
|---|---|
| `src/adminAuth.js` | New — `requireAdminSession` helper |
| `src/services/BotService.js` | New — bot CRUD + token auth |
| `src/context.js` | Wire `BotService` |
| `src/adapters/SqliteAuthRepository.js` | Add bot user + token repo methods |
| `src/ws/ChatServer.js` | Extend `hello` handler for `bot_token`; add admin WS handlers |
| `scripts/migrate/NNN-add-bot-tokens.js` | New — `bot_tokens` table |
| `pages/_layout.html` | Add conditional Admin nav link |
| `pages/admin/invites/index.js` | New — invite list + create + revoke |
| `pages/admin/invites/index.phtml` | New — invite list template |
| `pages/admin/bots/index.js` | New — bot list |
| `pages/admin/bots/index.phtml` | New — bot list template |
| `pages/admin/bots/[userId].js` | New — bot detail, token mgmt, channel assignment |
| `pages/admin/bots/[userId].phtml` | New — bot detail template |

No changes to the `users` table. No changes to existing service interfaces.
Invite management requires only new repository query methods (no migration —
`invites` table already exists).

---

## Build order

```
1. src/adminAuth.js                       — shared guard, used by all admin routes
2. scripts/migrate/NNN-add-bot-tokens.js  — run migration
3. SqliteAuthRepository: listInvites, deleteInvite  (invite side)
4. AuthService: listInvites, revokeInvite
5. pages/admin/invites/*                  — invite UI (no island — pure form posts)
6. pages/_layout.html: Admin link         — verify only admins see it
7. SqliteAuthRepository: bot methods      (bot side)
8. BotService (src/services/BotService.js)
9. src/context.js: wire BotService
10. ChatServer.js: bot_token in hello handler + admin WS handlers
11. pages/admin/bots/*                   — bot list + detail UI
12. Integration test: bot WS auth flow
```

---

## Out of scope

- Admin user management (promote/demote users, ban) — follow-on
- Invite analytics (who redeemed which invite) — data exists in `redeemed_by_user_id`;
  surface it in the list later
- OAuth / SSO bot auth — bot tokens are sufficient for self-hosted use
- Bot rate limiting — follow-on
- Bot message formatting / slash command routing — that lives in the chatops-bot service,
  not in devchitchat itself
- The llm-bun and chatops-bot services themselves — covered in `plans/chatbot-system.md`
