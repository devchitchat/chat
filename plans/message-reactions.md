# Message Reactions

**Goal:** Let any user (including bots) react to a message with any emoji. Reactions are real-time
broadcast to all channel members. On desktop, a right-click context menu opens the emoji picker.
On mobile, a long-press slides up an action panel from the bottom.

---

## UX

### Desktop — right-click context menu

Right-clicking a message article shows a floating context menu anchored near the cursor:

```
┌─────────────────────┐
│  React              │
│  Reply    (future)  │
│  Edit     (future)  │
│  Delete   (future)  │
└─────────────────────┘
```

Clicking "React" opens the emoji picker inline, replacing the context menu. The picker closes when
focus leaves it (click-outside or Escape).

### Mobile — long-press bottom sheet

Long-pressing a message slides up a sheet from the bottom edge:

```
┌─────────────────────────────────────────────┐
│  React to this message                      │
│  ┌────────────────────────────────────────┐ │
│  │  🔍 Search emoji…                      │ │
│  │  😀 😂 ❤️ 👍 👎 🔥 ✅ 🎉 🚀 👀        │ │
│  │  [Smileys] [People] [Objects] [Symbols]│ │
│  └────────────────────────────────────────┘ │
│  Reply (future)  •  Edit (future)           │
└─────────────────────────────────────────────┘
```

### Reaction bar

Reactions are displayed as pill buttons below the message text:

```
👍 3   ❤️ 1   🔥 2+you
```

- Each pill shows the emoji and the count.
- If the current user has reacted with that emoji, the pill is highlighted.
- Clicking a pill toggles the reaction (add if not reacted, remove if already reacted).
- A `+` button at the end of the bar opens the emoji picker to add a new reaction.

---

## Emoji Picker

A self-contained component, shared by both desktop (context menu) and mobile (bottom sheet).
No external library — built from a static `emoji-data.js` module.

### Structure

```
┌──────────────────────────────────────────┐
│  🔍  [search input]                      │
│  😀  👋  🐾  🍕  ⚽  🌍  ✈️  🔣  #     │  ← category tabs
│──────────────────────────────────────────│
│  😀 😃 😄 😁 😆 😅 😂 🤣 ☺️ 😊 😇    │
│  🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋    │
│  …                                       │
└──────────────────────────────────────────┘
```

### Emoji data (`pages/public/client/emoji-data.js`)

A static ES module: `~500 emoji` across 9 categories, plus a name map for search.
Curated set — common and useful, not the full Unicode 15 inventory.

```js
export const CATEGORIES = [
  { id: 'recent',   label: '🕐', emoji: [] },   // populated from localStorage
  { id: 'smileys',  label: '😀', emoji: ['😀', '😂', '❤️', '😍', ...] },
  { id: 'people',   label: '👋', emoji: ['👍', '👎', '👏', '🙌', ...] },
  { id: 'animals',  label: '🐾', emoji: ['🐶', '🐱', '🦊', ...] },
  { id: 'food',     label: '🍕', emoji: ['🍕', '🍔', '🍺', '☕', ...] },
  { id: 'activity', label: '⚽', emoji: ['⚽', '🏆', '🎯', '🎉', ...] },
  { id: 'travel',   label: '🌍', emoji: ['🚀', '✈️', '🏠', ...] },
  { id: 'objects',  label: '💡', emoji: ['🔥', '✅', '❌', '⚠️', '🔑', ...] },
  { id: 'symbols',  label: '🔣', emoji: ['❤️', '💯', '✨', '⭐', ...] },
]

export const EMOJI_NAMES = {
  '😀': 'grinning face',
  '👍': 'thumbs up',
  // …
}
```

"Recently used" is stored in `localStorage` under `devchitchat_recent_emoji` (capped at 24 entries,
most-recent-first). Populated when the user picks an emoji.

---

## Data Model

### Migration `009-message-reactions.js`

```sql
CREATE TABLE IF NOT EXISTS message_reactions (
  reaction_id  TEXT    PRIMARY KEY,
  msg_id       TEXT    NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
  channel_id   TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  emoji        TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  UNIQUE (msg_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions (msg_id);
CREATE INDEX IF NOT EXISTS idx_reactions_channel ON message_reactions (channel_id);
```

`ON DELETE CASCADE` so reactions are cleaned up if a message is ever deleted.

---

## Reaction shape in WS/HTTP payloads

Messages carry an aggregated `reactions` array:

```js
// Per-message reaction summary
reactions: [
  { emoji: '👍', count: 3, reacted: true },   // reacted: true if requesting user has reacted
  { emoji: '🔥', count: 2, reacted: false },
]
```

This is computed server-side by joining/aggregating `message_reactions` and checking whether
`user_id = requestingUserId`. The client never needs to diff — it just replaces the bar on
every `reaction.event`.

---

## WS Protocol

| Type | Direction | Body |
|---|---|---|
| `reaction.add`    | client → server | `{ msg_id, channel_id, emoji }` |
| `reaction.remove` | client → server | `{ msg_id, channel_id, emoji }` |
| `reaction.event`  | server → all channel members | `{ msg_id, channel_id, emoji, user_id, action: 'add'\|'remove', reactions: [{emoji, count, reacted}] }` |

`reaction.event` includes the full updated `reactions` summary for that message so every subscriber
can simply replace their local reaction bar without maintaining their own diff logic.

Bots use `reaction.add` / `reaction.remove` the same as human users.

---

## Layers

### 1. Core — `src/core/reactions.js`

```js
const MAX_EMOJI_BYTES = 16   // guard against absurdly long strings

export function validateEmoji(emoji) {
  if (typeof emoji !== 'string') throw new ServiceError('BAD_REQUEST', 'emoji must be a string')
  if (!emoji || [...emoji].length > 4) throw new ServiceError('BAD_REQUEST', 'Invalid emoji')
}
```

Using `[...emoji].length` counts Unicode code points (handles multi-codepoint emoji like 👨‍👩‍👧).

### 2. Adapter — `src/adapters/SqliteReactionRepository.js`

```js
// Returns void. UNIQUE constraint is the idempotency guard.
upsertReaction({ reactionId, msgId, channelId, userId, emoji, ts })

// Returns void. No-op if the row doesn't exist.
removeReaction({ msgId, userId, emoji })

// Returns Map<msgId, [{emoji, count, reacted}]>
// requestingUserId used to compute the `reacted` flag.
listReactionsForMsgs({ msgIds, requestingUserId })
```

`listReactionsForMsgs` runs one query:
```sql
SELECT msg_id, emoji, COUNT(*) AS count,
       MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted
FROM message_reactions
WHERE msg_id IN (?, ?, …)
GROUP BY msg_id, emoji
ORDER BY MIN(ts) ASC
```

### 3. InMemoryReactionRepository — `src/adapters/InMemoryReactionRepository.js`

Test double matching the same interface.

### 4. Service — `src/services/ReactionService.js`

```js
addReaction({ msgId, channelId, userId, emoji }) {
  validateEmoji(emoji)
  if (!this.channelService.isMember(channelId, userId))
    throw new ServiceError('FORBIDDEN', 'Not a member')
  const reactionId = newId('rx')
  const ts = this.nowFn()
  this.reactionRepo.upsertReaction({ reactionId, msgId, channelId, userId, emoji, ts })
  return this.#summaryFor(msgId, userId)
}

removeReaction({ msgId, channelId, userId, emoji }) {
  validateEmoji(emoji)
  if (!this.channelService.isMember(channelId, userId))
    throw new ServiceError('FORBIDDEN', 'Not a member')
  this.reactionRepo.removeReaction({ msgId, userId, emoji })
  return this.#summaryFor(msgId, userId)
}

// Enriches a messages array with reactions — called by MessageService after list queries.
enrichWithReactions({ messages, requestingUserId }) {
  if (messages.length === 0) return messages
  const map = this.reactionRepo.listReactionsForMsgs({
    msgIds: messages.map(m => m.msg_id),
    requestingUserId,
  })
  return messages.map(m => ({ ...m, reactions: map.get(m.msg_id) ?? [] }))
}

#summaryFor(msgId, requestingUserId) {
  const map = this.reactionRepo.listReactionsForMsgs({
    msgIds: [msgId], requestingUserId,
  })
  return map.get(msgId) ?? []
}
```

`MessageService` gets a `reactionService` dependency and calls `enrichWithReactions` at the end of
`listLatestMessages`, `listMessagesBefore`, and `listMessages`.

### 5. WS Handlers — `src/ws/handlers/reactionHandlers.js`

```js
export function handleReactionAdd(ws, msg, ctx) {
  const { reactionService, sendWs, publishChannel } = ctx
  const { msg_id, channel_id, emoji } = msg.body ?? {}
  const reactions = reactionService.addReaction({
    msgId: msg_id, channelId: channel_id, userId: ws.data.userId, emoji,
  })
  const event = { t: 'reaction.event', ok: true, body: {
    msg_id, channel_id, emoji, user_id: ws.data.userId, action: 'add', reactions,
  }}
  publishChannel(channel_id, event)
}
```

`handleReactionRemove` is symmetric with `action: 'remove'`.

Wire both into `ChatServer.js` `#route()`.

### 6. HTTP + SSR seed — `pages/channels/[channelId].js`

After calling `messageService.listLatestMessages(...)`, enrich with reactions:

```js
const { messages: seedMessages } = messageService.listLatestMessages(...)
const enriched = reactionService.enrichWithReactions({
  messages: seedMessages,
  requestingUserId: user.user_id,
})
```

Pass `enriched` instead of `seedMessages` into the template.

Each seed message gets `reactions_json` (serialised for the template) alongside `attachments_json`.

### 7. Template — `pages/channels/[channelId].phtml`

Add a `.reaction-bar` inside each seed `<article>`:

```html
<article class="message" data-seq="{{seq}}" data-msg-id="{{msg_id}}"
         data-attachments="{{attachments_json}}"
         data-reactions="{{reactions_json}}">
  <span class="message-handle" data-user-id="{{user_id}}">{{user_display_name}}</span>
  <time class="message-time" datetime="{{ts}}">{{ts_fmt}}</time>
  <p class="message-text">{{text}}</p>
  <div class="reaction-bar"></div>
</article>
```

The `.reaction-bar` is populated by `hydrateSeedMessages` in `call.js`.

### 8. Client — `pages/public/client/islands/call.js`

#### 8a. Reaction bar rendering

```js
function renderReactionBar(article, reactions, msgId) {
  const bar = article.querySelector('.reaction-bar')
  if (!bar) return
  bar.innerHTML = reactions.map(r => `
    <button class="reaction-pill${r.reacted ? ' reacted' : ''}"
            data-emoji="${escHtml(r.emoji)}" data-msg-id="${escHtml(msgId)}"
            type="button" title="${r.count} reaction${r.count !== 1 ? 's' : ''}">
      ${r.emoji} <span class="reaction-count">${r.count}</span>
    </button>`).join('') +
    `<button class="reaction-add" data-msg-id="${escHtml(msgId)}" type="button"
             title="Add reaction" aria-label="Add reaction">+</button>`
}
```

Delegated click on `.reaction-pill` → toggle (add if not reacted, remove if reacted).
Delegated click on `.reaction-add` → open emoji picker anchored to the button.

#### 8b. Hydration

`hydrateSeedMessages` reads `article.dataset.reactions`, parses JSON, calls `renderReactionBar`.

`appendMessage` calls `renderReactionBar` with the `reactions` array from the WS event body.

#### 8c. `reaction.event` handler

```js
ws.on('reaction.event', ({ msg_id, reactions }) => {
  const article = messages.querySelector(`[data-msg-id="${msg_id}"]`)
  if (article) renderReactionBar(article, reactions, msg_id)
})
```

#### 8d. Context menu (desktop)

Right-click on an `article.message` → create/show a `.msg-context-menu` div positioned near
`e.clientX / e.clientY`. Menu items: `React` (opens picker), `Reply (future)`, `Edit (future)`.

Close on click-outside or Escape.

#### 8e. Bottom sheet (mobile)

Long-press detection: `pointerdown` → start 500ms timer → on timeout show sheet.
Cancel on `pointermove` (> 8px delta) or `pointerup` before timeout.

Sheet: fixed `.action-sheet` panel that `transform: translateY(0)` in from the bottom.
Contains the emoji picker + future action rows.

#### 8f. Emoji picker component

Built from `emoji-data.js`. A `.emoji-picker` div containing:
- Search `<input>` — filters all emoji by name substring match
- Category tab bar (one button per category)
- Emoji grid — `<button>` per emoji, click dispatches a custom `emoji:pick` event with `detail.emoji`

The picker is a singleton created once and moved in the DOM as needed (appended to the context
menu or to the bottom sheet). It always emits `emoji:pick` — the caller decides what to do.

Recent emoji is tracked in `localStorage` under `devchitchat_recent_emoji` (max 24, FIFO).

---

## CSS — `pages/public/themes/base.css`

New rules needed:

```
.reaction-bar            — flex-wrap row, gap 4px, margin-top 4px
.reaction-pill           — pill button: border, rounded, small font, padding 2px 7px
.reaction-pill.reacted   — highlighted border + background using accent color
.reaction-count          — font-size: 12px
.reaction-add            — same size as pill, dashed border, muted color

.msg-context-menu        — absolute, bg-sidebar, border, shadow, z-index 300, rounded
.msg-context-menu-item   — full-width button, hover accent bg, 32px height

.action-sheet            — fixed bottom-0, full width, bg-sidebar, border-top, rounded top corners
                           transform translateY(100%) by default; .open → translateY(0)
                           transition 220ms ease-out
.action-sheet-header     — drag handle (40px wide bar, centered, margin auto)
.action-sheet-body       — padding 16px

.emoji-picker            — max-width 320px, bg-sidebar, border, shadow, rounded
.emoji-picker-search     — full width input, margin-bottom 8px
.emoji-picker-tabs       — flex row of icon buttons, border-bottom
.emoji-picker-grid       — CSS grid, 8 columns, button per emoji (32px × 32px)
.emoji-picker-grid button — font-size 22px, no border, bg-none, cursor pointer, hover bg-accent-tint
```

---

## Implementation Order

1. **Migration** — `009-message-reactions.js` (schema + indexes)
2. **Core** — `src/core/reactions.js` (`validateEmoji`)
3. **Adapter** — `SqliteReactionRepository`, `InMemoryReactionRepository`
4. **Service** — `ReactionService` + wire into `MessageService.enrichWithReactions`
5. **Tests** — `ReactionService` tests using `InMemoryReactionRepository`
6. **WS handlers** — `reactionHandlers.js`, wire into `ChatServer.js` + `src/context.js`
7. **HTTP** — enrich seed messages in `[channelId].js`
8. **Template** — add `data-reactions`, `.reaction-bar` to seed message articles
9. **Emoji data** — `pages/public/client/emoji-data.js`
10. **Client** — reaction bar rendering, `reaction.event` handler, context menu, bottom sheet,
    emoji picker component, `hydrateSeedMessages` update, `appendMessage` update
11. **CSS** — all new rules

---

## Key files

| File | Role |
|---|---|
| `scripts/migrate/009-message-reactions.js` | Schema |
| `src/core/reactions.js` | `validateEmoji` |
| `src/adapters/SqliteReactionRepository.js` | SQL adapter |
| `src/adapters/InMemoryReactionRepository.js` | Test double |
| `src/services/ReactionService.js` | Business logic |
| `src/services/MessageService.js` | Call `enrichWithReactions` |
| `src/ws/handlers/reactionHandlers.js` | WS handlers |
| `src/ws/ChatServer.js` | Wire handlers + service |
| `src/context.js` | Wire repo + service |
| `pages/channels/[channelId].js` | Enrich SSR seed |
| `pages/channels/[channelId].phtml` | `data-reactions`, `.reaction-bar` |
| `pages/public/client/emoji-data.js` | Static emoji dataset (new) |
| `pages/public/client/islands/call.js` | All client-side reaction logic |
| `pages/public/themes/base.css` | Styles |

---

## Decisions

1. **Reaction cap:** max 20 distinct emoji per message. `ReactionService.addReaction` throws
   `ServiceError('BAD_REQUEST', 'Reaction limit reached')` if the message already has 20 distinct
   emoji and this emoji is not already one of them.

2. **Desktop trigger:** right-click only. No click+delay alternative until there is user demand.

3. **Message deletion cascades** — `ON DELETE CASCADE` handles reactions when a message is hard-
   deleted. But the system doesn't currently support message deletion. When it's added, reactions
   come along for free.

4. **Emoji picker width on desktop** — viewport-aware clamping: after positioning the picker,
   clamp `left` so `left + pickerWidth <= window.innerWidth - 8`.

5. **WS message enrichment scope** — `listMessages` (afterSeq catch-up) also calls
   `enrichWithReactions`, same as the latest and before-seq paths.
