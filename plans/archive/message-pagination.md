# Message Pagination + Date Separators

**Goal:** Limit messages rendered on initial load to the most recent N (50), allow scrolling up to load older batches, and visually separate messages from different days with a date separator label.

---

## Problem Statement

1. **No upper bound**: `listMessages({ afterSeq: 0, limit: 50 })` uses `seq > 0 ORDER BY seq ASC LIMIT 50` — it returns the *first* 50 messages ever posted, not the *last* 50. In a busy channel the user sees ancient history, not recent conversation.
2. **No scroll-back**: There is no UI mechanism to load older messages.
3. **No date separators**: Messages from different days are indistinguishable in the feed.

---

## Design Decisions

- **Page size:** 50 messages per batch (keeps parity with the current limit, easy to tune).
- **Load direction:** Load older messages upward. The sentinel `<div>` sits at the top of the message list; when it scrolls into view, fetch the next older batch.
- **Scroll preservation:** Before prepending, record `scrollHeight`; after prepend, adjust `scrollTop` by the delta so the user's viewport doesn't jump.
- **Date separators:** Inserted between adjacent messages whose calendar dates differ (UTC). Also inserted before the first message of each batch.
- **`seedHasMore`:** If the channel has more messages older than the seeded batch, the HTTP handler sets `data-seed-has-more="true"` so the client shows the sentinel from page load.

---

## Files to Change

| File | Change |
|---|---|
| `src/adapters/SqliteMessageRepository.js` | Add `listLatestMessages`, `listMessagesBefore` |
| `src/services/MessageService.js` | Fix initial load to call `listLatestMessages`; add `listMessagesBefore` |
| `src/ws/ChatServer.js` | Extend `#handleMsgList` for `before_seq` pagination direction |
| `pages/channels/[channelId].js` | Use `listLatestMessages` for SSR; expose `seedFirstSeq`, `seedHasMore` |
| `pages/channels/[channelId].phtml` | Add `data-seed-first-seq`, `data-seed-has-more`; add `#load-more-sentinel` |
| `pages/public/client/islands/call.js` | IntersectionObserver, `prependMessages`, date separators, nav state reset |
| `pages/public/themes/base.css` | `.load-more-sentinel`, `.date-separator` styles |

---

## Step-by-Step Implementation

### 1. `SqliteMessageRepository` — two new query methods

```js
/**
 * Returns the most recent `limit` messages in a channel, in ascending seq order.
 * e.g. "last 50 messages" for SSR seed.
 */
listLatestMessages({ channelId, limit }) {
  const rows = this.db.prepare(
    `SELECT m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name, m.ts, m.text, m.attachments_json
     FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
     WHERE m.channel_id = ?
     ORDER BY m.seq DESC LIMIT ?`
  ).all(channelId, limit)
  // Reverse so caller gets chronological order (oldest first)
  return rows.reverse().map(r => ({
    ...r,
    attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
    attachments_json: undefined,
  }))
}

/**
 * Returns `limit` messages with seq < beforeSeq, in ascending seq order.
 * Used for "load more" scroll-up pagination.
 */
listMessagesBefore({ channelId, beforeSeq, limit }) {
  const rows = this.db.prepare(
    `SELECT m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name, m.ts, m.text, m.attachments_json
     FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
     WHERE m.channel_id = ? AND m.seq < ?
     ORDER BY m.seq DESC LIMIT ?`
  ).all(channelId, beforeSeq, limit)
  return rows.reverse().map(r => ({
    ...r,
    attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
    attachments_json: undefined,
  }))
}
```

> **Index:** Add a composite index `CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq)` in `src/db/initDb.js` (or a new migration) so both DESC and ASC seeks are fast.

---

### 2. `MessageService` — new methods, fix initial load

```js
/** Returns the most recent N messages (for SSR seed). */
listLatestMessages({ channelId, userId, limit = 50 }) {
  if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')
  const rows = this.messageRepo.listLatestMessages({ channelId, limit })
  return { messages: rows }
}

/** Returns messages older than beforeSeq (for scroll-up pagination). */
listMessagesBefore({ channelId, userId, beforeSeq, limit = 50 }) {
  if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')
  const rows = this.messageRepo.listMessagesBefore({ channelId, beforeSeq, limit })
  const hasMore = rows.length === limit  // heuristic: if we got a full page, there may be more
  return { messages: rows, has_more: hasMore }
}
```

Keep `listMessages` (afterSeq-based) for the WS `msg.list` catch-up path — clients still need to fetch messages that arrived since their last known seq.

---

### 3. `ChatServer.js` — extend `#handleMsgList`

Current `#handleMsgList` only supports `after_seq`. Extend it to support `before_seq` for scroll-up pagination:

```js
async #handleMsgList(ws, msg) {
  const { channel_id, after_seq, before_seq } = msg.body ?? {}
  // ...auth checks...
  if (before_seq != null) {
    // Scroll-up: load older batch
    const result = this.messageService.listMessagesBefore({
      channelId: channel_id,
      userId: ws.data.userId,
      beforeSeq: before_seq,
      limit: 50,
    })
    return this.#sendWs(ws, { t: 'msg.list_result', reply_to: msg.id, body: { ...result, channel_id, direction: 'before' } })
  }
  // Existing after_seq path (catch-up)
  const result = this.messageService.listMessages({ channelId: channel_id, userId: ws.data.userId, afterSeq: after_seq ?? 0 })
  this.#sendWs(ws, { t: 'msg.list_result', reply_to: msg.id, body: { ...result, channel_id, direction: 'after' } })
}
```

---

### 4. `pages/channels/[channelId].js` — fix SSR seed + expose metadata

```js
// Replace the current listMessages call:
const { messages: seedMessages } = messageService.listLatestMessages({
  channelId,
  userId: user.user_id,
  limit: 50,
})

// Determine whether there are older messages (for the sentinel)
const seedFirstSeq = seedMessages.length ? seedMessages[0].seq : 0
const channelMinSeq = /* cheapest way: check if seedFirstSeq > 1 */ seedFirstSeq > 1
const seedHasMore   = channelMinSeq

// Return:
return {
  // ...existing fields...
  seedFirstSeq,
  seedHasMore,
  seedSeq: seedMessages.length ? seedMessages[seedMessages.length - 1].seq : 0,
  seedMessages: seedMessages.map(m => ({ ... })),
}
```

> For `seedHasMore`, the simplest check is `seedFirstSeq > 1` (if the oldest loaded message isn't seq=1 there must be older ones). Alternatively add a `countMessagesBefore({ channelId, beforeSeq })` repo method, but that's a second query — the `seq > 1` heuristic is sufficient.

---

### 5. `pages/channels/[channelId].phtml` — template changes

Add data attributes to the chat-panel section and a sentinel element inside the messages div:

```html
<section class="chat-panel" island="/client/islands/call.js"
  data-id="{{channel.channel_id}}"
  ...existing attrs...
  data-seed-seq="{{seedSeq}}"
  data-seed-first-seq="{{seedFirstSeq}}"
  data-seed-has-more="{{seedHasMore}}"
>
```

Inside `<div class="messages" id="messages" ...>`, before the `{{#each seedMessages}}` block:

```html
<div class="load-more-sentinel" id="load-more-sentinel" aria-hidden="true" hidden></div>
```

---

### 6. `pages/public/client/islands/call.js` — client changes

#### 6a. Read new data attributes on mount

```js
const seedFirstSeq = parseInt(root.dataset.seedFirstSeq ?? '0', 10)
const seedHasMore  = root.dataset.seedHasMore === 'true'
let   oldestSeq    = seedFirstSeq   // tracks the oldest seq we've loaded
let   loadingMore  = false          // prevents double-firing
```

#### 6b. Show sentinel if there are older messages

```js
const sentinelEl = document.getElementById('load-more-sentinel')

function showSentinel() { if (sentinelEl) sentinelEl.hidden = false }
function hideSentinel() { if (sentinelEl) sentinelEl.hidden = true  }

if (seedHasMore) showSentinel()
```

#### 6c. IntersectionObserver on the sentinel

```js
const loadMoreObserver = new IntersectionObserver(entries => {
  if (entries[0].isIntersecting && !loadingMore && oldestSeq > 1) {
    loadingMore = true
    ws.send({ t: 'msg.list', body: { channel_id: channelId, before_seq: oldestSeq } })
  }
}, { root: messagesEl, threshold: 0.1 })

if (sentinelEl) loadMoreObserver.observe(sentinelEl)
```

#### 6d. Handle `msg.list_result` with `direction: 'before'`

Extend the existing `msg.list_result` handler:

```js
ws.on('msg.list_result', ({ messages, has_more, direction }) => {
  if (direction === 'before') {
    if (messages.length === 0) {
      hideSentinel()
      loadMoreObserver.unobserve(sentinelEl)
      loadingMore = false
      return
    }
    prependMessages(messages)
    if (messages[0].seq < oldestSeq) oldestSeq = messages[0].seq
    if (!has_more || oldestSeq <= 1) {
      hideSentinel()
      loadMoreObserver.unobserve(sentinelEl)
    }
    loadingMore = false
    return
  }
  // Existing after_seq catch-up path
  for (const m of messages) appendMessage(m)
  if (messages.length) afterSeq = messages[messages.length - 1].seq
})
```

#### 6e. `prependMessages` — scroll-preserving prepend

```js
function prependMessages(messages) {
  const prevHeight = messagesEl.scrollHeight
  const fragment   = document.createDocumentFragment()
  let   prevDate   = null

  // Determine the date of the current oldest message in the DOM (for separator logic)
  const firstExisting = messagesEl.querySelector('article.message')
  if (firstExisting) {
    const ts = parseInt(firstExisting.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
    if (ts) prevDate = utcDateKey(ts)
  }

  for (const m of messages) {
    const dateKey = utcDateKey(m.ts)
    if (prevDate && dateKey !== prevDate) {
      fragment.appendChild(makeDateSeparator(prevDate))
    }
    fragment.appendChild(makeMessageEl(m))
    prevDate = dateKey
  }

  // If the oldest prepended message is on a different day from what was the first DOM message
  // insert a separator between the batch and the existing messages
  if (firstExisting && prevDate) {
    const existingDateKey = utcDateKey(
      parseInt(firstExisting.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
    )
    if (existingDateKey && prevDate !== existingDateKey) {
      messagesEl.insertBefore(makeDateSeparator(existingDateKey), firstExisting)
    }
  }

  // Insert after the sentinel
  sentinelEl
    ? sentinelEl.after(fragment)
    : messagesEl.prepend(fragment)

  // Restore scroll position
  messagesEl.scrollTop += messagesEl.scrollHeight - prevHeight
}
```

#### 6f. Date separator helpers

```js
function utcDateKey(tsMs) {
  const d = new Date(tsMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function formatDateLabel(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d))
  const today = new Date()
  const todayKey = utcDateKey(today.getTime())
  const yestKey  = utcDateKey(today.getTime() - 86_400_000)
  if (dateKey === todayKey) return 'Today'
  if (dateKey === yestKey)  return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

function makeDateSeparator(dateKey) {
  const el = document.createElement('div')
  el.className = 'date-separator'
  el.setAttribute('data-date', dateKey)
  el.innerHTML = `<span class="date-separator-label">${formatDateLabel(dateKey)}</span>`
  return el
}
```

#### 6g. Inject date separators in `appendMessage`

```js
function appendMessage(m) {
  // Date separator before this message?
  const dateKey = utcDateKey(m.ts)
  const lastMsg = messagesEl.querySelector('article.message:last-of-type')
  if (lastMsg) {
    const lastTs = parseInt(lastMsg.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
    if (lastTs && utcDateKey(lastTs) !== dateKey) {
      messagesEl.appendChild(makeDateSeparator(dateKey))
    }
  }
  // ... existing append logic ...
}
```

#### 6h. Inject date separators in `hydrateSeedMessages`

After hydrating the static HTML messages, walk the DOM and insert separators between groups:

```js
function hydrateSeedMessages() {
  const articles = Array.from(messagesEl.querySelectorAll('article.message'))
  let prevDateKey = null
  for (const article of articles) {
    const ts = parseInt(article.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
    if (!ts) continue
    const dateKey = utcDateKey(ts)
    // Highlight mentions
    const textEl = article.querySelector('.message-text')
    if (textEl?.textContent) textEl.innerHTML = renderText(textEl.textContent)
    // Date separator
    if (prevDateKey && dateKey !== prevDateKey) {
      article.before(makeDateSeparator(dateKey))
    }
    prevDateKey = dateKey
  }
}
```

#### 6i. Reset on SPA navigation

In the `chatpanel:navigated` handler, reset pagination state for the new channel:

```js
document.addEventListener('chatpanel:navigated', e => {
  const { seedFirstSeq: newFirstSeq, seedHasMore: newHasMore } = e.detail ?? {}
  oldestSeq   = newFirstSeq ?? 0
  loadingMore = false
  if (sentinelEl) {
    sentinelEl.hidden = !newHasMore
    if (newHasMore) loadMoreObserver.observe(sentinelEl)
    else            loadMoreObserver.unobserve(sentinelEl)
  }
  // ... existing navigation handling ...
})
```

> The router (`router.js`) must forward `seedFirstSeq` and `seedHasMore` in the `chatpanel:navigated` event detail so the island can pick them up.

---

### 7. `pages/public/client/router.js` — forward new data attributes

In the section where `chatpanel:navigated` is dispatched, read the new attributes from the fetched panel:

```js
document.dispatchEvent(new CustomEvent('chatpanel:navigated', {
  detail: {
    channelId:     newPanel.dataset.id,
    channelName:   newPanel.dataset.name,
    channelTopic:  newPanel.dataset.topic,
    channelKind:   newPanel.dataset.kind,
    seedSeq:       parseInt(newPanel.dataset.seedSeq ?? '0', 10),
    seedFirstSeq:  parseInt(newPanel.dataset.seedFirstSeq ?? '0', 10),
    seedHasMore:   newPanel.dataset.seedHasMore === 'true',
  }
}))
```

---

### 8. CSS — `pages/public/themes/base.css`

```css
/* Load-more sentinel — invisible trigger at the top of the message list */
.load-more-sentinel {
  height: 1px;
  margin: 0;
  padding: 0;
}

/* Date separator */
.date-separator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.date-separator::before,
.date-separator::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}
.date-separator-label {
  white-space: nowrap;
  padding: 0 6px;
  font-weight: 500;
}
```

---

## Migration (optional index)

If `messages` doesn't already have a composite index on `(channel_id, seq)`:

```js
// scripts/migrate/NNN-messages-channel-seq-index.js
export function run(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq)`)
}
```

Check `scripts/migrate/` for the next available number before creating.

---

## Implementation Order

Follow the inside-out rule:

1. Adapter: `listLatestMessages`, `listMessagesBefore`
2. Service: `listLatestMessages`, `listMessagesBefore`
3. Transport (WS): extend `#handleMsgList` for `before_seq`
4. Transport (HTTP): fix SSR seed in `[channelId].js`, expose `seedFirstSeq`/`seedHasMore`
5. Template: data attributes + sentinel element
6. Router: forward new detail fields in `chatpanel:navigated`
7. Client island: sentinel observer, `prependMessages`, date separators
8. CSS: sentinel + separator styles
9. Migration: add index if missing

Write a failing test for `listLatestMessages` and `listMessagesBefore` before implementing step 1.
