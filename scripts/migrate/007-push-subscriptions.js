export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      sub_id       TEXT    PRIMARY KEY,
      user_id      TEXT    NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      endpoint     TEXT    NOT NULL UNIQUE,
      p256dh       TEXT    NOT NULL,
      auth         TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions (user_id);
  `)
}
