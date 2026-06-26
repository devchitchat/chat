export function run(db) {
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN edited_at INTEGER`)
  } catch (e) {
    if (!e.message.includes('duplicate column name')) throw e
  }
}
