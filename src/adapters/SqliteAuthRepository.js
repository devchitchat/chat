import { runTransaction } from '../db/transaction.js'

export class SqliteAuthRepository {
  constructor({ db }) {
    this.db = db
  }

  // ── Invites ────────────────────────────────────────────────────────────────

  insertInvite({ inviteId, tokenHash, createdByUserId, now, expiresAt, maxUses, note }) {
    this.db.prepare(
      `INSERT INTO invites (invite_id, token_hash, created_by_user_id, created_at, expires_at, max_uses, uses, note)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(inviteId, tokenHash, createdByUserId, now, expiresAt, maxUses, note)
  }

  findInviteByTokenHash({ tokenHash }) {
    return this.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash) ?? null
  }

  /** Atomically: increment invite uses + insert user + insert session */
  registerUser({ inviteId, userId, handle, displayName, rolesJson, passwordHash, now, sessionId, sessionTokenHash, sessionExpiresAt }) {
    runTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO users (user_id, handle, display_name, roles_json, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(userId, handle, displayName, rolesJson, passwordHash, now)
      this.db.prepare(
        `UPDATE invites SET uses = uses + 1, redeemed_by_user_id = ? WHERE invite_id = ?`
      ).run(userId, inviteId)
      this.db.prepare(
        `INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(sessionId, userId, sessionTokenHash, now, sessionExpiresAt, now)
    })
  }

  /** Atomically: insert user + insert session (bootstrap — no invite to redeem) */
  registerBootstrapUser({ userId, handle, displayName, rolesJson, passwordHash, now, sessionId, sessionTokenHash, sessionExpiresAt }) {
    runTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO users (user_id, handle, display_name, roles_json, password_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(userId, handle, displayName, rolesJson, passwordHash, now)
      this.db.prepare(
        `INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(sessionId, userId, sessionTokenHash, now, sessionExpiresAt, now)
    })
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  findUserByHandle({ handle }) {
    return this.db.prepare(
      'SELECT user_id, handle, display_name, roles_json, password_hash FROM users WHERE handle = ?'
    ).get(handle) ?? null
  }

  findUserById({ userId }) {
    return this.db.prepare(
      'SELECT user_id, handle, display_name, roles_json FROM users WHERE user_id = ?'
    ).get(userId) ?? null
  }

  getUserCount() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0
  }

  isHandleTaken({ handle }) {
    return !!this.db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  insertSession({ sessionId, userId, tokenHash, now, expiresAt }) {
    this.db.prepare(
      `INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sessionId, userId, tokenHash, now, expiresAt, now)
  }

  findSessionWithUser({ tokenHash }) {
    return this.db.prepare(
      `SELECT s.session_id, s.user_id, s.expires_at, s.revoked_at, u.handle, u.display_name, u.roles_json
       FROM sessions s JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = ?`
    ).get(tokenHash) ?? null
  }

  touchSession({ sessionId, now }) {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?').run(now, sessionId)
  }

  revokeSession({ sessionId, now }) {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE session_id = ?').run(now, sessionId)
  }
}
