export function run(db) {
  db.exec(`
    ALTER TABLE messages ADD COLUMN parent_msg_id TEXT REFERENCES messages(msg_id);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_msg_id) WHERE parent_msg_id IS NOT NULL;
  `)
}
