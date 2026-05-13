# Channel SPA Navigation — Plan

Keep WebRTC streams alive when switching channels by intercepting link clicks,
fetching the new channel page, and morphing only the chat panel in place.

---

## Problem

Every `<a href="/channels/:id">` click causes a full browser navigation. The
entire JS environment is torn down — WebSocket, WebRTC peer connections, media
streams, and all island state. The user is dropped from the call.

The streams don't technically need to stop. The peer connections and tracks live
in JS heap memory. If we avoid a full page reload we keep them.

---

## Root fix

Intercept channel link clicks at the document level. Instead of navigating,
fetch the new channel page, parse it with `DOMParser`, and morph only the
`.chat-panel` section in place. Then tell the existing `call.js` island to
switch its chat state to the new channel. The island instance — and all its
WebRTC state — never goes away.

### What gets morphed vs preserved

```
.main-content
  .chat-panel   ← targeted partial morph (data-* attrs + .messages content only)
  .tile-panel   ← untouched (tile grid, streams stay alive)
<aside.sidebar> ← untouched (already updates reactively via WS)
```

We do **not** do a full recursive morph of `.chat-panel` — that would clobber
the rdbljs event bindings (`onclick=`, `model=`) already wired by `bind()`.
Instead, a targeted update:

1. Copy the new page's `.chat-panel` `data-*` attributes onto the existing element
2. Replace `.messages` innerHTML with the new page's `.messages` content
   (includes both seed messages and the `<template>` element)
3. Dispatch `chatpanel:navigated` so the island re-initialises its chat state

---

## Event flow

```
user clicks .channel-link
  │
  ├─► sidebar.js click handler fires first (bubbles from aside → document)
  │     dispatches channelnavigated  → call.js shows mini-bar if in a call
  │     hides mobile sidebar
  │
  └─► router.js document-level listener fires
        preventDefault  (stops browser navigation)
        pushState(newUrl)
        fetch(newUrl)  →  parse  →  targeted morph
        dispatch chatpanel:navigated  → call.js re-initialises chat state
```

No changes to `sidebar.js`. It keeps dispatching `channelnavigated` (mini-bar)
and hiding the mobile sidebar. The router is additive.

---

## New file — `pages/public/client/router.js`

```js
// router.js — intercepts /channels/* link clicks for SPA navigation.
// Fetches the new page, morphs only .chat-panel, then fires chatpanel:navigated.

export function initRouter() {
  document.addEventListener('click', handleClick)
  window.addEventListener('popstate', () => navigateTo(location.href, false))
}

function isChannelUrl(href) {
  try {
    const url = new URL(href, location.href)
    return url.origin === location.origin && /^\/channels\//.test(url.pathname)
  } catch { return false }
}

async function handleClick(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const link = e.target.closest('a[href]')
  if (!link || !isChannelUrl(link.href)) return
  e.preventDefault()
  history.pushState({}, '', link.href)
  await navigateTo(link.href, true)
}

async function navigateTo(url, scroll) {
  let html
  try {
    const res = await fetch(url, { headers: { Accept: 'text/html' } })
    if (!res.ok) { location.href = url; return }   // fallback on error
    html = await res.text()
  } catch { location.href = url; return }

  const next = new DOMParser().parseFromString(html, 'text/html')
  const nextPanel = next.querySelector('.chat-panel')
  const currPanel = document.querySelector('.chat-panel')
  if (!nextPanel || !currPanel) { location.href = url; return }  // structure mismatch

  // 1. Copy data-* attributes so the island can read them after the event
  for (const { name } of [...currPanel.attributes]) {
    if (name.startsWith('data-')) currPanel.removeAttribute(name)
  }
  for (const { name, value } of [...nextPanel.attributes]) {
    if (name.startsWith('data-')) currPanel.setAttribute(name, value)
  }

  // 2. Swap .messages content (seed messages + template from new page)
  const currMessages = currPanel.querySelector('#messages')
  const nextMessages = nextPanel.querySelector('#messages')
  if (currMessages && nextMessages) {
    currMessages.innerHTML = nextMessages.innerHTML
  }

  // 3. Notify the existing island
  const dataset = currPanel.dataset
  document.dispatchEvent(new CustomEvent('chatpanel:navigated', {
    detail: {
      channelId:    dataset.id,
      name:         dataset.name,
      topic:        dataset.topic ?? '',
      kind:         dataset.kind ?? 'text',
      seedSeq:      parseInt(dataset.seedSeq ?? '0', 10),
    }
  }))

  if (scroll) currMessages?.scrollTo(0, currMessages.scrollHeight)
}
```

No server changes. The full page is fetched and parsed client-side, same as
`hmr-client.js` does for HMR.

---

## `app.js` changes

```js
import { initRouter } from '/client/router.js'

// …existing init code…

await init(window)

initRouter()     // ← add after islands mount

initSwipeNav()
```

`initRouter()` must come after `init(window)` so the islands are already wired
when the first `chatpanel:navigated` event fires.

---

## `call.js` changes

### 1. `channelId` and `channelKind` — change from `const` to `let`

```js
// Before
const channelId  = root.dataset.id
const channelKind = root.dataset.kind ?? 'text'

// After
let channelId  = root.dataset.id
let channelKind = root.dataset.kind ?? 'text'
```

### 2. Handle `chatpanel:navigated`

Add this handler alongside the existing `channelnavigated` listener:

```js
document.addEventListener('chatpanel:navigated', async (e) => {
  const { channelId: newId, name, topic, kind, seedSeq: newSeedSeq } = e.detail
  if (newId === channelId) return   // same channel — nothing to do

  // Leave old channel pub/sub on the server
  ws.send({ t: 'channel.leave', body: { channel_id: channelId } })

  // Update local identity
  channelId = newId
  channelKind = kind
  channelName.set(name)
  channelTopic.set(topic)
  afterSeq = newSeedSeq

  // Update browser tab title and composer placeholder
  document.title = `#${name} — devchitchat`
  const textarea = root.querySelector('#message-input')
  if (textarea) textarea.placeholder = `Message in ${name}`

  // Join new channel — server responds with channel.joined + rtc.call_state
  ws.send({ t: 'channel.join', body: { channel_id: channelId } })

  // If in a call, mini-bar is already shown by the channelnavigated handler.
  // call-status row will update from the rtc.call_state the server sends on join.
})
```

The `.messages` DOM content was already swapped by the router before this event
fires, so `msg.list` (triggered by `channel.joined`) will append any messages
that arrived after `seedSeq`.

### 3. No teardown of RTC state

`_teardownCall()` is not called during channel navigation. WebRTC peer
connections, streams, and the `peerActors` Map stay intact. The tile panel
and tile grid are siblings of `.chat-panel` and are not touched by the morph.

---

## `sidebar.js` changes

None. The existing `channelnavigated` dispatch (mini-bar) and mobile sidebar
hide continue to work. The router's `preventDefault` stops the browser from
navigating; the sidebar's side effects still fire normally.

The `navigateAfterDeletion` function still uses `window.location.href` — a
full reload is appropriate when the current channel is deleted.

---

## File checklist

| File | Change |
|---|---|
| `pages/public/client/router.js` | New file — click intercept, fetch, targeted morph, dispatch |
| `pages/public/client/app.js` | Import and call `initRouter()` after `init(window)` |
| `pages/public/client/islands/call.js` | `const channelId/channelKind` → `let`; add `chatpanel:navigated` handler |

No server changes. No schema changes.

---

## Build order

```
1. router.js: click intercept + pushState only (no fetch yet) — verify preventDefault
   stops reload and channelnavigated still fires
2. router.js: add fetch + DOMParser + attribute morph — verify data-* update
3. router.js: add .messages innerHTML swap
4. router.js: dispatch chatpanel:navigated
5. call.js: channelId/channelKind → let; add chatpanel:navigated handler (leave + join)
6. app.js: wire initRouter()
7. Test: start call, switch channels, verify streams + tile panel survive
8. Test: browser back/forward navigates correctly
```

---

## Edge cases to handle

| Scenario | Behaviour |
|---|---|
| Fetch fails (network error / 5xx) | Fall through to `location.href = url` (full reload) |
| Navigating to the same channel | `chatpanel:navigated` handler guards `if (newId === channelId) return` |
| Rapid clicks (two in-flight fetches) | Last-write-wins is acceptable; add an `inFlight` flag to cancel the first |
| Browser back/forward | `popstate` re-runs `navigateTo(location.href)` |
| Channel deleted while viewing it | `navigateAfterDeletion` still does a full reload — no change |
| Mobile: sidebar stays open after nav | Sidebar's existing click handler already closes it |

---

## Out of scope

- Cancelling an in-flight navigation on rapid clicks (follow-on; last-write-wins is fine for now)
- Prefetching on hover (follow-on)
- Scroll position restore on back/forward (follow-on)
- The `<title>` element in `<head>` is updated manually in the handler; the sidebar and
  other `<head>` content are not morphed (not needed)
