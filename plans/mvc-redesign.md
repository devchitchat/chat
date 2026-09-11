# MVC Redesign Plan

**Branch:** `redesign`  
**Date:** 2026-09-11  
**Status:** In progress

---

## Problem

The current client architecture mixes two incompatible paradigms:

- **Sidebar** — rdbljs signals + effects (declarative)
- **Chat** — imperative DOM mutations scattered across ~1 200 lines of `call.js`

The result is the fragmentation the thread panel exposed: every new view-state concern
(replies, reactions, edits, task checkboxes) required hand-wiring update code in multiple
places. The thread panel was built by copy-pasting all message handler blocks — seven
distinct click handlers duplicated verbatim.

There is no single source of truth for message or channel state. State lives partly in
signals, partly in closure variables, partly in DOM `data-*` attributes.

---

## Goal

A **hub-and-spoke MVC** where:

- **Model** — one `AppModel extends EventTarget` holds all application state and
  dispatches `CustomEvent`s when it changes (the hub).
- **Views** — add event listeners directly on the model; each view owns exactly one DOM
  container and reacts to the events it cares about (the spokes).
- **Controllers** — translate user actions and WebSocket messages into model mutations.
  They never manipulate the DOM; views do that.

Reference: Apple's Cocoa MVC.  
Observer mechanism: browser-native `EventTarget` / `CustomEvent` — no library.

---

## Layers

```
WebSocket ──► WebSocketController ──► AppModel (EventTarget)
                                           │
User input ──► ChatController ─────────────┘
                                           │
                          ┌────────────────┼──────────────────┐
                          ▼                ▼                  ▼
                    SidebarView   MessageListView   ThreadPanelView
                                           │
                                     ComposerView
                                     CallView
```

---

## AppModel — state and events

```js
class AppModel extends EventTarget {
  // Hubs and channels (sidebar)
  #hubs = []                    // [{ hub_id, name, channels:[] }]
  #dms  = []                    // [{ channel_id, name, ... }]

  // Navigation
  #currentChannelId = null

  // Messages  (keyed by channelId so navigating back is instant)
  #messages = new Map()         // channelId → Message[]
  #oldestSeq = new Map()        // channelId → number
  #loadingMore = false

  // Thread panel
  #threadParentId = null        // null means panel is closed
  #threads = new Map()          // parentMsgId → Reply[]

  // Presence
  #presence = new Map()         // userId → 'online'|'away'|'offline'

  // Identity
  #userId = null
  #userHandle = null

  // Call state (delegated to CallModel sub-object for clarity)
  #call = null
}
```

### Event catalogue

| Event name | `detail` shape | Fired when |
|---|---|---|
| `hubs-changed` | `{ hubs }` | Hub list changes |
| `dms-changed` | `{ dms }` | DM list changes |
| `channel-selected` | `{ channelId, prev }` | Active channel changes |
| `message-added` | `{ channelId, message }` | New message arrives |
| `message-updated` | `{ channelId, message }` | Message edited |
| `message-deleted` | `{ channelId, msgId }` | Message deleted |
| `reactions-updated` | `{ msgId, reactions }` | Reactions changed |
| `messages-prepended` | `{ channelId, messages }` | Older messages loaded |
| `thread-opened` | `{ parentMsgId, parentMsg }` | Thread panel opens |
| `thread-closed` | `{}` | Thread panel closes |
| `thread-reply-added` | `{ parentMsgId, reply }` | New reply arrives |
| `thread-reply-updated` | `{ parentMsgId, reply }` | Reply edited |
| `thread-reply-deleted` | `{ parentMsgId, replyId }` | Reply deleted |
| `presence-updated` | `{ userId, status }` | Presence changes |
| `members-updated` | `{ channelId, members }` | Member list changes |
| `call-changed` | `{ call }` | Call state changes |
| `loading-more-changed` | `{ loading }` | Pagination in flight |

---

## File structure

```
pages/public/client/
├── app.js                        ← updated: wire MVC, drop rdbljs init
├── ws.js                         ← unchanged
├── router.js                     ← simplified: just updates model.currentChannel
├── settings-sync.js              ← unchanged
│
├── model/
│   ├── AppModel.js               ← new: hub, all state, CustomEvents
│   └── events.js                 ← new: event name constants
│
├── controllers/
│   ├── WebSocketController.js    ← new: ws.on(...) → model.mutate(...)
│   ├── ChatController.js         ← new: user actions → ws.send / model
│   └── NavigationController.js  ← new: channel switching, history API
│
├── views/
│   ├── SidebarView.js            ← replaces islands/sidebar.js
│   ├── MessageListView.js        ← replaces appendMessage et al. in call.js
│   ├── ThreadPanelView.js        ← replaces thread block in call.js; no duplication
│   ├── ComposerView.js           ← replaces composer block in call.js
│   └── CallView.js               ← replaces WebRTC block in call.js
│
└── shared/
    └── messages.js               ← unchanged: makeMessageEl, renderAttachment, etc.
```

`islands/call.js` and `islands/sidebar.js` are deleted once their replacements are live.

---

## Implementation sequence

Work inside-out, keeping the app runnable at each step.

### Phase 1 — Model
1. `model/events.js` — event name constants
2. `model/AppModel.js` — all state + mutators + event dispatch

### Phase 2 — WebSocket Controller
3. `controllers/WebSocketController.js`
   - one `WsClient`, owned here
   - every `ws.on(...)` maps to a model mutator call
   - handles reconnect subscription restoration

### Phase 3 — Views (message-related, most value)
4. `views/MessageListView.js`
   - listens: `message-added`, `message-updated`, `message-deleted`, `reactions-updated`,
     `messages-prepended`, `channel-selected`
   - owns `#messages` container
   - reuses `makeMessageEl`, `renderAttachment` from `shared/messages.js`
   - event delegation for click actions (reactions, edits, thread open)
   - IntersectionObserver for pagination sentinel

5. `views/ThreadPanelView.js`
   - listens: `thread-opened`, `thread-closed`, `thread-reply-added`, etc.
   - owns `#thread-panel`, `#thread-anchor`, `#thread-replies`
   - reuses the same `makeMessageEl` — **no handler duplication**
   - click actions delegate to `ChatController`

6. `views/ComposerView.js`
   - owns the message textarea, attachment chips, mention picker
   - emits a `submit` CustomEvent that `ChatController` listens to

### Phase 4 — Sidebar view
7. `views/SidebarView.js`
   - listens: `hubs-changed`, `dms-changed`, `channel-selected`, `presence-updated`
   - pure DOM, no rdbljs
   - delegates hub/channel actions to `ChatController`

### Phase 5 — Chat Controller
8. `controllers/ChatController.js`
   - handles: send, react, edit, delete, thread open/close, pagination requests
   - user actions arrive as events from views; responses go via model

### Phase 6 — Navigation
9. `controllers/NavigationController.js`
   - wraps `history.pushState`
   - calls `model.selectChannel(channelId)` on navigation
   - responds to `popstate`

### Phase 7 — Call view
10. `views/CallView.js`
    - ports WebRTC code from `call.js` with minimal changes
    - listens: `call-changed`, `channel-selected`

### Phase 8 — Wire up and clean up
11. `app.js` rewritten: instantiate model, controllers, views; no `rdbljs.init()`
12. Delete `islands/call.js`, `islands/sidebar.js`
13. Remove `[island]` attributes from HTML templates
14. Remove rdbljs import from `package.json` if no longer needed

---

## Key design rules

- **Model has no DOM imports.** It is a plain `EventTarget` subclass.
- **Views never call `ws.send()`.** They dispatch events or call controller methods.
- **Controllers never mutate the DOM.** They call model mutators.
- **Thread replies and channel messages share one render function** (`makeMessageEl`).
  `ThreadPanelView` is a separate view with its own container — not a copy of
  `MessageListView`'s handlers.
- **Event delegation over per-element listeners** — one click listener on the container
  covers all messages including dynamically added ones.
- **Model caches messages by channel** — navigating back to a visited channel renders
  instantly from cache; no re-fetch needed.

---

## What this fixes

| Problem | Fix |
|---|---|
| Thread handlers duplicated from chat handlers | `ThreadPanelView` shares `makeMessageEl`; single click delegate per container |
| Reaction update code in three places | `reactions-updated` event; both views handle it in their own click delegate |
| State scattered across signals, vars, DOM attrs | Everything in `AppModel` |
| Mixed rdbljs + imperative DOM | One paradigm: `EventTarget` + plain DOM |
| Hard to trace: who updated what? | Controller → model mutator → event → view; one path |
| No message cache between navigations | `#messages` Map in model, keyed by channelId |
