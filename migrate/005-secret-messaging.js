/**
 * Migration 005 — secret messaging support
 *
 * Changes:
 *   1. channels.secret_mode — flag for E2E-encrypted DM mode (default off)
 *   2. user_public_keys     — stores each user's ECDH P-256 public key (JWK)
 *   3. messages.msg_type    — distinguishes regular messages from system notices
 */
export function run(db) {
  // 1. Secret mode flag on DM channels
  try {
    db.exec(`ALTER TABLE channels ADD COLUMN secret_mode INTEGER NOT NULL DEFAULT 0`)
  } catch { /* already exists */ }

  // 2. Per-user ECDH public key storage
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_public_keys (
      user_id        TEXT    NOT NULL PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      public_key_jwk TEXT    NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `)

  // 3. Message type column — 'message' (default) or 'system'
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN msg_type TEXT NOT NULL DEFAULT 'message'`)
  } catch { /* already exists */ }
}
