# Mobile Navigation: Slide-In Message View

## Status: Implemented

---

## What Was Built

On mobile (≤ 700px), the sidebar is the default view. Tapping a channel slides the message
panel in from the right. A back button in the chat header returns to the sidebar.

### Interaction model

| Trigger | Result |
|---|---|
| Page load on mobile (no channel) | Sidebar visible; chat panel off-screen right |
| Page load on mobile (channel URL) | `body:has(.main-content)` CSS rule slides chat panel into view automatically — no JS needed |
| Tap a channel link | Sidebar removes `sidebar-open`; `body:has(.main-content)` rule takes over — chat panel slides in |
| Tap back button (←) in chat header | `body.sidebar-open` class added → sidebar slides in, chat panel slides out |

### CSS approach

Both panels are `position: fixed`, full-screen, stacked side by side via `translateX`.
`body:has(.main-content)` detects channel pages without JS. `body.sidebar-open` is the only
JS-toggled class. `100dvh` keeps panels sized correctly when the mobile keyboard opens.

```
Default (hub list page): sidebar translateX(0), main-content translateX(100%)
Channel page default:    sidebar translateX(-100%), main-content translateX(0)   ← :has() rule
Sidebar-open state:      sidebar translateX(0), main-content translateX(100%)    ← .sidebar-open class
```

### Files changed

| File | Change |
|---|---|
| `pages/public/themes/base.css` | `@media (max-width: 700px)` block: both panels fixed/full-screen, `translateX` slide logic, `.btn-back-mobile` shown |
| `pages/channels/[channelId].phtml` | `<button class="btn-back-mobile">` added inside `.chat-header` |
| `pages/public/client/islands/chat.js` | Back button click adds `body.sidebar-open` |
| `pages/public/client/islands/sidebar.js` | Channel link click removes `body.sidebar-open` |

---

## What Was Not Implemented

**Long-press + swipe-right gesture** — The original plan described a gesture where the user
holds for ≥ 300ms then swipes right to dismiss the chat panel. This was not built. The back
button (←) covers the use case and avoids conflict with browser back-gesture and horizontal
scroll in the message list.
