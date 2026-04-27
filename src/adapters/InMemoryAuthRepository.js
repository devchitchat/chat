export class InMemoryAuthRepository {
  constructor() {
    this._users = new Map()     // userId → user record (with password_hash, roles_json)
    this._sessions = new Map()  // sessionId → session record
    this._invites = new Map()   // tokenHash → invite record
  }

  // ── Invites ────────────────────────────────────────────────────────────────

  insertInvite({ inviteId, tokenHash, createdByUserId, now, expiresAt, maxUses, note }) {
    this._invites.set(tokenHash, { invite_id: inviteId, token_hash: tokenHash, created_by_user_id: createdByUserId, created_at: now, expires_at: expiresAt, max_uses: maxUses, uses: 0, note, redeemed_by_user_id: null })
  }

  findInviteByTokenHash({ tokenHash }) {
    return this._invites.get(tokenHash) ?? null
  }

  registerUser({ inviteId, userId, handle, displayName, rolesJson, passwordHash, now, sessionId, sessionTokenHash, sessionExpiresAt }) {
    this._users.set(userId, { user_id: userId, handle, display_name: displayName, roles_json: rolesJson, password_hash: passwordHash, created_at: now })
    for (const invite of this._invites.values()) {
      if (invite.invite_id === inviteId) { invite.uses += 1; invite.redeemed_by_user_id = userId; break }
    }
    this._sessions.set(sessionId, { session_id: sessionId, user_id: userId, token_hash: sessionTokenHash, created_at: now, expires_at: sessionExpiresAt, last_seen_at: now, revoked_at: null })
  }

  registerBootstrapUser({ userId, handle, displayName, rolesJson, passwordHash, now, sessionId, sessionTokenHash, sessionExpiresAt }) {
    this._users.set(userId, { user_id: userId, handle, display_name: displayName, roles_json: rolesJson, password_hash: passwordHash, created_at: now })
    this._sessions.set(sessionId, { session_id: sessionId, user_id: userId, token_hash: sessionTokenHash, created_at: now, expires_at: sessionExpiresAt, last_seen_at: now, revoked_at: null })
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  findUserByHandle({ handle }) {
    return [...this._users.values()].find(u => u.handle === handle) ?? null
  }

  findUserById({ userId }) {
    const u = this._users.get(userId)
    if (!u) return null
    return { user_id: u.user_id, handle: u.handle, display_name: u.display_name, roles_json: u.roles_json }
  }

  getUserCount() {
    return this._users.size
  }

  isHandleTaken({ handle }) {
    return [...this._users.values()].some(u => u.handle === handle)
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  insertSession({ sessionId, userId, tokenHash, now, expiresAt }) {
    this._sessions.set(sessionId, { session_id: sessionId, user_id: userId, token_hash: tokenHash, created_at: now, expires_at: expiresAt, last_seen_at: now, revoked_at: null })
  }

  findSessionWithUser({ tokenHash }) {
    const session = [...this._sessions.values()].find(s => s.token_hash === tokenHash)
    if (!session) return null
    const user = this._users.get(session.user_id)
    if (!user) return null
    return { session_id: session.session_id, user_id: user.user_id, expires_at: session.expires_at, revoked_at: session.revoked_at, handle: user.handle, display_name: user.display_name, roles_json: user.roles_json }
  }

  touchSession({ sessionId, now }) {
    const s = this._sessions.get(sessionId)
    if (s) s.last_seen_at = now
  }

  revokeSession({ sessionId, now }) {
    const s = this._sessions.get(sessionId)
    if (s) s.revoked_at = now
  }
}
