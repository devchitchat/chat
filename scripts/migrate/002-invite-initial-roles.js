export function run(db) {
  db.exec(`ALTER TABLE invites ADD COLUMN initial_roles_json TEXT NOT NULL DEFAULT '["user"]'`)
}
