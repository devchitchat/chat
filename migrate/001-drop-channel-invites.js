export function run(db) {
  db.exec(`DROP TABLE IF EXISTS channel_invites`)
}
