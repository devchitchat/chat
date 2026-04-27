# Ideal Customer Profile

## Product vision in one sentence

A self-hosted, SQLite-backed chat system for small technical teams that treats automation and
integration as first-class features, not bolt-ons.

---

## Primary ICP: The ChatOps Operator

### Who they are

A solo developer or small engineering team (1–10 people) who wants to own their communication
infrastructure and wire it directly into their own systems. They are running their own domain, have
a VPS or home server, and are comfortable with Bun and JavaScript. They want something they can
actually modify.

### Job to be done

Be the nerve center for their operations — deployment notifications come in, bot commands go out,
the team coordinates in the same place their tools talk. On quiet days it stays out of their way.
When something breaks at 2am they want one place to look.

### Pains with existing tools

| Tool | Why it falls short |
|---|---|
| Slack | Per-seat pricing scales badly for small teams; data lives on Slack's servers; inbound webhooks mean third-party traffic leaving your infrastructure |
| Discord | Designed for gaming communities, not ops workflows; data collection requirements; wrong mental model for a professional context |
| Mattermost / Rocket.Chat | Heavyweight — requires a separate database server, higher ops burden, more moving parts than the job demands |
| Teams | Enterprise-first; deeply coupled to Microsoft infrastructure |

### What they're willing to trade

They will accept setup friction (DNS, TLS, `bun install`) in exchange for:
- Their data on hardware they control
- No per-seat cost
- A codebase they can read and modify
- A system that doesn't phone home

### Technical profile

- Comfortable with Bun / Node.js and JavaScript
- Self-hosts other tools (Gitea, Grafana, Uptime Kuma, etc.)
- Uses CI/CD pipelines, monitoring, and deployment automation
- Has a domain and knows how to point it at a server
- Writes scripts to automate repetitive work
- Familiar with Hubot or similar bot frameworks

### Deployment context

- Single VPS (1–4 vCPU, 1–4 GB RAM) or a capable home server
- Public internet, own domain, TLS
- SQLite is a feature: the entire state of the system is one file, backup is a file copy
- Instance serves one team — single-tenant by design

### Scale

- 1–10 human users
- 1–several bots (automation, alerts, integrations)
- Dozens of channels across a handful of hubs
- Thousands of messages per day at the high end — well within SQLite's range

---

## Secondary ICP: The Family Admin / Privacy-Conscious Parent

### Who they are

A parent who wants a private, walled-garden chat space for their kids and close friends — without
the data collection requirements, recommender algorithms, or exposure to strangers that consumer
platforms impose. They have enough technical capability to run a server on a home machine or
Raspberry Pi, or they have a technically capable friend who can set it up.

### Job to be done

Give their family a safe place to talk that they control. No age verification via ID upload, no
engagement-optimized feeds, no data brokers. Just a chat system where the admin knows everyone on
it.

### How this ICP relates to the primary

Both share the same root motivation — **data sovereignty and distrust of centralized platforms**.
The Family Admin is running the same binary as the ChatOps Operator, on the same SQLite foundation,
with the same single-tenant model. The difference is which features are active and what the admin
role means.

This ICP is addressed through **product configuration**, not a separate codebase (see Profiles
below).

---

## What makes this product different

The combination that no existing tool offers:

1. **SQLite + Bun = genuinely lightweight self-hosting.** The whole system is `git clone &&
   bun install && bun run index.js`. No separate database process, no Redis, no message queue.
   The state of the entire deployment is one file you can copy, open in DB Browser, and query
   with SQL.

2. **Bot-first, not bot-as-afterthought.** Bots authenticate with API tokens, connect via the
   same WebSocket protocol as humans, and are members of channels. The
   [ChatOpsJS](https://github.com/devchitchat/chatopsjs) adapter is the integration layer — a
   Hubot-style framework that connects to the chat server and exposes a scripting API for
   automation. Webhooks in and out are adapter responsibilities; the server stays simple.

3. **Isolated, not federated.** Each instance is one team's private system. There is no
   inter-instance routing, no account portability, no discovery. This is a deliberate choice —
   federation aligns with a different product vision (competing with Slack at scale, ActivityPub,
   Matrix). Isolation keeps the security model simple and the ops burden low.

4. **JavaScript all the way through.** The operator can read the source, modify it, and extend
   it. There is no compiled binary they cannot inspect. This is table stakes for a tool positioned
   as "yours."

5. **Public internet ready by default.** TLS, `HttpOnly` cookies, rate limiting, security headers
   — these are defaults, not configuration. The operator should not have to opt into security.

---

## Integration architecture

```
External systems (GitHub, CI, monitoring, etc.)
        │
        │  HTTP webhooks (inbound)
        ▼
 ┌─────────────────┐
 │   ChatOpsJS     │  ← Hubot-style framework
 │   Adapter       │    Receives webhooks, parses commands,
 └────────┬────────┘    fires outbound calls
          │
          │  WebSocket (bot auth token)
          ▼
 ┌─────────────────┐
 │  devchitchat    │  ← This application
 │  chat server    │    Channels, messages, presence,
 └─────────────────┘    human users + bot users
          │
          │  Browser WebSocket / HTTP
          ▼
     Human users
```

**Key contract:** The adapter handles all integration logic. It receives inbound webhooks from
external systems, translates them into messages, and sends them to channels via the bot's WebSocket
connection. The chat server has no knowledge of GitHub, CI, or any external system — it only knows
that a bot sent a message. Outbound actions (triggering a deploy from a chat command) are
implemented as adapter listeners, not server-side plumbing.

---

## Design principles

### 1. Single-tenant by design
One instance serves one team. No multi-tenant routing. This keeps the security model
straightforward (everyone on the instance is known to the admin), makes SQLite correct (one file,
one team's data), and makes the ops story simple. The family version is a different deployment of
the same binary — not a different account on a shared server.

### 2. Bots are first-class users
A bot is not a human with a special flag. It has its own identity (name, avatar, token), its own
membership in hubs and channels, and authenticates via API token rather than password. The WS
protocol has a `bot.auth` message type. No human ever logs in as a bot. The bot token is hashed
in the database the same way session tokens are — never stored in plaintext.

### 3. Public internet posture from day one
Defaults that should never require configuration:
- TLS (Bun native — no Nginx required unless the operator wants it)
- `HttpOnly` + `SameSite=Lax` cookies
- `Strict-Transport-Security` header
- `Content-Security-Policy` header
- `X-Frame-Options: DENY`
- Rate limiting on auth endpoints
- CORS policy (deny by default, configurable allow-list for webhook receivers)

### 4. The events table is the audit log
Every significant action writes an event: user joined, channel created, message deleted, bot
connected, invite redeemed. For a ChatOps deployment this is the answer to "who triggered the
deploy, from which channel, at what time" — a SQL query, not a support ticket.

### 5. Observable by default
Structured, consistent log output (timestamp, level, context) that can be piped to a log
aggregator or tailed directly. Not `console.log` strings — enough structure that a tool like
`jq` can parse it.

### 6. Separation of server and adapter concerns
The chat server does one thing: manage users, channels, and messages in real time, securely.
Integration logic (webhook routing, command parsing, external API calls) lives in the ChatOpsJS
adapter layer. Adding a new integration never requires touching the chat server.

---

## Product profiles

Rather than a fork, the ChatOps and family use cases are served by a runtime profile that adjusts
feature availability and defaults:

| | `chatops` profile (default) | `family` profile |
|---|---|---|
| Bot API + token auth | Enabled | Disabled |
| Admin role | Peer with elevated permissions | Moderator with oversight capabilities |
| Invite system | Token-based, scriptable | Simple link-based |
| Events/audit log | Prominent | Background |
| UI complexity | Full sidebar controls | Simplified |
| Webhook tooling | In scope | Out of scope |

Set via environment variable: `DEVCHITCHAT_PROFILE=family`

The family profile is a future milestone. The chatops profile is the design target for all current
development.

---

## What this ICP explicitly rules out

- **Federation / inter-instance routing** — that is a different product with different
  infrastructure requirements and a different competitive position
- **More than ~50 users per instance** — SQLite WAL handles this fine, but the product is not
  designed or marketed for large communities; someone running a 500-person Discord server is not
  the target
- **Multi-tenant SaaS hosting** — the operator runs their own instance; this product does not
  offer hosted accounts
- **Mobile-first consumer social** — the primary surface is a browser on a machine the operator
  controls; native mobile apps are not in scope for the initial target

---

## Open design questions

These need answers before the corresponding features are built:

1. **Bot permission scoping** — can a bot be restricted to specific channels, or does a bot token
   grant access to all channels the bot is a member of? What happens when a bot is invited to a
   private channel?

2. **Admin identity** — is the admin a special system account created at first run, or is it the
   first user to register? How is the admin role assigned and transferred?

3. **Webhook-in surface** — does the chat server expose any HTTP endpoints for inbound webhooks
   directly (for simple cases where a full ChatOpsJS deployment is overkill), or is the adapter
   always required?

4. **TLS configuration** — does the server handle TLS termination natively (Bun supports it), or
   does the default deployment story assume a reverse proxy? Both are valid; the documentation and
   default config should make one path obvious.

5. **Backup / restore** — SQLite is one file, but the operator needs a documented path for backup,
   point-in-time restore, and migration to a new server. This is an ops concern that shapes the
   data directory layout.
