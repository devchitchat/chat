# Secret Messaging for DMs

End-to-end encrypted, ephemeral messages in DM conversations.
Messages are encrypted client-side using WebCrypto (ECDH key exchange + AES-GCM),
relayed by the server without being read or stored, and disappear on page refresh.

---

## Goals

- **E2E encryption**: server cannot read message content
- **Ephemeral**: messages are relayed but not persisted in SQLite
- **Server-persisted mode flag**: both parties see the same mode on return
- **Clear UX**: users always know whether they are in secret mode before sending
- **Offline notice**: if the mode changes while the other party is away, they see a system message on return

## Non-goals (v1)

- Multi-device (private key is device-local in IndexedDB)
- Forward secrecy (one shared secret per pair; no Double Ratchet)
- Secret thread replies or attachments
- Search over secret messages (impossible without decryption)

---

## Threat model

Protects against:
- Server compromise (attacker reads the SQLite database)
- Passive network observer (messages encrypted in transit over WS/TLS)

Does not protect against:
- Endpoint compromise (device seized, malware on the user's machine)
- Key theft from IndexedDB (same threat surface as the app itself)
- Metadata (server still knows who messaged whom and when)

---

## Cryptography

**Key exchange:** ECDH with P-256.

Each user generates one ECDH key pair per device on first use.
The private key is stored as a non-extractable `CryptoKey` in IndexedDB.
The public key is exported as JWK and stored server-side in `user_public_keys`.

**Shared secret derivation:**
```
sharedAesKey = ECDH.deriveKey(
  { name: 'ECDH', public: recipientPublicKey },
  myPrivateKey,
  { name: 'AES-GCM', length: 256 },
  false,  // non-extractable
  ['encrypt', 'decrypt']
)
```

**Message encryption:** AES-GCM with a random 96-bit IV per message.
Ciphertext and IV are base64-encoded for WS transport.

---

## Schema changes (migration 005)

```sql
ALTER TABLE channels ADD COLUMN secret_mode INTEGER NOT NULL DEFAULT 0;

CREATE TABLE user_public_keys (
  user_id        TEXT NOT NULL PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN msg_type TEXT NOT NULL DEFAULT 'message';
```

---

## Server-side architecture

### New service: `SecretModeService`

```
setSecretMode({ channelId, requestingUserId, enabled })
  - asserts channel is DM and requestingUserId is a member
  - calls channelRepo.setDmSecretMode
  - inserts system message (msg_type='system') announcing the change
  - returns { channel_id, secret_mode, system_msg }

getPublicKey({ userId })
setPublicKey({ userId, publicKeyJwk })
```

### New WS message types

| Direction        | Type                      | Action                                         |
|------------------|---------------------------|------------------------------------------------|
| client → server  | `dm.set_secret_mode`      | toggle secret mode; server broadcasts change   |
| client → server  | `dm.secret`               | relay encrypted message; server does not store |
| client → server  | `user.public_key_set`     | store own public key                           |
| server → client  | `dm.secret_mode_changed`  | mode toggled; includes system_msg for display  |
| server → client  | `dm.secret`               | relayed encrypted message                      |
| server → client  | `dm.secret_undelivered`   | recipient was offline                          |

### New HTTP endpoints

| Method | Path                             | Auth    | Purpose                              |
|--------|----------------------------------|---------|--------------------------------------|
| GET    | `/api/users/:userId/public-key`  | session | fetch another user's public key      |
| PUT    | `/api/users/me/public-key`       | session | register own public key              |

---

## Client-side architecture

### `CryptoManager.js` (`pages/public/client/crypto/`)

```
init()                                    — load or generate key pair from IndexedDB
getPublicKeyJwk()                         — export public key as JWK
encrypt(plaintext, recipientJwk)          — returns { iv, ciphertext } (base64)
decrypt(ivBase64, ciphertextBase64, senderJwk) — returns plaintext string
```

Shared AES-GCM keys are derived on first use and cached in a Map (userId → CryptoKey).

### Key registration flow

On app boot, `CryptoManager.init()` runs. If a key pair already exists in IndexedDB it
loads it. Otherwise it generates a new one. Either way, it sends `user.public_key_set`
over WS so the server always has the current device's public key.

### Secret send flow

1. User is in a DM with secret mode on
2. User types a message and submits
3. `ChatController.#sendMessage` checks `model.currentChannelMeta.secretMode`
4. If true: `cryptoManager.encrypt(text, otherUserPublicKey)` → sends `dm.secret`
5. Server relays `dm.secret` verbatim to recipient's connections, no DB write
6. Recipient's `WebSocketController` receives `dm.secret`, decrypts, fires `dm:secret-received` on `document`
7. `MessageListView` listens and appends a secret message element (not in model cache)

### Mode toggle flow

1. User clicks "Make secret" / "Turn off secret messages" in header
2. `ChatHeaderView` dispatches `set-dm-secret-mode` on `document`
3. `ChatController` sends `dm.set_secret_mode` over WS
4. Server updates DB, inserts system message, broadcasts `dm.secret_mode_changed` to both users
5. Both clients' `WebSocketController` receives event → `model.setSecretMode(channelId, enabled)`
6. `ChatHeaderView` and `ComposerView` react to `SECRET_MODE_CHANGED`
7. When mode turns on: client fetches other user's public key (GET endpoint) and caches it

---

## UX specifics

### Channel list (sidebar)

DMs in secret mode show a lock prefix `🔒` before the name.

### DM header

When secret mode is on, a banner below the header:
```
🔒 Secret messages · ephemeral
Messages are end-to-end encrypted and not saved.   [Turn off]
```
When off, the banner is hidden. "Make secret" toggle is in the DM header actions.

### Composer

When secret mode is on, the composer gets:
- `--border-secret` color accent
- Lock icon prefix in placeholder text: `🔒 Encrypted message — not saved`

### Secret message rendering

Secret messages in the message list are rendered as:
```
🔒 [display name]  [time]
[plaintext]
(ephemeral — not saved)
```
Styled with slightly muted background and lock icon. Gone on page refresh.

### System messages

System messages (`msg_type='system'`) are rendered as centered muted text:
```
  ─────  Alice turned on secret messages  ─────
```
These ARE stored in SQLite and persist across refreshes.

### "Mode changed while away" notice

The system message is stored server-side, so the offline party sees it
when they open the DM after returning. The system message appears in the
normal message timeline at its chronological position.
