# Plan: Agent Card Receipts + Activity

**Status:** In progress  
**Date:** 2026-10-27  
**Touches:** chatopsjs, chat (client + core), agent

---

## Problem

Finished agent cards are walls of text that bury human messages. The agent's questions
("Want me to push?") get lost. Active cards show a growing tool list instead of a single
live line.

---

## Goals

1. Done cards default to ~4 lines: title, chips, ask, expand links.
2. "Full report" and "Activity" expand independently; stay open across live edits.
3. Active cards show one moving tool line + collapsed activity list.
4. Action buttons send a thread reply; answered state is visible to everyone.
5. Old cards (no receipt) still render sensibly.

---

## Schema change (backward-compatible)

Add optional `receipt` field to `card_json`:

```json
"receipt": {
  "title":  "Fixed 5 failing tests",
  "tone":   "ok | warn | error | neutral",
  "chips":  [{ "text": "140/140 passing", "tone": "ok" }],
  "note":   "Not tested on a real phone yet.",
  "ask":    { "question": "Push both commits?", "actions": ["Push", "Not yet"],
              "answered": { "action": "Push", "by": "u_abc", "at": 1234567890 } }
}
```

No DB migration needed: `card_json` is opaque JSON today.

---

## Rollout order

1. **chat client** — renders old cards (no receipt) correctly before agent changes ship.
2. **chatopsjs** — `receipt` pass-through in `createCardResponse`.
3. **agent** — receipt prompt, extraction, answered-ask handling.

---

## Files changed

### chatopsjs

- `src/lib/Response.js` — add `receipt` param to `createCardResponse` and `cardDone`.

### chat (server is untouched — card_json is opaque)

- `src/core/receipt.js` (**new**) — pure helpers: `wordCount`, `deriveTitle`, `validateReceipt`
- `test/agent-card-receipt.test.js` (**new**) — TDD tests for pure helpers
- `plans/architecture-decisions.md` — ADR-007
- `pages/public/client/views/AgentCardView.js` — receipt rendering, expand state, action buttons
- `pages/public/themes/base.css` — new receipt CSS classes
- `pages/public/client/views/MessageListView.js` — pass `channelId`, `getHandle`, `getDisplayName` in ctx

### agent

- `src/modules/llm/index.js` — system prompt addition, receipt extraction, streaming strip,
  answered-ask detection via in-memory cache

---

## Key design decisions

### Expand-state persistence across live edits (every 500 ms)

Store `data-open-report` and `data-open-activity` on the `<article>` element.
`updateAgentCard` reads these before replacing `cardEl.innerHTML` and passes them into
`renderCardContent` so the sections render with the right `hidden` attribute and
`aria-expanded` state.

### Event delegation for interactive elements

A single delegated `click` listener on the `.agent-card` div (attached once in
`makeAgentCardEl`) handles both toggle-link clicks and action-button clicks.  
Because the listener is on `cardEl` (not on its innerHTML), it survives every
`cardEl.innerHTML = ...` replacement in `updateAgentCard`.

### Action button → thread reply via dispatch

When an action button is clicked, the handler dispatches `send-thread-reply` with
`{ channelId, parentMsgId: cardMsgId, text: '@{authorHandle} {action}' }`.  
`ChatController` already handles `send-thread-reply`.

The card author's handle is stored in `data-author-handle` on the button at render time.

### Answered-ask detection in agent (no new API needed)

The agent keeps an in-memory `cardAskCache` (`Map<cardMsgId, { receipt, channelId }>`) and
`cardStateCache` (`Map<cardMsgId, lastCard>`).  
When a reply thread arrives whose `envelope.meta.parentMsgId` is in the cache and the text
matches an action, the agent edits the card to set `receipt.ask.answered` — without any new
HTTP endpoint.

### Fallback title without a receipt

`deriveTitle(body)` strips common markdown syntax, extracts the first sentence, and
truncates at 100 characters. Never shows the full body wall by default.

---

## What's out of scope

- Thread panel (no agent cards rendered there today).
- New WS message types.
- Server or DB migrations.
