export function run(db) {
  try {
    db.exec(`ALTER TABLE invites ADD COLUMN initial_roles_json TEXT NOT NULL DEFAULT '["user"]'`)
  } catch { /* column already exists — initDb creates it on fresh installs */ }
}
