# Edit Messages

**Goal:** Allow the author of a message to edit its text inline. The edit is broadcast in
real-time to all channel members. An `(edited)` label appears next to the timestamp. Search
stays in sync. No edit history is kept.

---

## UX

### Triggering an edit

**Desktop:** right-click a message → context menu (already planned in `message-reactions.md`)
→ click `Edit`. This replaces the "Edit (future)" stub in the context menu.

**Mobile:** long-press a message → bottom sheet (already planned in `message-reactions.md`)
→ tap `Edit`. This replaces the "Edit (future)" stub in the action sheet.

Only the author's own messages show the Edit option. The client checks
`msg.user_id === currentUserId` before rendering the item.

### Inline edit

Clicking Edit replaces the `<p class="message-text">` with a `<textarea>` pre-filled with the
raw message text (not rendered HTML — the raw `text` value stored in `data-raw-text`). A small
toolbar appears below:

```
[Save]  [Cancel]  (or press Enter to save, Escape to cancel)
```

- `Shift+Enter` inserts a newline (same as the composer)
- Saving with identical text cancels silently (no WS round-trip)
- Empty text is rejected (same rule as send — you cannot edit to blank)

On save, the textarea is replaced with the updated rendered text and the `(edited)` label
appears. On cancel, the original text is restored with no network call.

### Edited indicator

```
<time class="message-time" …>10:42 am <span class="message-edited">(edited)</span></time>
```

Small, muted — same style as `.message-time`.

---

## Data Model

### Migration `010-edit-messages.js`

```js
export function run(db) {
  db.exec(`ALTER TABLE messages ADD COLUMN edited_at INTEGER`)
}
```

`edited_at` is `NULL` for unedited messages, a Unix millisecond timestamp otherwise.
No `edit_count` — not needed for the current scope.

---

## WS Protocol

| Type | Direction | Body |
|---|---|---|
| `msg.edit`    | client → server | `{ msg_id, channel_id, text }` |
| `msg.edited`  | server → all channel members | `{ msg_id, channel_id, text, edited_at, rendered_text }` |

`rendered_text` is the server-rendered markdown HTML so the client does not need to run a
markdown renderer itself (consistent with how seed messages are rendered server-side).

---

## Layers

### 1. Core — `src/core/messages.js` (new file or extend existing)

```js
export function validateEditPermission(requestingUserId, authorUserId) {
  if (requestingUserId !== authorUserId)
    throw new ServiceError('FORBIDDEN', 'Only the author can edit this message')
}

export function validateEditText(text) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) throw new ServiceError('BAD_REQUEST', 'Message text cannot be empty')
  return trimmed
}

export function isEditableMessage(deletedAt) {
  if (deletedAt != null) throw new ServiceError('BAD_REQUEST', 'Cannot edit a deleted message')
}
```

### 2. Repository — `SqliteMessageRepository`

New method:

```js
updateMessage({ msgId, text, editedAt }) {
  this.db.prepare(
    `UPDATE messages SET text = ?, edited_at = ? WHERE msg_id = ?`
  ).run(text, editedAt, msgId)
}

// Extend getById (add if not present):
getById(msgId) {
  return this.db.prepare(
    `SELECT msg_id, channel_id, user_id, text, deleted_at FROM messages WHERE msg_id = ?`
  ).get(msgId)
}
```

### 3. Repository — `InMemoryMessageRepository`

Same interface as above for tests:

```js
updateMessage({ msgId, text, editedAt }) {
  const msg = this.messages.find(m => m.msg_id === msgId)
  if (msg) { msg.text = text; msg.edited_at = editedAt }
}

getById(msgId) {
  return this.messages.find(m => m.msg_id === msgId) ?? null
}
```

### 4. Service — `MessageService`

New method:

```js
editMessage({ msgId, channelId, userId, newText }) {
  const msg = this.messageRepo.getById(msgId)
  if (!msg) throw new ServiceError('NOT_FOUND', 'Message not found')
  if (msg.channel_id !== channelId)
    throw new ServiceError('BAD_REQUEST', 'Message does not belong to this channel')

  isEditableMessage(msg.deleted_at)
  validateEditPermission(userId, msg.user_id)
  const trimmed = validateEditText(newText)

  const editedAt = this.nowFn()
  this.messageRepo.updateMessage({ msgId, text: trimmed, editedAt })

  // Keep search in sync
  this.searchService.indexMessage({
    msg_id: msgId,
    channel_id: channelId,
    seq: msg.seq,       // seq is immutable; getById should return it
    user_id: msg.user_id,
    ts: msg.ts,
    text: trimmed,
  })

  const renderedText = this.renderMarkdown(trimmed)   // injected dependency (same fn used in HTTP layer)
  return { msgId, channelId, text: trimmed, editedAt, renderedText }
}
```

`renderMarkdown` is passed in as a constructor dependency so the service stays free of HTTP
concerns. It is the same function already used in `pages/channels/[channelId].js`.

### 5. WS Handler — `src/ws/handlers/messageHandlers.js`

Add alongside `handleMsgSend`:

```js
export function handleMsgEdit(ws, msg, ctx) {
  const { messageService, publishChannel } = ctx
  const { msg_id, channel_id, text } = msg.body ?? {}
  const result = messageService.editMessage({
    msgId: msg_id,
    channelId: channel_id,
    userId: ws.data.userId,
    newText: text,
  })
  publishChannel(channel_id, {
    t: 'msg.edited',
    ok: true,
    body: {
      msg_id: result.msgId,
      channel_id: result.channelId,
      text: result.text,
      edited_at: result.editedAt,
      rendered_text: result.renderedText,
    },
  })
}
```

Wire into `ChatServer.js` `#route()`: `case 'msg.edit': handleMsgEdit(ws, msg, ctx); break`

### 6. Context — `src/context.js`

Pass `renderMarkdown` into `MessageService` constructor when wiring production context.

### 7. SSR seed — `pages/channels/[channelId].js` + `.phtml`

Seed messages need to carry the raw text and `edited_at` so the client can:
- Pre-fill the edit textarea with raw text (not rendered HTML)
- Show the `(edited)` label on load

**Template additions to each seed `<article>`:**

```html
<article class="message" data-seq="{{seq}}" data-msg-id="{{msg_id}}"
         data-user-id="{{user_id}}"
         data-raw-text="{{raw_text_escaped}}"
         data-edited-at="{{edited_at|empty_string_if_null}}">
  …
  <time class="message-time" datetime="{{ts}}">
    {{ts_fmt}}
    {{#if edited_at}}<span class="message-edited">(edited)</span>{{/if}}
  </time>
  …
</article>
```

Add `data-user-id` to the `article` (currently it is only on `.message-handle`). This lets
the client permission-check without querying a child element.

### 8. Client — `pages/public/client/islands/call.js`

#### 8a. `makeMessageEl` update (`shared/messages.js`)

Add `data-user-id`, `data-raw-text`, and `data-edited-at` to the article element:

```js
article.dataset.userId = msg.user_id
article.dataset.rawText = msg.text          // raw, not rendered
article.dataset.editedAt = msg.edited_at ?? ''
```

Conditionally append the `(edited)` span if `msg.edited_at`:

```js
if (msg.edited_at) {
  const edited = document.createElement('span')
  edited.className = 'message-edited'
  edited.textContent = '(edited)'
  timeEl.appendChild(edited)
}
```

#### 8b. Context menu / bottom sheet wiring

In the context menu build logic (desktop right-click, already added for reactions):

```js
if (article.dataset.userId === currentUserId) {
  addMenuItem('Edit', () => startInlineEdit(article))
}
```

Same check in the bottom sheet (mobile long-press).

#### 8c. `startInlineEdit(article)`

```js
function startInlineEdit(article) {
  const textEl = article.querySelector('.message-text')
  const rawText = article.dataset.rawText
  const original = textEl.innerHTML

  const textarea = document.createElement('textarea')
  textarea.className = 'message-edit-input'
  textarea.value = rawText
  textEl.replaceWith(textarea)
  textarea.focus()
  textarea.setSelectionRange(rawText.length, rawText.length)

  const toolbar = document.createElement('div')
  toolbar.className = 'message-edit-toolbar'
  toolbar.innerHTML = `<button class="btn-save">Save</button><button class="btn-cancel">Cancel</button>`
  textarea.after(toolbar)

  function cancel() {
    textarea.replaceWith(textEl)      // restore original element
    toolbar.remove()
  }

  function save() {
    const newText = textarea.value.trim()
    if (!newText || newText === rawText) { cancel(); return }
    ws.send(JSON.stringify({
      v: 1, id: crypto.randomUUID(), ts: Date.now(),
      t: 'msg.edit',
      body: { msg_id: article.dataset.msgId, channel_id: currentChannelId, text: newText },
    }))
    cancel()   // optimistic: restore UI; msg.edited will update it
  }

  toolbar.querySelector('.btn-save').addEventListener('click', save)
  toolbar.querySelector('.btn-cancel').addEventListener('click', cancel)
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
    if (e.key === 'Escape') cancel()
  })
}
```

#### 8d. `msg.edited` handler

```js
case 'msg.edited': {
  const { msg_id, text, edited_at, rendered_text } = msg.body
  const article = messagesEl.querySelector(`[data-msg-id="${msg_id}"]`)
  if (!article) break
  const textEl = article.querySelector('.message-text')
  if (textEl) textEl.innerHTML = sanitize(rendered_text)   // same sanitize used for seeds
  article.dataset.rawText = text
  article.dataset.editedAt = edited_at
  // Add or update (edited) label
  const timeEl = article.querySelector('.message-time')
  let editedSpan = timeEl.querySelector('.message-edited')
  if (!editedSpan) {
    editedSpan = document.createElement('span')
    editedSpan.className = 'message-edited'
    editedSpan.textContent = '(edited)'
    timeEl.appendChild(editedSpan)
  }
  break
}
```

---

## CSS — `pages/public/themes/base.css`

```css
.message-edited {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 4px;
}

.message-edit-input {
  width: 100%;
  min-height: 60px;
  padding: 6px 8px;
  font: inherit;
  font-size: inherit;
  line-height: 1.5;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-input, var(--bg-sidebar));
  color: var(--text-primary);
  resize: vertical;
  box-sizing: border-box;
}

.message-edit-toolbar {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
```

The `[Save]` and `[Cancel]` buttons reuse existing `.btn` styles (check base.css for the
established button class pattern).

---

## Tests

All tests use `InMemoryMessageRepository` — no SQLite, no WS.

```js
// src/services/MessageService.edit.test.js

test('editMessage updates text and edited_at', () => { … })
test('editMessage throws FORBIDDEN when userId !== authorId', () => { … })
test('editMessage throws BAD_REQUEST when text is blank', () => { … })
test('editMessage throws BAD_REQUEST when message is deleted', () => { … })
test('editMessage throws NOT_FOUND when msgId does not exist', () => { … })
test('editMessage re-indexes text in search', () => { … })
```

---

## Implementation Order

1. **Migration** — `010-edit-messages.js` (`ALTER TABLE messages ADD COLUMN edited_at INTEGER`)
2. **Core** — `validateEditPermission`, `validateEditText`, `isEditableMessage` in `src/core/`
3. **Adapter** — `updateMessage` + `getById` on `SqliteMessageRepository` and `InMemoryMessageRepository`
4. **Tests** — write failing tests for `MessageService.editMessage`
5. **Service** — `editMessage` on `MessageService` (make tests pass)
6. **Context** — pass `renderMarkdown` into `MessageService` in `src/context.js`
7. **WS handler** — `handleMsgEdit` in `messageHandlers.js`, wire into `ChatServer.js`
8. **SSR** — add `data-user-id`, `data-raw-text`, `data-edited-at` to seed articles in template
9. **Client** — `makeMessageEl` update, `startInlineEdit`, `msg.edited` handler, context menu + bottom sheet wiring
10. **CSS** — `.message-edited`, `.message-edit-input`, `.message-edit-toolbar`

---

## Key Files

| File | Change |
|---|---|
| `scripts/migrate/010-edit-messages.js` | New — schema change |
| `src/core/messages.js` | New or extend — pure validation functions |
| `src/adapters/SqliteMessageRepository.js` | Add `updateMessage`, `getById` |
| `src/adapters/InMemoryMessageRepository.js` | Add `updateMessage`, `getById` |
| `src/services/MessageService.js` | Add `editMessage`; accept `renderMarkdown` dep |
| `src/context.js` | Pass `renderMarkdown` to `MessageService` |
| `src/ws/handlers/messageHandlers.js` | Add `handleMsgEdit` |
| `src/ws/ChatServer.js` | Wire `msg.edit` route |
| `pages/channels/[channelId].js` | Pass `edited_at` + raw text to template |
| `pages/channels/[channelId].phtml` | Add `data-*` attrs, `(edited)` span on seed messages |
| `pages/public/client/shared/messages.js` | Add `data-*` attrs + `(edited)` span in `makeMessageEl` |
| `pages/public/client/islands/call.js` | `startInlineEdit`, `msg.edited` handler, menu wiring |
| `pages/public/themes/base.css` | New styles |

---

## Decisions

1. **Author-only, no time window.** No admin override for now.
2. **No edit history.** `edited_at` is sufficient for the indicator; full history can be added
   later if users ask.
3. **Optimistic UI on save.** The textarea is dismissed immediately; the `msg.edited` broadcast
   updates the text. If the server rejects the edit (permission error, blank text), the client
   receives a WS error and can show a toast — the original text is not corrupted because the
   DOM was restored by `cancel()` before the save was sent.
   Wait — this is wrong. `cancel()` restores the original DOM before we know if the server
   accepted. The correct approach: on save, swap the textarea back to a `<p>` with the
   *new* text rendered client-side (no markdown, just escaped), then `msg.edited` replaces
   it with the server-rendered version. On WS error, re-render with `rawText` from `dataset`.
4. **`renderMarkdown` as a constructor dependency.** Keeps `MessageService` framework-free.
   The same function reference already used in the HTTP handler is passed in at wiring time
   in `context.js`.
5. **`data-user-id` on `<article>`.** Currently only on `.message-handle`. Adding it to the
   article makes permission checks O(1) without a child query. Both the reactions plan and
   this plan need it — add it once, use it for both.
