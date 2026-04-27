# devchitchat-v2

Self-hosted chat for small technical teams. SQLite + Bun.js + JavaScript throughout.
See `plans/ideal-customer-profile.md` for the target user and `plans/architecture-decisions.md`
for significant past decisions.

---

## Stack

- **Runtime:** Bun.js
- **Server framework:** `@devchitchat/index97` (file-based routing in `pages/`)
- **Database:** SQLite via `bun:sqlite`, WAL mode, single file at `data/chat.db`
- **Real-time:** Bun native WebSockets (`src/ws/ChatServer.js`)
- **Client:** `@devchitchat/rdbljs` reactive islands, no build step
- **Tests:** `bun:test`

---

## Architecture: Hexagonal / Ports & Adapters

The codebase targets a hexagonal architecture with a functional core. Understand the layers
before making changes.

### Layers (inside → out)

```
┌─────────────────────────────────────────┐
│  Functional Core                        │
│  Pure functions — validation, business  │
│  rules, transformations. No side        │
│  effects, no I/O. Trivially testable.   │
├─────────────────────────────────────────┤
│  Application Services                   │
│  Orchestrate ports. Call repositories,  │
│  publish events. Throw ServiceError on  │
│  domain violations. No HTTP/WS code.    │
├─────────────────────────────────────────┤
│  Ports (interfaces / contracts)         │
│  IXRepository, IEventPublisher, etc.    │
│  Defined by what the service needs.     │
│  Implemented by adapters.               │
├─────────────────────────────────────────┤
│  Adapters                               │
│  SqliteXRepository, BunWsPublisher,     │
│  InMemoryXRepository (tests).           │
│  Concrete I/O. Swappable.               │
├─────────────────────────────────────────┤
│  Transport Shell                        │
│  HTTP handlers (pages/**/*.js)          │
│  WebSocket handlers (ChatServer.js)     │
│  Auth enforcement, request parsing,     │
│  response formatting. Calls services.   │
│  Should be thin — no business logic.    │
├─────────────────────────────────────────┤
│  Client Islands                         │
│  pages/public/client/islands/*.js       │
│  Reactive UI, WebSocket client.         │
│  No business logic.                     │
└─────────────────────────────────────────┘
```

### Rules

- **Services never import from `bun:sqlite` directly** — they call repository ports
- **Transport handlers never contain business logic** — if a handler exceeds ~20 lines of logic,
  extract it to a service
- **Pure functions live in `src/core/`** — validation, transformations, rule checks; no I/O
- **`src/context.js` is production wiring only** — tests construct their own instances with
  test doubles; never import from context in a test
- **Errors cross layer boundaries as `ServiceError`** — thrown by services, caught by transport,
  translated to WS error messages or HTTP responses

### Port naming convention

Ports are documented JavaScript interfaces (duck typing — no formal declaration needed):

```
IXRepository   → data access for entity X
IEventPublisher → publish domain events to subscribers
ISessionStore  → session read/write
```

Adapters are named `SqliteXRepository`, `InMemoryXRepository`, `BunWsEventPublisher`, etc.

---

## Development process

Follow this sequence for every non-trivial change:

```
1. Discuss  → talk through the design; consult ICP and ADRs as criteria
2. Plan     → write a plan in plans/ if the change spans multiple files
3. ADR      → add to plans/architecture-decisions.md if a significant decision is made
4. Migrate  → write a numbered migration in scripts/migrate/ if the schema changes
5. Core     → write pure functions in src/core/ if new business rules are needed
6. Test     → write a failing test (TDD: red first)
7. Service  → implement the service method to make the test pass
8. Refactor → clean up; reassess whether the test is worth keeping
9. Transport → add/update WS message handler or HTTP route (thin shell)
10. Client  → update islands and templates last
```

Always work inside-out: schema → core → service → transport → client. Never build UI against
an API that does not exist yet.

---

## Test-driven development

**Red → Green → Refactor.** Write a failing test before writing any implementation.

```js
// 1. Write the failing test
test('createChannel rejects duplicate names in the same hub', () => {
  const repo = new InMemoryChannelRepository()
  const service = new ChannelService({ channelRepo: repo })
  service.createChannel({ hubId: 'h1', name: 'general', ... })
  expect(() =>
    service.createChannel({ hubId: 'h1', name: 'general', ... })
  ).toThrow(ServiceError)
})

// 2. Make it pass (minimum implementation)
// 3. Refactor
// 4. Reassess — delete the test if it no longer adds value
```

### What to test at each layer

| Layer | Test with | Notes |
|---|---|---|
| Functional core (`src/core/`) | `bun:test`, no mocks | Pure functions — simplest tests |
| Services (`src/services/`) | `bun:test` + in-memory adapters | No SQLite, no WS in service tests |
| Adapters (`SqliteXRepository`) | `bun:test` + real in-memory SQLite | Test SQL correctness |
| WS handlers | `bun:test` + test WS client | Integration test; keep minimal |
| UI (complex behaviour) | `Bun.WebView` | Not CSS; complex interaction flows only |

**On keeping tests:** after refactoring, ask whether the test still documents something true and
non-obvious. If the test is trivially implied by the code it tests, delete it. Tests are not
permanent — they are design tools.

### UI testing with `Bun.WebView`

`Bun.WebView` is a headless browser built into the runtime. On macOS it uses the system
`WKWebView` (zero extra dependencies). On Linux/Windows it drives Chrome via the DevTools
Protocol. Use it only for complex interaction flows that are hard to verify otherwise — not
for CSS or layout checks.

**Pattern: start the server, open a view, interact, assert.**

```js
import { test, expect, beforeAll, afterAll } from 'bun:test'

let server

beforeAll(async () => {
  // Start the app server on a test port
  server = Bun.spawn(['bun', 'run', 'index.js'], {
    env: { ...process.env, PORT: '3001', DB_PATH: ':memory:' }
  })
  await Bun.sleep(200) // brief settle time
})

afterAll(() => server?.kill())

test('sending a message appends it to the channel', async () => {
  await using view = new Bun.WebView({ width: 1024, height: 768 })

  await view.navigate('http://localhost:3001/channels/c_test')
  await view.click('#message-input')
  await view.type('hello from test')
  await view.press('Enter')

  const lastMessage = await view.evaluate(
    `document.querySelector('.message:last-child .message-text')?.textContent`
  )
  expect(lastMessage).toBe('hello from test')
})
```

**Key API:**
- `new Bun.WebView(options)` — `width`, `height`, `url`, `console` (capture page logs)
- `await using view = ...` — auto-disposes via `Symbol.asyncDispose`
- `view.navigate(url)` — resolves on page load
- `view.evaluate(script)` — runs JS in the page, returns result (Promises awaited, JSON-serialised)
- `view.click(selector)` — native click; waits for element to be actionable automatically
- `view.type(text)` — inserts text
- `view.press(key)` — named keys (`'Enter'`, `'Tab'`, `'Escape'`) or character chords
- `view.screenshot(options)` — capture PNG/JPEG for debugging a failing test
- `view.scroll(dx, dy)` / `view.scrollTo(selector)` — fire native wheel events

**Concurrency:** one operation per view can be in flight at a time. Parallel views are
independent — spin up multiple views for multi-user interaction tests.

---

## WebSocket message conventions

Message envelope:
```js
{ v: 1, id: string, ts: number, t: string, body: object, reply_to?: string }
```

Message type naming: `<noun>.<verb>` in lowercase with dots.
- Commands (client → server): `hub.create`, `channel.update`, `msg.send`
- Events (server → client): `hub.created`, `channel.updated`, `msg.event`
- Queries: `hub.list` → `hub.list_result`
- RTC: `rtc.call_create`, `rtc.joined`, `rtc.call_state`

Every WS handler must:
1. Verify `ws.data.userId` is set (auth check)
2. Call a service method
3. Send a typed response and/or broadcast to subscribers
4. Catch `ServiceError` and send `{ ok: false, error: { code, message } }`

---

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Service classes | PascalCase + Service | `ChannelService` |
| Repository adapters | Sqlite/InMemory + entity + Repository | `SqliteChannelRepository` |
| Core functions | camelCase, verb-first | `validateChannelName`, `buildMessageEvent` |
| WS message types | noun.verb | `channel.update` |
| DB table names | snake_case, plural | `channel_members` |
| IDs | prefixed nanoid via `newId(prefix)` | `c_abc123`, `u_xyz` |
| Migration files | `NNN-description.js` | `001-add-calls.js` |

---

## Schema migrations

All schema changes go in `scripts/migrate/` as numbered JS files:

```
scripts/migrate/
  001-initial-schema.js
  002-add-calls.js
  003-add-webhooks.js
```

Run migrations: `bun run migrate`

The migration runner (`scripts/migrate.js`) maintains a `_migrations` table in the database.
Each file exports a `run(db)` function. Files are applied in filename order; already-applied files
are skipped.

```js
// scripts/migrate/002-add-calls.js
export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calls ( ... );
    CREATE TABLE IF NOT EXISTS call_participants ( ... );
  `)
}
```

**`CREATE TABLE IF NOT EXISTS` is idempotent but cannot handle column renames or adding
`NOT NULL` columns to existing tables.** For those, use `ALTER TABLE` or a
`CREATE TABLE / INSERT INTO / DROP TABLE / ALTER TABLE RENAME` sequence in the migration file.

---

## WebRTC — read the v1 codebase first

Before touching any WebRTC code (`call.js`, `SignalingService.js`, RTC handlers in
`ChatServer.js`): read the equivalent implementation in
`/Users/joeyguerra/src/devchitchat/devchitchat`. Significant debugging was invested there.
Screen share renegotiation is the highest-risk area — the v1 code has the working reference.

---

## Key plans

| Plan | What it covers |
|---|---|
| `plans/ideal-customer-profile.md` | Who this is for; use as product decision criteria |
| `plans/architecture-decisions.md` | Significant past decisions; read before revisiting them |
| `plans/channel-design.md` | Call/video/screenshare capability model and UX |
| `plans/mobile-nav-slide.md` | Mobile sidebar ↔ message panel navigation |
| `plans/hub-channel-management-ui.md` | Management UI (long-press sheets, desktop modals) |
| `plans/user-settings-persistence.md` | Local-first settings sync |
