# Client Architecture

**Pattern:** Hub-and-spoke MVC (Cocoa-style)  
**Location:** `pages/public/client/`  
**No build step.** Plain ES modules loaded by the browser.

> **Design system:** Browse the living component gallery at `/design` in the running app.
> Principles are documented at `/design/principles`.
> Tokens at `/design/tokens`. Components at `/design/components`.

---

## The pattern in one sentence

`AppModel` is the single source of truth; Views subscribe to it via `EventTarget`; Controllers translate user gestures and WebSocket messages into model mutations.

```
WebSocket ──► WebSocketController ──► AppModel (EventTarget)
                                           │
User input ──► ChatController ─────────────┘
                                           │
               ┌───────────────────────────┼────────────────────────────┐
               ▼               ▼           ▼            ▼               ▼
        ChatHeaderView  MessageListView  ThreadPanelView  ComposerView  SidebarView
                                                                    CallView
```

---

## Rules — enforce these on every change

1. **Model has no DOM imports.** `AppModel` is a plain `EventTarget` subclass. Zero DOM.
2. **Views never call `ws.send()`.** They dispatch document `CustomEvent`s; `ChatController` or `CallView` sends to the server.
3. **Controllers never mutate the DOM.** They call model mutators; views react.
4. **Each view owns exactly one DOM subtree.** A view reaches only *downward* into its own container — never `closest()` upward to a parent or sideways to a sibling.
5. **No shared DOM ownership.** If two views need the same element, one of them is wrong. Extract a new view or use events to communicate.
6. **Event delegation over per-element listeners.** One `click` listener on the container covers all children, including dynamically added ones.
7. **All `localStorage` access goes through `getPref`/`setPref`** in `settings-sync.js`. No view or controller touches `localStorage` directly.

---

## File structure

```
pages/public/client/
├── app.js                        — bootstrap: instantiate model, controllers, views
├── router.js                     — SPA navigation; fetches new page, morphs .chat-panel,
│                                   dispatches chatpanel:navigated
├── settings-sync.js              — getPref / setPref (single localStorage owner)
├── resizable.js                  — attachResizeHandle (drag-to-resize panels)
├── swipe-nav.js                  — mobile swipe gesture
├── long-press.js                 — long-press detection helper
├── action-sheet.js               — mobile bottom sheet
├── modal.js                      — desktop modal dialog
│
├── model/
│   ├── AppModel.js               — all state + mutators + CustomEvent dispatch
│   └── events.js                 — event name constants (Ev.CHANNEL_SELECTED, etc.)
│
├── controllers/
│   ├── WebSocketController.js    — ws messages → model mutators
│   └── ChatController.js         — document CustomEvents from views → ws.send / model
│
├── views/
│   ├── ChatHeaderView.js         — <header class="chat-header">
│   │                               title, topic, Start Call button, mobile back button
│   ├── MessageListView.js        — #messages scroll container
│   │                               message list, hydration, pagination
│   ├── ThreadPanelView.js        — #thread-panel
│   │                               thread anchor, replies, reply composer
│   ├── ComposerView.js           — .composer
│   │                               textarea, attachments, mention picker, compose overlay
│   ├── SidebarView.js            — <aside class="sidebar">
│   │                               hubs, channels, DMs, presence, admin CRUD
│   └── CallView.js               — WebRTC (no DOM ownership of header elements)
│
├── views/shared/
│   ├── MessageInteractions.js    — delegated click handlers shared by message containers
│   ├── EmojiPickerSingleton.js   — floating emoji picker (singleton)
│   └── MentionPicker.js          — @mention autocomplete
│
└── shared/
    └── messages.js               — makeMessageEl, renderText, renderAttachment, escHtml
```

---

## AppModel — state and events

`AppModel` holds all application state and fires `CustomEvent`s when it changes.
Views add event listeners directly on the model instance.

### Event catalogue

| Constant | Event name | `detail` shape | Fired when |
|---|---|---|---|
| `HUBS_CHANGED` | `hubs-changed` | `{ hubs }` | Hub/channel list changes |
| `DMS_CHANGED` | `dms-changed` | `{ dms }` | DM list changes |
| `CHANNEL_SELECTED` | `channel-selected` | `{ channelId, prev, meta: { name, topic, kind } }` | Active channel changes |
| `MESSAGE_ADDED` | `message-added` | `{ channelId, message }` | New message arrives |
| `MESSAGE_UPDATED` | `message-updated` | `{ channelId, message }` | Message edited |
| `MESSAGE_DELETED` | `message-deleted` | `{ channelId, msgId }` | Message deleted |
| `REACTIONS_UPDATED` | `reactions-updated` | `{ msgId, channelId, reactions }` | Reactions changed |
| `MESSAGES_PREPENDED` | `messages-prepended` | `{ channelId, messages }` | Older messages loaded |
| `THREAD_OPENED` | `thread-opened` | `{ parentMsgId, parentMsg }` | Thread panel opens |
| `THREAD_CLOSED` | `thread-closed` | `{}` | Thread panel closes |
| `THREAD_REPLY_ADDED` | `thread-reply-added` | `{ parentMsgId, reply }` | New reply |
| `THREAD_REPLY_UPDATED` | `thread-reply-updated` | `{ parentMsgId, reply }` | Reply edited |
| `THREAD_REPLY_DELETED` | `thread-reply-deleted` | `{ parentMsgId, replyId }` | Reply deleted |
| `PRESENCE_UPDATED` | `presence-updated` | `{ userId, status }` | Presence changes |
| `MEMBERS_UPDATED` | `members-updated` | `{ channelId, members }` | Member list changes |
| `CALL_CHANGED` | `call-changed` | `{ call }` | Call state changes |
| `LOADING_MORE_CHANGED` | `loading-more-changed` | `{ loading }` | Pagination in flight |

---

## View-to-view events (document CustomEvents)

When views need to signal each other without going through the model — typically one-shot
UI triggers that don't represent persistent state — they use document `CustomEvent`s.

| Event name | Dispatched by | Handled by | Purpose |
|---|---|---|---|
| `call:start-requested` | `ChatHeaderView` | `CallView` | User clicked Start Call |
| `call:state-changed` | `CallView` | `ChatHeaderView` | Call entered/left — show/hide button |

**Rule:** use document events only for UI triggers with no persistent model state. If the
state needs to survive a component remount or affect multiple views simultaneously, put it
in `AppModel` instead.

---

## User-action events (view → ChatController)

Views dispatch these on `document`; `ChatController` listens and calls `ws.send()`.

```js
// In a view:
document.dispatchEvent(new CustomEvent('send-message', { detail: { channelId, text, ... } }))

// In ChatController:
document.addEventListener('send-message', e => {
  this.#ws.send({ t: 'msg.send', body: e.detail })
})
```

| Event name | Dispatched by | What it triggers |
|---|---|---|
| `send-message` | `ComposerView` | `msg.send` WS message |
| `react` | `MessageInteractions` | `reaction.add` / `reaction.remove` |
| `open-thread` | `MessageInteractions` | `model.openThread()` |
| `edit-message` | `MessageInteractions` | `msg.edit` WS message |
| `delete-message` | `MessageInteractions` | `msg.delete` WS message |
| `task-toggle` | `MessageInteractions` | `msg.edit` with updated checkbox text |

---

## Adding a new client feature — sequence

Always work inside-out. Never build UI against an API that doesn't exist yet.

```
1. WS protocol  → define the message types in the WS conventions (noun.verb)
2. Server       → service + handler + wire into ChatServer.js (see CLAUDE.md)
3. Model        → add state + mutator + event to AppModel if the feature has
                  persistent state; add event name constant to events.js
4. Controller   → WebSocketController maps the new WS event to the model mutator
                  ChatController maps the new user-action event to ws.send()
5. View         → subscribe to the new model event; render the updated DOM;
                  dispatch a user-action event on interaction
6. Template     → add SSR seed data / data-* attributes if needed
```

### Checklist before writing view code

- [ ] Does the WS message type exist and work?
- [ ] Is the new state in `AppModel`? (if it needs to persist across navigation)
- [ ] Is there a model event the view can subscribe to?
- [ ] Which view owns the DOM container for this feature?
- [ ] Does any existing view already own a parent of that container? (avoid split ownership)

---

## Preference store

All `localStorage` access goes through `settings-sync.js`:

```js
import { getPref, setPref } from '../settings-sync.js'

const theme = getPref('theme', 'dark')   // read with default
setPref('theme', 'ocean')                // write single key
setPref({ theme: 'ocean', sidebar_width: 240 })  // patch multiple
```

Keys in use:

| Key | Type | Owner |
|---|---|---|
| `theme` | string | `theme.js` |
| `recent_emoji` | string[] | `EmojiPickerSingleton` |
| `devices` | object | `CallView` |
| `tile_layout` | object | `CallView` |
| `sidebar_width` | number | `resizable.js` (sidebar) |
| `thread_panel_width` | number | `resizable.js` (thread panel) |
| `tile_panel_width` | number | `resizable.js` (tile panel) |
| `last_channel_id` | string | `router.js` / `app.js` |
| `mobile_chat_open` | boolean | `app.js` / `router.js` |

---

## Resizable panels

```js
import { attachResizeHandle } from '../resizable.js'

attachResizeHandle(el, {
  edge:    'right' | 'left',   // which edge gets the drag handle
  cssVar:  '--sidebar-width',  // CSS custom property on :root
  min:     180,                // px
  max:     480,                // px
  prefKey: 'sidebar_width',    // getPref/setPref key
})
```

The CSS custom property drives the actual layout. The handle is injected as a
`.resize-handle.resize-handle--{edge}` child of `el`.

---

## SPA navigation

`router.js` intercepts channel link clicks, fetches the new page via `fetch()`, and morphs
only the `.chat-panel` data attributes and `#messages` content — WebRTC connections and
sidebar state are preserved.

After the morph, it dispatches `chatpanel:navigated` on `document`. `app.js` handles this
event: closes transient UI, seeds the model with new channel data, calls
`model.selectChannel()`, and sends `channel.join` to the server.

Views react to `CHANNEL_SELECTED` from the model — they do not listen to `chatpanel:navigated`
directly.

---

## SSR hydration

The server renders the initial page with seed messages baked into `#messages`. On first load:

1. `MessageListView` calls `#hydrateExisting()` — walks SSR `<article>` elements, reads
   `data-reactions`, `data-attachments`, applies mention styling, wires reaction bars.
2. `SidebarView` reads hub/channel data from the existing SSR DOM and seeds `AppModel`.
3. On `HUBS_CHANGED` (from WS), `SidebarView.#renderHubs()` replaces the SSR markup with
   client-rendered markup — at that point all `<li>` elements get `data-channel-id` and
   `data-hub-id` attributes.

**SSR attribute gap:** SSR-rendered `<li class="channel-item">` elements don't have
`data-channel-id` or `data-hub-id` on the `<li>` itself — only the inner `<a>` and ancestor
`<details>` carry those. `SidebarView` normalises this at construction time by stamping the
attributes onto the `<li>` before any handlers run.
