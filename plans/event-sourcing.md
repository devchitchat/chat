# Event Sourcing Migration Plan

## Goal

Replace the mutable-state persistence model with a Command → Event → Projection pipeline:

- **Commands** express intent (sent from the transport layer)
- **Command handlers** validate, apply business rules, and emit domain events
- **EventStore** appends events to SQLite durably
- **EventBus** delivers events in-process to subscribers
- **Projections** (view builders) maintain SQLite read models by applying events — both live
  as they arrive and by replaying the full event log on process boot

The existing `events` audit-log table becomes the event store. Read models (messages,
deliveries, channel membership, etc.) become projections derived entirely from the event log.

---

## Chosen slice: message sending

`msg.send` is the highest-frequency, most load-bearing operation and touches the most
projection surfaces. Building it out first proves:

1. Append-only event store with per-channel sequencing
2. Boot-time replay that rebuilds the `messages` read model
3. A live projection that fans out to multiple read models simultaneously
4. Integration with the existing WebSocket broadcast without touching unrelated code

**Command:** `SendMessage`
**Events:** `MessageSent`
**Projections:** `ChannelMessagesProjection`, `MessageDeliveryProjection`, `FtsIndexProjection`

---

## Architecture layers

```
Transport (ChatServer.js)
  │  thin: parse + auth only
  │
  ▼
CommandBus                         ← dispatch by command.type
  │
  ▼
SendMessageHandler                 ← validate, read projection state, emit events
  │
  ├─► EventStore.append(events)    ← durable, SQLite append-only
  │
  └─► EventBus.publish(events)     ← in-process, sync or async
          │
          ├─► ChannelMessagesProjection   → writes to `messages` table
          ├─► MessageDeliveryProjection   → writes to `deliveries` table
          └─► FtsIndexProjection          → writes to `fts_messages` table
```

On read (e.g. `msg.list`), handlers query the read-model tables directly — projections own
those tables.

---

## Core primitives

### Command

A plain object describing intent. No I/O. Created in the transport layer.

```js
// src/commands/SendMessage.js
export function SendMessage({ channelId, userId, text, clientMsgId, msgId, ts }) {
  return { type: 'SendMessage', channelId, userId, text, clientMsgId, msgId, ts }
}
```

All command factory functions live in `src/commands/`. They only shape the object — no
validation. Validation belongs in the handler.

### Event

A plain object recording what happened. Immutable once emitted.

```js
// src/events/MessageSent.js
export function MessageSent({ msgId, channelId, seq, userId, text, clientMsgId, ts }) {
  return {
    type:          'MessageSent',
    aggregateType: 'channel',
    aggregateId:   channelId,
    body:          { msgId, channelId, seq, userId, text, clientMsgId, ts },
  }
}
```

All event factory functions live in `src/events/`.

### EventStore

Appends events to the `event_store` SQLite table and assigns a global monotonic `position`.

```js
// src/adapters/SqliteEventStore.js
class SqliteEventStore {
  // append(events: Event[]): { position: number }[]
  //   → inserts all events in a single transaction
  //   → returns assigned positions
  append(events) { ... }

  // load(opts: { afterPosition?, aggregateType?, aggregateId? }): Event[]
  loadAll(opts = {}) { ... }
}
```

Schema (new migration `scripts/migrate/NNN-event-store.js`):

```sql
CREATE TABLE IF NOT EXISTS event_store (
  position       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT    NOT NULL UNIQUE,
  aggregate_type TEXT    NOT NULL,
  aggregate_id   TEXT    NOT NULL,
  type           TEXT    NOT NULL,
  actor_user_id  TEXT,
  ts             INTEGER NOT NULL,
  body_json      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_es_aggregate
  ON event_store (aggregate_type, aggregate_id, position);
CREATE INDEX IF NOT EXISTS idx_es_type ON event_store (type, position);
```

The existing `events` audit table is left untouched during the migration slice. It is removed
in a later migration once all slices are converted.

### EventBus

In-process pub/sub. Subscribers register before boot replay; events flow through the same bus
both on replay and live.

```js
// src/EventBus.js
class EventBus {
  #subscribers = new Map()  // eventType → Set<handler>

  subscribe(eventType, handler) { ... }
  subscribeAll(handler) { ... }   // receive every event
  publish(events) { ... }         // calls all matching handlers synchronously
}
```

`publish` is synchronous so that projections are up to date before the command handler
returns. If a projection throws, the error propagates to the handler (which can decide whether
to abort or log and continue).

### CommandBus

Routes commands to their handlers.

```js
// src/CommandBus.js
class CommandBus {
  #handlers = new Map()  // commandType → handler fn

  register(commandType, handler) { ... }

  // handle(command): Promise<{ events, result }>
  async handle(command) { ... }
}
```

### Command handlers

Handlers receive the command plus injected dependencies. They:

1. Read current state from projections (read models), not from a "write side" aggregate store
2. Apply business rules and validation (throw `ServiceError` on violation)
3. Create event objects
4. Return `{ events, result }` — the bus handles append + publish

```js
// src/handlers/SendMessageHandler.js
export function makeSendMessageHandler({ channelMemberRepo, messageRepo, eventStore, eventBus, nowFn }) {
  return async function handleSendMessage(cmd) {
    // 1. Read state from projection
    const isMember = await channelMemberRepo.isMember(cmd.channelId, cmd.userId)
    if (!isMember) throw new ServiceError('FORBIDDEN', 'not a channel member')

    // 2. Validate
    if (!cmd.text?.trim()) throw new ServiceError('INVALID', 'message text is required')

    // 3. Assign seq atomically inside EventStore.append (see below)
    const seq = await messageRepo.nextSeq(cmd.channelId)
    const ts  = cmd.ts ?? nowFn()

    // 4. Build event
    const event = MessageSent({ ...cmd, seq, ts })

    // 5. Persist + fan out
    eventStore.append([event])
    eventBus.publish([event])

    return { events: [event], result: { msgId: cmd.msgId, seq, ts } }
  }
}
```

Seq assignment happens inside a SQLite transaction in `messageRepo.nextSeq` — `SELECT MAX(seq)
+ 1 ... FOR UPDATE` equivalent (SQLite serialises writes, so this is safe).

---

## Projections

Each projection subscribes to one or more event types and applies them to a SQLite read model.

```js
// src/projections/ChannelMessagesProjection.js
export class ChannelMessagesProjection {
  constructor({ db }) {
    this.#insert = db.prepare(`
      INSERT OR IGNORE INTO messages
        (msg_id, channel_id, seq, user_id, text, ts, client_msg_id)
      VALUES ($msg_id, $channel_id, $seq, $user_id, $text, $ts, $client_msg_id)
    `)
  }

  // Called by EventBus on every MessageSent event
  onMessageSent(event) {
    const b = event.body
    this.#insert.run({ $msg_id: b.msgId, $channel_id: b.channelId,
                       $seq: b.seq, $user_id: b.userId,
                       $text: b.text, $ts: b.ts,
                       $client_msg_id: b.clientMsgId })
  }
}
```

`INSERT OR IGNORE` makes replay idempotent — re-running on boot with an already-populated read
model is a no-op.

### Boot-time replay

```js
// src/ProjectionRunner.js
export async function replayAll({ eventStore, projections }) {
  const events = eventStore.loadAll()
  for (const event of events) {
    for (const projection of projections) {
      projection.apply?.(event)   // or dispatch by event.type
    }
  }
}
```

Called once in `index.js` before the server accepts connections:

```js
await replayAll({ eventStore, projections: [channelMessagesProjection, deliveryProjection, ftsProjection] })
```

After replay, projections subscribe to the live EventBus. From that point on, events flow
through the same `apply` path — no separate code for "live" vs "replay".

---

## File layout

```
src/
  commands/
    SendMessage.js
  events/
    MessageSent.js
  handlers/
    SendMessageHandler.js
  projections/
    ChannelMessagesProjection.js
    MessageDeliveryProjection.js
    FtsIndexProjection.js
  adapters/
    SqliteEventStore.js              ← new
    InMemoryEventStore.js            ← for tests
    SqliteChannelRepository.js       ← unchanged (still used for reads in handlers)
    ...
  CommandBus.js
  EventBus.js
  ProjectionRunner.js
scripts/migrate/
  NNN-event-store.js
```

The existing service (`MessageService`) is not deleted immediately. During the migration slice,
the ChatServer handler is updated to call the CommandBus instead of calling the service directly.
`MessageService` is removed in a follow-up once the projection read models are verified correct.

---

## Implementation sequence (TDD, inside-out)

### 0 — Migration

- [ ] Write `scripts/migrate/NNN-event-store.js` — creates `event_store` table + indexes
- [ ] Run migration in dev, confirm schema

### 1 — Event factory

- [ ] `src/events/MessageSent.js` — factory function, no tests needed (pure shape)

### 2 — EventStore

- [ ] `src/adapters/InMemoryEventStore.js` — in-memory implementation for tests
- [ ] Test: `append` stores events; `loadAll` returns them in position order
- [ ] `src/adapters/SqliteEventStore.js` — SQLite implementation; same interface
- [ ] Test: same assertions against real SQLite (`:memory:`)

### 3 — EventBus

- [ ] `src/EventBus.js`
- [ ] Test: subscriber receives published events; subscribeAll receives all types; sync delivery

### 4 — ChannelMessagesProjection

- [ ] `src/projections/ChannelMessagesProjection.js`
- [ ] Test: `apply(MessageSent(...))` inserts a row into `messages`; idempotent on second apply

### 5 — SendMessageHandler

- [ ] `src/commands/SendMessage.js`
- [ ] `src/handlers/SendMessageHandler.js`
- [ ] Test (full command → projection cycle, using InMemory adapters):
  - non-member throws `ServiceError('FORBIDDEN')`
  - empty text throws `ServiceError('INVALID')`
  - valid command appends event, projection row visible
  - second identical command (same `msgId`) is idempotent in projection

### 6 — CommandBus

- [ ] `src/CommandBus.js`
- [ ] Test: dispatches to registered handler; unregistered type throws

### 7 — ProjectionRunner

- [ ] `src/ProjectionRunner.js`
- [ ] Test: events in store are replayed; projection state matches

### 8 — Wire into transport

- [ ] Update `ChatServer.js` `#handleMsgSend`:
  - Build `SendMessage` command from WS message body
  - Call `commandBus.handle(command)` instead of `messageService.sendMessage`
  - Use `result` from handler for the WS ack
- [ ] Update `context.js` / `index.js` to instantiate EventStore, EventBus, projections, handler,
  CommandBus, and call `replayAll` before server start
- [ ] Manual smoke test: send a message, verify it appears in channel, verify restart replays correctly

### 9 — Verify + clean up

- [ ] Confirm `MessageService.sendMessage` is no longer called → remove or leave as dead code
  until all slices are converted
- [ ] Add ADR entry to `plans/architecture-decisions.md`

---

## Concurrency and consistency notes

**SQLite serialises all writes.** Because Bun runs a single-threaded event loop and SQLite in
WAL mode only allows one writer, `nextSeq` + `eventStore.append` executing in the same
synchronous transaction is safe without additional locking.

**Idempotency.** Command handlers deduplicate using `msgId` (generated by the client or
assigned by the transport before dispatch). `INSERT OR IGNORE` in projections + `UNIQUE
event_id` in the event store ensures replaying the same event twice has no effect.

**Projection lag.** Projections are applied synchronously before the handler returns, so read
models are always up to date when the WS ack is sent back to the client. This mirrors the
current behaviour.

---

## What this slice does NOT cover

The following are intentional out-of-scope for this slice. Each becomes its own migration plan
once this one is proven:

- Channel and hub lifecycle (CreateChannel, DeleteChannel, etc.)
- Membership events (MemberJoined, MemberLeft)
- Auth events (UserRegistered, SessionStarted)
- Snapshotting for fast boot on large event logs
- Global event position cursor for delivery tracking
- WebRTC signalling events

---

## Success criteria

1. `msg.send` goes through CommandBus → handler → EventStore → EventBus → projections
2. `msg.list` reads from the `messages` projection table (same as today — no transport change)
3. Killing and restarting the process replays all `MessageSent` events and restores the
   `messages` table to its pre-shutdown state (verify with `messages` count before/after)
4. All new units (`EventStore`, `EventBus`, `ChannelMessagesProjection`, `SendMessageHandler`,
   `ProjectionRunner`) have passing tests using in-memory adapters
5. No regressions in existing WS message handling for unrelated message types
