export class SqlitePublicKeyRepository {
  constructor({ db }) {
    this.db = db
  }

  getByUserId({ userId }) {
    return this.db.prepare(
      `SELECT user_id, public_key_jwk, created_at, updated_at FROM user_public_keys WHERE user_id = ?`
    ).get(userId) ?? null
  }

  upsert({ userId, publicKeyJwk, now }) {
    this.db.prepare(
      `INSERT INTO user_public_keys (user_id, public_key_jwk, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET public_key_jwk = excluded.public_key_jwk, updated_at = excluded.updated_at`
    ).run(userId, publicKeyJwk, now, now)
  }
}
