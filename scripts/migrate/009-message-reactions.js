export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      reaction_id  TEXT    PRIMARY KEY,
      msg_id       TEXT    NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
      channel_id   TEXT    NOT NULL,
      user_id      TEXT    NOT NULL,
      emoji        TEXT    NOT NULL,
      ts           INTEGER NOT NULL,
      UNIQUE (msg_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions (msg_id);
    CREATE INDEX IF NOT EXISTS idx_reactions_channel ON message_reactions (channel_id);
  `)
}
