# File Uploads

## Goal

Allow users to attach files to messages. Files are stored on the local filesystem under
`data/uploads/`. Access is controlled by channel membership — if you cannot read the channel,
you cannot fetch the file.

---

## Design principles

1. **Files inherit channel access.** No separate file permission system.
2. **Local filesystem via a port.** The service layer calls `IFileStore`; the default adapter
   writes to `data/uploads/`. An S3 adapter can be added later without touching service code.
3. **Backup stays simple.** `data/` is one directory — copying it captures both `chat.db` and
   all uploads.
4. **Validate content, not claims.** MIME type is checked against file magic bytes, not the
   client's `Content-Type` header.
5. **Dangerous types are forced to download.** Executable MIME types are served with
   `Content-Disposition: attachment` regardless of browser preference.

---

## Port: `IFileStore`

```js
// Implemented by LocalFileStore (default) and future S3FileStore
interface IFileStore {
  write({ uploadId, storedName, stream })  → Promise<void>
  read({ uploadId, storedName })           → Promise<ReadableStream>
  delete({ uploadId, storedName })         → Promise<void>
}
```

`LocalFileStore` writes to `data/uploads/{uploadId}/{storedName}`.
`storedName` is a random opaque string — never derived from the original filename.

---

## Schema (migration)

```sql
CREATE TABLE uploads (
  upload_id        TEXT    PRIMARY KEY,
  uploader_user_id TEXT    NOT NULL REFERENCES users(user_id),
  channel_id       TEXT    NOT NULL REFERENCES channels(channel_id),
  msg_id           TEXT    REFERENCES messages(msg_id),  -- NULL until the message is sent
  original_name    TEXT    NOT NULL,
  stored_name      TEXT    NOT NULL,
  mime_type        TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

ALTER TABLE messages ADD COLUMN attachments_json TEXT;
-- null when no attachments; otherwise a JSON array:
-- [{ upload_id, url, filename, mime_type, size_bytes }]
```

---

## Upload flow

```
1. Client selects file(s) in the composer
2. Client POSTs multipart/form-data to POST /api/uploads
   Fields: file (binary), channel_id
3. Server:
   a. Validates session → userId
   b. Validates channel_id: user must be a member
   c. Validates size ≤ MAX_UPLOAD_BYTES (env var, default 25 MB)
   d. Reads magic bytes → validates MIME type against allowlist
   e. Generates upload_id (newId('up')) and storedName (randomToken())
   f. Calls fileStore.write(...)
   g. INSERTs into uploads table (msg_id = NULL)
   h. Returns { upload_id, url, filename, mime_type, size_bytes }
4. Client stores the returned upload_id(s) locally
5. Client sends msg.send with body.attachments = [{ upload_id, ... }]
6. MessageService.sendMessage:
   a. Validates each upload_id belongs to the channel and was uploaded by this user
   b. Sets msg_id on each upload row
   c. Stores attachments_json on the message row
7. message.event broadcast includes attachments array
```

Uploads that are never linked to a message (step 6 never happens) are orphans. A periodic
cleanup job (or admin CLI command) can delete orphans older than 24h.

---

## Download flow

```
GET /uploads/:uploadId/:filename
  ↓ validate session (reject if not authenticated)
  ↓ look up upload row by upload_id
  ↓ check canAccessChannel(upload.channel_id, userId, roles)
  ↓ if MIME type is executable → Content-Disposition: attachment
  ↓ stream file from fileStore.read(...)
```

`:filename` in the URL is cosmetic (for browser "save as" UX) — the actual file is located by
`upload_id` and `stored_name`. Path traversal is impossible because `stored_name` is opaque
and looked up from the database, never interpolated from the URL.

---

## MIME type handling

### Allowlist approach

Rather than blocking specific types, validate that the magic bytes match a known safe category.
Reject anything that cannot be identified.

Allowed categories (not exhaustive — extend as needed):
- Images: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/svg+xml`
- Documents: `application/pdf`, `text/plain`, `text/markdown`
- Archives: `application/zip`, `application/gzip`
- Data: `application/json`, `text/csv`
- Audio: `audio/mpeg`, `audio/ogg`, `audio/wav`
- Video: `video/mp4`, `video/webm`
- Code / text: served as `text/plain` regardless of extension

### Forced download types

Any MIME type that can execute in a browser or OS is served with `Content-Disposition: attachment`:
`application/javascript`, `application/x-sh`, `application/octet-stream`,
`application/x-executable`, `application/x-msdownload`, and anything not in the allowlist
that is let through by configuration.

---

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `26214400` (25 MB) | Maximum file size per upload |
| `UPLOAD_DIR` | `data/uploads` | Root directory for `LocalFileStore` |

---

## Service: `UploadService`

```js
class UploadService {
  constructor({ uploadRepo, fileStore, channelService, nowFn })

  async upload({ userId, channelId, userRoles, filename, stream, sizeBytes, mimeType })
  // → validates access, writes file, inserts row
  // → returns { upload_id, url, original_name, mime_type, size_bytes }

  linkToMessage({ uploadIds, msgId, userId })
  // → validates ownership, sets msg_id on each upload row

  getUpload({ uploadId })
  // → returns upload row or null

  async streamFile({ uploadId, requestingUserId, userRoles })
  // → validates access, returns { stream, mimeType, originalName, contentDisposition }

  deleteOrphans({ olderThanMs })
  // → deletes uploads where msg_id IS NULL AND created_at < threshold
  // → calls fileStore.delete for each
}
```

---

## Drag-and-drop gestures

Two entry points trigger the upload flow without a file picker dialog.

### 1. Drop onto the composer textarea (attach to current message)

- User drags a file over the `<textarea>` in `chat.js`
- `dragover` on the textarea (or its wrapper) shows a drop overlay ("Drop to attach")
- On `drop`: extract `event.dataTransfer.files`, run the same upload flow as the file picker
- Uploaded files are queued as pending attachments in the composer, shown as chips above the
  textarea (filename + remove button)
- Sending the message links them via `msg.send` with `attachments`

### 2. Drop onto a channel name in the sidebar (send to another channel)

- User drags a file over a `.channel-link` in `sidebar.js`
- After a short hover delay (~600 ms) the channel highlights to confirm the target
- On `drop`: upload the file to that channel (`channel_id` from `link.dataset.channelId`)
- After a successful upload, immediately send a message to that channel via the WS
  `msg.send` handler with `attachments` — no navigation required
- A toast/brief flash on the channel row confirms the send ("Sent to #design")

#### Auth requirement for sidebar drop

The sidebar drop sends to a channel the user may not currently be viewing. The upload POST
already accepts any `channel_id` the user is a member of, so no new server endpoint is needed.
The WS `msg.send` works for any channel the user has joined — the sidebar drop just needs to
call `channel.join` first if the delivery cursor doesn't exist yet (same as navigating to a
channel normally).

#### Text fallback

If the user drops a file that is not in the MIME allowlist, show an inline error chip in the
composer ("File type not supported") rather than silently failing.

---

## What NOT to build in this iteration

- Image thumbnail / preview generation (native dependency, ops complexity)
- Inline video or audio player (progressively add to the client later)
- Streaming/chunked upload (single POST is sufficient for 25 MB)
- S3 / object storage adapter (port is ready; implement when requested)
- Per-channel upload permissions (channel access already governs it)
- Virus scanning (out of scope for self-hosted small-team tool)

---

## Current state

| Thing | State |
|---|---|
| `IFileStore` port | Built (`src/ports/IFileStore.js`) |
| `LocalFileStore` adapter | Built (`src/adapters/LocalFileStore.js`) |
| `InMemoryFileStore` adapter | Built (`src/adapters/InMemoryFileStore.js`) |
| `SqliteUploadRepository` | Built (`src/adapters/SqliteUploadRepository.js`) |
| `InMemoryUploadRepository` | Built (`src/adapters/InMemoryUploadRepository.js`) |
| `uploads` table | Built (migration `005-uploads.js` + `initDb.js`) |
| `messages.attachments_json` | Built (migration `005-uploads.js` + `initDb.js`) |
| `UploadService` | Built (`src/services/UploadService.js`) |
| `POST /api/uploads` handler | Built (`pages/api/uploads/index.js`) |
| `GET /uploads/:id/:filename` handler | Built (`pages/uploads/[uploadId]/[filename].js`) |
| Composer file picker + drag-drop textarea | Built (`call.js`) |
| Drag file onto channel name in sidebar | Built (`sidebar.js`) |
| Attachment rendering in chat (images + files) | Built (`call.js`) |

---

## Build sequence

1. **Migration** — `uploads` table, `attachments_json` on `messages`
2. **Port** — document `IFileStore` interface in `src/ports/IFileStore.js` (JSDoc, no runtime)
3. **Adapter** — `LocalFileStore` in `src/adapters/LocalFileStore.js`; `InMemoryFileStore` for
   tests (stores buffers in a Map)
4. **Core** — `validateMimeType(magicBytes)` → allowed MIME or throws; `isForcedDownload(mime)`
   in `src/core/uploads.js`
5. **Test** — `UploadService.upload` with `InMemoryFileStore` and `InMemoryUploadRepository`
6. **Service** — `UploadService` with all methods above
7. **Adapter** — `SqliteUploadRepository`, `InMemoryUploadRepository`
8. **Transport** — `POST /api/uploads` multipart handler in `pages/api/uploads/index.js`
9. **Transport** — `GET /uploads/[uploadId]/[filename].js` streaming handler
10. **Service** — wire `linkToMessage` call into `MessageService.sendMessage`
11. **Client** — file picker in composer (`chat.js`); attachment rendering in message list

---

## Key files to create or modify

| File | Change |
|---|---|
| `scripts/migrate/NNN-uploads.js` | `uploads` table, `attachments_json` on `messages` |
| `src/ports/IFileStore.js` | Interface documentation |
| `src/adapters/LocalFileStore.js` | Writes/reads from `data/uploads/` |
| `src/adapters/InMemoryFileStore.js` | In-memory adapter for tests |
| `src/adapters/SqliteUploadRepository.js` | New |
| `src/adapters/InMemoryUploadRepository.js` | New, for tests |
| `src/core/uploads.js` | `validateMimeType`, `isForcedDownload` pure functions |
| `src/services/UploadService.js` | New |
| `src/services/MessageService.js` | Call `linkToMessage` in `sendMessage` |
| `src/context.js` | Wire `LocalFileStore`, `UploadService` |
| `pages/api/uploads/index.js` | New — multipart POST handler |
| `pages/uploads/[uploadId]/[filename].js` | New — authenticated file streaming handler |
| `pages/public/client/islands/chat.js` | File picker in composer, attachment rendering |
