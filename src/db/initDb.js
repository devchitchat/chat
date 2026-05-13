export const initDb = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      password_hash TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_seen_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      invite_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      max_uses INTEGER NOT NULL,
      uses INTEGER NOT NULL,
      redeemed_by_user_id TEXT,
      note TEXT,
      FOREIGN KEY(created_by_user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS hubs (
      hub_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      visibility TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      FOREIGN KEY(created_by_user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS hub_members (
      hub_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      PRIMARY KEY (hub_id, user_id),
      FOREIGN KEY(hub_id) REFERENCES hubs(hub_id),
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      hub_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      topic TEXT,
      visibility TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      FOREIGN KEY(created_by_user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      banned_at INTEGER,
      PRIMARY KEY (channel_id, user_id),
      FOREIGN KEY(channel_id) REFERENCES channels(channel_id),
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor_user_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      type TEXT NOT NULL,
      body_json TEXT NOT NULL,
      trace TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      text TEXT NOT NULL,
      client_msg_id TEXT,
      deleted_at INTEGER,
      priority TEXT NOT NULL DEFAULT 'normal',
      attachments_json TEXT,
      FOREIGN KEY(channel_id) REFERENCES channels(channel_id),
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS uploads (
      upload_id        TEXT    PRIMARY KEY,
      uploader_user_id TEXT    NOT NULL REFERENCES users(user_id),
      channel_id       TEXT    NOT NULL REFERENCES channels(channel_id),
      msg_id           TEXT    REFERENCES messages(msg_id),
      original_name    TEXT    NOT NULL,
      stored_name      TEXT    NOT NULL,
      mime_type        TEXT    NOT NULL,
      size_bytes       INTEGER NOT NULL,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      after_seq INTEGER NOT NULL,
      last_delivered_at INTEGER,
      status TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(user_id),
      FOREIGN KEY(channel_id) REFERENCES channels(channel_id)
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id      TEXT    NOT NULL PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      settings_json TEXT   NOT NULL DEFAULT '{}',
      updated_at   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS calls (
      call_id            TEXT    NOT NULL PRIMARY KEY,
      channel_id         TEXT    NOT NULL REFERENCES channels(channel_id),
      created_by_user_id TEXT    NOT NULL REFERENCES users(user_id),
      topology           TEXT    NOT NULL DEFAULT 'mesh',
      started_at         INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at           INTEGER
    );

    CREATE TABLE IF NOT EXISTS call_participants (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id   TEXT    NOT NULL REFERENCES calls(call_id),
      user_id   TEXT    NOT NULL REFERENCES users(user_id),
      peer_id   TEXT    NOT NULL,
      joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
      left_at   INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_calls_channel_active
      ON calls (channel_id) WHERE ended_at IS NULL;
  `)

  // Close any calls left open by a previous crash or unclean shutdown.
  // Live call state is in-memory; on restart there are no active peers.
  db.exec(`UPDATE calls SET ended_at = unixepoch() WHERE ended_at IS NULL`)

  // Add sort_order to existing databases that pre-date this column
  try { db.exec(`ALTER TABLE channels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`) } catch { /* already exists */ }
  // Add priority + attachments_json to existing messages tables
  try { db.exec(`ALTER TABLE messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`) } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN attachments_json TEXT`) } catch { /* already exists */ }

  // Bot tokens — added after initial schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_tokens (
      token_id     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER,
      last_used_at INTEGER,
      revoked_at   INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(user_id)
    );
  `)
  // Add expires_at to existing bot_tokens tables that predate this column
  try { db.exec('ALTER TABLE bot_tokens ADD COLUMN expires_at INTEGER') } catch { /* already exists */ }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
        text,
        channel_id UNINDEXED,
        msg_id UNINDEXED,
        seq UNINDEXED,
        user_id UNINDEXED,
        ts UNINDEXED
      );
    `)
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fts_messages (
        text TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
    `)
  }
}
