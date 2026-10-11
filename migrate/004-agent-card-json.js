/**
 * Add card_json column to messages for agent card responses.
 * NULL for regular messages; a JSON object for agent cards.
 */
export function run(db) {
  db.exec(`ALTER TABLE messages ADD COLUMN card_json TEXT`)
}
