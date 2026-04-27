# Architecture Decision Records

Decisions made about how the system is built and why. Each record captures the context, the options considered, the decision, and the consequences. Records are append-only — when a decision is revisited, a new record supersedes the old one rather than replacing it.

---

## ADR-001 — Bot permission scoping

**Date:** 2026-04-24
**Status:** Decided

### Context

Bots (automated clients, the ChatOpsJS adapter) need to authenticate and interact with channels.

The question is whether a bot token should encode channel permissions directly, or whether the existing user membership model should govern what a bot can access.

### Options considered

**A. Token-scoped permissions** — the bot token is created with an explicit list of channel IDs it may read/write. Revoking access to a channel requires rotating or replacing the token.

**B. Membership model** — the token authenticates a bot identity; channel access is governed by the same membership records used for human users. Access is granted and revoked by modifying membership, not the token.

### Decision

**Option B — membership model.**

A bot is added to channels the same way a human user is: explicitly, by a channel owner or admin.

The token authenticates the bot's identity only. Membership determines what it can see and post in.

For private channels, a bot must be explicitly invited — same rule as humans. Revoking a bot's access to a channel is removing its membership record, not rotating a token.

### Consequences

- The permission model stays unified — one system governs both human and bot access
- The `bots` / `bot_tokens` table authenticates identity; `channel_members` governs access
- A bot posting to a channel it is not a member of is rejected — same rule as humans
- The ChatOpsJS adapter must ensure the bot is a member of any channel it intends to write to before attempting to post
- No second permission system to maintain alongside membership

---

## ADR-002 — Admin identity and first-run bootstrap

**Date:** 2026-04-24
**Status:** Decided

### Context

Every instance needs at least one admin user. The question is how the first admin account is created and what "admin" means structurally.

### Options considered

**A. Hardcoded root account** — a special `root` or `admin` user with a password set via environment variable at first run.

**B. First user to register gets admin** — implicit promotion; whoever redeems the first invite becomes admin.

**C. Bootstrap invite token** — on first start with no users, the server generates a one-time admin invite token, prints it to stdout, and waits. Whoever redeems it gets the admin role.

After that, admin is just a role in the `roles` array on any user.

### Decision

**Option C — bootstrap invite token.**

On first start, the server checks whether any users exist. If none do, it generates a one-time invite token (using the existing `randomToken()` / `hashToken()` infrastructure), prints it to stdout and the structured log, and proceeds normally. 

Redeeming that token during registration grants the `admin` role automatically.

```
[boot] No users found.
[boot] Bootstrap admin invite: https://chat.example.com/register?token=<token>
[boot] Expires in 24 hours. Single use.
```

After first-run, admin is a value in the `roles_json` array on the `users` table. An admin can grant or revoke the admin role on any other user. There is no privileged account that bypasses normal auth.

### Consequences

- The bootstrap path is explicit and auditable — the event is written to the `events` table
- No environment variables required to set an initial password
- Admin grant/revoke is a normal operation visible in the audit log
- If the bootstrap token expires before use, the operator restarts the server (token regenerates) or uses a CLI command: `bun run create-admin-invite`
- The invite system already exists and is used for all other onboarding — this reuses it rather than introducing a parallel path

---

## ADR-003 — Webhook-in surface

**Date:** 2026-04-24
**Status:** Decided

### Context

A core ChatOps use case is receiving events from external systems (CI, monitoring, version control) and posting them to a channel. The ChatOpsJS adapter handles complex cases (filtering, logic, outbound responses). The question is whether the chat server should also expose a simple webhook-in endpoint for cases that don't need a full adapter deployment.

### Options considered

**A. Adapter only** — all inbound webhooks go through the ChatOpsJS adapter. The server has no webhook-specific endpoints.

**B. Server-side webhook receiver** — the server exposes `POST /webhooks/:token`, stores webhook configuration in the database, and pipes received payloads into a channel as messages. No logic, no parsing — just delivery.

**C. Both** — server-side endpoint for simple delivery; adapter for anything requiring logic.

### Decision

**Option C — both surfaces, with a clean contract between them.**

The server exposes a lightweight webhook receiver:

```
POST /webhooks/:token
```

A webhook record in the database (`webhook_id`, `token_hash`, `channel_id`, `name`,
`created_by_user_id`, `created_at`) maps the token to a target channel. The server receives the POST, formats the body as a message attributed to the webhook's configured name, and posts it to the channel. No parsing, no conditional logic — raw delivery only.

The ChatOpsJS adapter remains the correct path for anything requiring logic: filtering by event type, parsing structured payloads, triggering outbound calls, responding to commands.

Webhook tokens are generated and stored using the same `randomToken()` / `hashToken()` pattern used for session tokens and invites. The raw token is shown once at creation and never stored — only the hash lives in the database. Webhook configurations can be created (requested) by regular members, but must be approved by an Admin before becoming active and useable.

### Consequences

- Simple integrations (Grafana alert → `#ops`, deployment notification → `#deployments`) require no adapter deployment — a single `curl` to create the webhook and point the external system at the URL is sufficient
- The adapter integration surface is unaffected — it uses bot token auth over WebSocket
- Two distinct authentication surfaces: webhook tokens (per-webhook, HMAC-verifiable) and bot tokens (per-bot-identity, WS session)
- Webhook payloads are stored as messages attributed to the webhook name — no separate storage model required
- A new `webhooks` table is required in the schema
- An approval UI and notification must be built for the Admin to review, approve, reject, revoke webhook configurations

---

## ADR-004 — TLS configuration

**Date:** 2026-04-24
**Status:** Decided

### Context

The application is designed to be exposed to the public internet. TLS is required. The question is whether TLS termination happens inside the Bun process natively or in a reverse proxy in front of it.

### Options considered

**A. Native Bun TLS** — `Bun.serve({ tls: { cert, key } })` handles TLS directly. No Nginx or Caddy required.

**B. Reverse proxy only** — the server always runs HTTP internally; TLS is the operator's responsibility via Nginx, Caddy, or a load balancer.

**C. Native TLS as default, reverse proxy documented as an alternative.**

### Decision

**Option C — native Bun TLS as the default.**

The server reads `TLS_CERT` and `TLS_KEY` environment variables pointing at certificate and key files. The `certs/` directory in the repository root is the conventional location.

```
certs/
  cert.pem     ← certificate (from Let's Encrypt / Certbot, or self-signed for LAN use)
  key.pem      ← private key
```

If neither variable is set, the server starts in HTTP mode with a visible warning in the log.

HTTP mode is acceptable for local development; it is not acceptable for a public-internet deployment and the warning says so explicitly.

The server handles a `SIGHUP` signal to reload TLS credentials without a full restart, supporting certificate renewal via Certbot / acme.sh hooks.

The reverse proxy path (Nginx, Caddy) is documented as an alternative for operators who have one already. Caddy is the recommended option for operators who want automated certificate renewal with minimal configuration.

### Consequences

- No Nginx required to get a working, secure production deployment — fewer moving parts
- The `certs/` directory already exists in the repository, consistent with this decision
- The operator is responsible for certificate provisioning and renewal; the server provides the reload mechanism
- Operators running behind a load balancer or existing reverse proxy can set `TRUST_PROXY=1` to read `X-Forwarded-For` headers correctly and disable the native TLS requirement
- Self-signed certificates are supported for LAN / family deployments where a public domain is not available

---

## ADR-005 — Backup and restore

**Date:** 2026-04-24
**Status:** Decided

### Context

SQLite in WAL mode maintains three files (`chat.db`, `chat.db-wal`, `chat.db-shm`). Naive file copying while the server is running produces inconsistent snapshots. The question is what the supported backup and restore procedure is.

### Options considered

**A. Document manual `sqlite3 .backup` command** — requires the `sqlite3` CLI binary; operator runs it manually or from a cron script.

**B. `bun run backup` script using `VACUUM INTO`** — uses SQLite's built-in online backup mechanism via Bun's native SQLite bindings; no external binary required; produces a compacted, WAL-checkpointed snapshot atomically.

**C. Built-in `/admin/backup` HTTP endpoint** — streams the database file over HTTP; convenient but exposes a sensitive endpoint and adds server-side complexity.

### Decision

**Option B — `bun run backup` using `VACUUM INTO`.**

`VACUUM INTO` writes a compacted, consistent copy of the live database to a destination path atomically. It works while the server is running, requires no external binary, and the output file is a clean single-file SQLite database (no WAL files needed alongside it).

```
bun run backup
# writes: data/backups/chat-2026-04-24T02-00-00Z.db
```

**Data directory layout:**

```
data/
  chat.db            ← live database
  chat.db-wal        ← WAL segment (managed by SQLite)
  chat.db-shm        ← shared memory file (managed by SQLite)
  backups/
    chat-2026-04-24T02-00-00Z.db
    chat-2026-04-23T02-00-00Z.db
    ...
```

**Restore procedure** (documented in the README):

```bash
bun run restore --from=data/backups/chat-2026-04-24T02-00-00Z.db
```

The restore script stops the server process, replaces `data/chat.db` with the backup file, removes `data/chat.db-wal` and `data/chat.db-shm` if present, and restarts the server.

Scheduled backups are the operator's responsibility — a cron entry calling `bun run backup` and optionally shipping the output file to remote storage (S3, Backblaze, rsync). The server does not implement backup scheduling or remote shipping; these vary too much per operator and are trivially handled in a one-line cron script.

### Consequences

- No dependency on the `sqlite3` CLI binary — Bun's native SQLite bindings are sufficient
- Backup files are clean, self-contained SQLite databases — portable, inspectable with any SQLite tool
- Retention policy (how many backups to keep) is left to the operator's cron script
- The `scripts/` directory in the repository contains `backup.js` and `restore.js`
- Point-in-time recovery is limited to the granularity of backup frequency — this is acceptable for the target deployment scale; operators who need finer granularity can enable SQLite's WAL archiving separately
