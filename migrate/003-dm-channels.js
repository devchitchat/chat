/**
 * Make channels.hub_id nullable so DM channels (kind = 'dm') can exist
 * without a hub. SQLite does not support ALTER COLUMN, so we recreate the table.
 *
 * Each statement is a separate db.exec() call — bun:sqlite does not reliably
 * execute all statements in a single multi-statement exec() inside a transaction.
 */
export function run(db) {
  db.exec(`
    CREATE TABLE channels_new (
      channel_id         TEXT PRIMARY KEY,
      hub_id             TEXT,
      kind               TEXT NOT NULL,
      name               TEXT NOT NULL,
      topic              TEXT,
      visibility         TEXT NOT NULL,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      deleted_at         INTEGER,
      FOREIGN KEY(created_by_user_id) REFERENCES users(user_id)
    )
  `)

  db.exec(`
    INSERT INTO channels_new
      SELECT channel_id, hub_id, kind, name, topic, visibility,
             sort_order, created_by_user_id, created_at, deleted_at
      FROM channels
  `)

  db.exec(`DROP TABLE channels`)

  db.exec(`ALTER TABLE channels_new RENAME TO channels`)
}
