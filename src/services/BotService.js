/**
 * BotService — manages bot user accounts and API tokens.
 *
 * Bots are regular users with the "bot" role. They authenticate to the
 * WebSocket using a long-lived bot token instead of a session cookie.
 * The token is hashed before storage; the plain token is returned once
 * at creation time and never retrievable again.
 */
import { newId } from '../util/ids.js'
import { randomToken, hashToken } from '../util/crypto.js'
import { ServiceError } from '../util/errors.js'

export class BotService {
  constructor({ authService, authRepo, channelRepo, nowFn = () => Date.now() }) {
    this.authService = authService
    this.authRepo = authRepo
    this.channelRepo = channelRepo
    this.nowFn = nowFn
  }

  // ── Bot accounts ───────────────────────────────────────────────────────────

  createBot({ handle, displayName, tokenLabel, requestingUserId }) {
    this._requireAdmin(requestingUserId)
    const h = handle?.trim()
    const name = displayName?.trim() || h
    if (!h) throw new ServiceError('BAD_REQUEST', 'Handle is required')
    if (this.authRepo.isHandleTaken({ handle: h })) throw new ServiceError('CONFLICT', 'Handle already taken')

    const userId = newId('u')
    const now = this.nowFn()
    this.authRepo.insertBotUser({ userId, handle: h, displayName: name, now })

    // Auto-join all existing public channels
    const publicChannels = this.channelRepo.listPublicNonDm()
    for (const ch of publicChannels) {
      this.channelRepo.upsertMembership({ channelId: ch.channel_id, userId, role: 'member', now })
    }

    const { tokenId, token } = this._insertToken({ userId, label: tokenLabel, now })
    return { userId, handle: h, displayName: name, roles: ['bot'], tokenId, token }
  }

  listBots({ requestingUserId }) {
    this._requireAdmin(requestingUserId)
    return this.authRepo.listUsers()
      .filter(row => {
        try { return JSON.parse(row.roles_json).includes('bot') } catch { return false }
      })
      .map(row => ({
        user_id:      row.user_id,
        handle:       row.handle,
        display_name: row.display_name,
        roles:        JSON.parse(row.roles_json),
        created_at:   row.created_at,
        tokens:       this.authRepo.listBotTokens({ userId: row.user_id }),
      }))
  }

  getBot({ userId, requestingUserId }) {
    this._requireAdmin(requestingUserId)
    const row = this.authRepo.findUserById({ userId })
    if (!row) throw new ServiceError('NOT_FOUND', 'Bot not found')
    const roles = JSON.parse(row.roles_json)
    if (!roles.includes('bot')) throw new ServiceError('NOT_FOUND', 'Bot not found')
    return {
      user_id:      row.user_id,
      handle:       row.handle,
      display_name: row.display_name,
      roles,
      tokens:       this.authRepo.listBotTokens({ userId }),
      channels:     this._getBotChannels(userId),
    }
  }

  // ── Bot tokens ─────────────────────────────────────────────────────────────

  createToken({ userId, label, ttlMs = null, requestingUserId }) {
    this._requireAdmin(requestingUserId)
    const now = this.nowFn()
    const expiresAt = ttlMs != null ? now + ttlMs : null
    return this._insertToken({ userId, label, now, expiresAt })
  }

  revokeToken({ tokenId, requestingUserId }) {
    this._requireAdmin(requestingUserId)
    this.authRepo.revokeBotToken({ tokenId, now: this.nowFn() })
  }

  revokeAllTokens({ userId, requestingUserId }) {
    this._requireAdmin(requestingUserId)
    this.authRepo.revokeAllBotTokens({ userId, now: this.nowFn() })
  }

  /** Called by ChatServer hello handler to authenticate a bot WS connection. */
  authenticateToken(plainToken) {
    const tokenHash = hashToken(plainToken)
    const row = this.authRepo.findBotTokenByHash({ tokenHash, now: this.nowFn() })
    if (!row) throw new ServiceError('UNAUTHORIZED', 'Invalid bot token')
    this.authRepo.touchBotToken({ tokenId: row.token_id, now: this.nowFn() })
    return {
      userId:      row.user_id,
      handle:      row.handle,
      displayName: row.display_name,
      roles:       JSON.parse(row.roles_json),
    }
  }

  // ── Bot channel membership ─────────────────────────────────────────────────

  /**
   * Set the private/session channel memberships for a bot.
   * Public channels are auto-managed and excluded from this delta — they are
   * never removed by this method even if absent from channelIds.
   */
  setBotChannels({ userId, channelIds, requestingUserId }) {
    this._requireAdmin(requestingUserId)
    const now = this.nowFn()

    const publicIds = new Set(this.channelRepo.listPublicNonDm().map(c => c.channel_id))

    // Only consider non-public channels for add/remove
    const current = this._getBotChannels(userId)
      .filter(c => !publicIds.has(c.channel_id))
      .map(c => c.channel_id)
    const next = (Array.isArray(channelIds) ? channelIds : []).filter(id => !publicIds.has(id))

    const toJoin  = next.filter(id => !current.includes(id))
    const toLeave = current.filter(id => !next.includes(id))

    for (const channelId of toJoin) {
      this.channelRepo.upsertMembership({ channelId, userId, role: 'member', now })
    }
    for (const channelId of toLeave) {
      this.channelRepo.setMemberLeft({ channelId, userId, now })
    }
  }

  /**
   * Add all existing bot users to a newly-created public channel.
   * Called by the channel create handler — no admin check, internal operation.
   */
  addBotsToPublicChannel({ channelId }) {
    const now = this.nowFn()
    const botIds = this.authRepo.listBotUserIds()
    for (const userId of botIds) {
      this.channelRepo.upsertMembership({ channelId, userId, role: 'member', now })
    }
    return botIds
  }

  /**
   * Remove all bots from a channel.
   * Called when a channel's visibility changes away from public.
   * Returns the list of bot user IDs that were removed.
   */
  removeBotsFromChannel({ channelId }) {
    const now = this.nowFn()
    const botIds = this.authRepo.listBotUserIds()
    for (const userId of botIds) {
      this.channelRepo.setMemberLeft({ channelId, userId, now })
    }
    return botIds
  }

  _getBotChannels(userId) {
    return this.channelRepo.listMemberships({ userId })
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  _insertToken({ userId, label, now, expiresAt = null }) {
    const token = randomToken()
    const tokenId = newId('bt')
    this.authRepo.insertBotToken({
      tokenId, userId,
      tokenHash: hashToken(token),
      label: label?.trim() || null,
      now,
      expiresAt,
    })
    return { tokenId, token, expiresAt }
  }

  _requireAdmin(userId) {
    const user = this.authService.getUser(userId)
    const roles = user?.roles ?? []
    if (!roles.includes('admin')) throw new ServiceError('FORBIDDEN', 'Admin role required')
  }
}
