export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                   INTEGER NOT NULL,
      actor_id             TEXT    NOT NULL,
      actor_display_name   TEXT,
      channel_id           TEXT    NOT NULL,
      channel_name         TEXT,
      channel_kind         TEXT,
      session_id           TEXT,
      repo                 TEXT,
      input_tokens         INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd             REAL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_ts       ON token_usage(ts);
    CREATE INDEX IF NOT EXISTS idx_token_usage_actor    ON token_usage(actor_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_channel  ON token_usage(channel_id);
    CREATE INDEX IF NOT EXISTS idx_token_usage_repo     ON token_usage(repo);
  `)
}
