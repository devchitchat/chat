export function run(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages (channel_id, seq)`)
}
