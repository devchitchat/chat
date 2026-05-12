export function run(db) {
  db.exec(`
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
    )
  `)

  try {
    db.exec(`ALTER TABLE messages ADD COLUMN attachments_json TEXT`)
  } catch {
    // column already exists — idempotent
  }
}
