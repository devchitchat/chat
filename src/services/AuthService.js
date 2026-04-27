import { newId } from '../util/ids.js'
import { randomToken, hashToken, hashPassword, verifyPassword } from '../util/crypto.js'
import { ServiceError } from '../util/errors.js'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export class AuthService {
  constructor({ authRepo, nowFn = () => Date.now(), sessionTtlMs = DEFAULT_SESSION_TTL_MS, bootstrapToken = null }) {
    this.authRepo = authRepo
    this.nowFn = nowFn
    this.sessionTtlMs = sessionTtlMs
    this.bootstrapToken = bootstrapToken
  }

  createInvite({ createdByUserId, ttlMs = DEFAULT_TTL_MS, maxUses = 1, note = null }) {
    this.requireAdmin(createdByUserId)
    const inviteToken = randomToken()
    const inviteId = newId('invite')
    const now = this.nowFn()
    const expiresAt = now + ttlMs

    this.authRepo.insertInvite({ inviteId, tokenHash: hashToken(inviteToken), createdByUserId, now, expiresAt, maxUses, note })

    return { inviteToken, inviteId, expiresAt, maxUses }
  }

  async redeemInvite({ inviteToken, profile, password }) {
    const invite = this.authRepo.findInviteByTokenHash({ tokenHash: hashToken(inviteToken) })
    const now = this.nowFn()

    if (!invite) {
      const bootstrap = await this.tryBootstrap({ inviteToken, profile, now, password })
      if (bootstrap) return bootstrap
      throw new ServiceError('AUTH_FAILED', 'Invite token is invalid')
    }
    if (invite.expires_at <= now) throw new ServiceError('AUTH_FAILED', 'Invite token has expired')
    if (invite.uses >= invite.max_uses) throw new ServiceError('AUTH_FAILED', 'Invite token has been used')

    const handle = profile?.handle?.trim()
    const displayName = profile?.display_name?.trim() || handle
    if (!handle) throw new ServiceError('BAD_REQUEST', 'Handle is required')
    if (!password) throw new ServiceError('BAD_REQUEST', 'Password is required')
    if (this.authRepo.isHandleTaken({ handle })) throw new ServiceError('CONFLICT', 'Handle already taken')

    const userId = newId('u')
    const roles = this.getDefaultRoles()
    const passwordHash = await hashPassword(password)
    const { sessionId, sessionToken, expiresAt } = this._makeSessionParts(now)

    this.authRepo.registerUser({
      inviteId: invite.invite_id,
      userId, handle, displayName,
      rolesJson: JSON.stringify(roles),
      passwordHash, now,
      sessionId, sessionTokenHash: hashToken(sessionToken), sessionExpiresAt: expiresAt
    })

    return {
      sessionToken,
      user: { user_id: userId, handle, display_name: displayName, roles }
    }
  }

  async tryBootstrap({ inviteToken, profile, now, password }) {
    if (!this.bootstrapToken || inviteToken !== this.bootstrapToken) return null
    if (this.authRepo.getUserCount() > 0) return null

    const handle = profile?.handle?.trim()
    const displayName = profile?.display_name?.trim() || handle
    if (!handle) throw new ServiceError('BAD_REQUEST', 'Handle is required')
    if (!password) throw new ServiceError('BAD_REQUEST', 'Password is required')
    if (this.authRepo.isHandleTaken({ handle })) throw new ServiceError('CONFLICT', 'Handle already taken')

    const userId = newId('u')
    const roles = ['admin']
    const passwordHash = await hashPassword(password)
    const { sessionId, sessionToken, expiresAt } = this._makeSessionParts(now)

    this.authRepo.registerBootstrapUser({
      userId, handle, displayName,
      rolesJson: JSON.stringify(roles),
      passwordHash, now,
      sessionId, sessionTokenHash: hashToken(sessionToken), sessionExpiresAt: expiresAt
    })

    this.bootstrapToken = null
    return {
      sessionToken,
      user: { user_id: userId, handle, display_name: displayName, roles }
    }
  }

  async signInWithPassword({ handle, password }) {
    if (!handle || !password) throw new ServiceError('BAD_REQUEST', 'Handle and password required')

    const row = this.authRepo.findUserByHandle({ handle })

    if (!row || !row.password_hash) throw new ServiceError('AUTH_FAILED', 'Invalid handle or password')

    const isValid = await verifyPassword(password, row.password_hash)
    if (!isValid) throw new ServiceError('AUTH_FAILED', 'Invalid handle or password')

    const now = this.nowFn()
    const { sessionId, sessionToken, expiresAt } = this._makeSessionParts(now)
    this.authRepo.insertSession({ sessionId, userId: row.user_id, tokenHash: hashToken(sessionToken), now, expiresAt })

    return {
      sessionToken,
      user: { user_id: row.user_id, handle: row.handle, display_name: row.display_name, roles: JSON.parse(row.roles_json) }
    }
  }

  createSession(userId) {
    const now = this.nowFn()
    const { sessionId, sessionToken, expiresAt } = this._makeSessionParts(now)
    this.authRepo.insertSession({ sessionId, userId, tokenHash: hashToken(sessionToken), now, expiresAt })
    return { sessionId, sessionToken, expiresAt }
  }

  validateSession(sessionToken) {
    if (!sessionToken) return null
    const now = this.nowFn()
    const row = this.authRepo.findSessionWithUser({ tokenHash: hashToken(sessionToken) })

    if (!row || row.revoked_at || row.expires_at <= now) return null

    this.authRepo.touchSession({ sessionId: row.session_id, now })

    return {
      session_id: row.session_id,
      user: { user_id: row.user_id, handle: row.handle, display_name: row.display_name, roles: JSON.parse(row.roles_json) }
    }
  }

  revokeSession(sessionId) {
    this.authRepo.revokeSession({ sessionId, now: this.nowFn() })
  }

  requireAdmin(userId) {
    const user = this.getUser(userId)
    if (!user || !user.roles.includes('admin')) throw new ServiceError('FORBIDDEN', 'Admin role required')
  }

  getUser(userId) {
    const row = this.authRepo.findUserById({ userId })
    if (!row) return null
    return { user_id: row.user_id, handle: row.handle, display_name: row.display_name, roles: JSON.parse(row.roles_json) }
  }

  findInvite(inviteToken) {
    return this.authRepo.findInviteByTokenHash({ tokenHash: hashToken(inviteToken) })
  }

  getDefaultRoles() { return ['user'] }

  getUserCount() {
    return this.authRepo.getUserCount()
  }

  isHandleTaken(handle) {
    return this.authRepo.isHandleTaken({ handle })
  }

  _makeSessionParts(now) {
    const sessionId = newId('s')
    const sessionToken = randomToken(32)
    const expiresAt = now + this.sessionTtlMs
    return { sessionId, sessionToken, expiresAt }
  }
}
