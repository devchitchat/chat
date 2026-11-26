import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'

export class SecretModeService {
  constructor({ channelRepo, messageRepo, publicKeyRepo, nowFn = () => Date.now() }) {
    this.channelRepo   = channelRepo
    this.messageRepo   = messageRepo
    this.publicKeyRepo = publicKeyRepo
    this.nowFn         = nowFn
  }

  /**
   * Toggle secret mode on a DM channel.
   * Records a system message so the other party sees the change even if offline.
   *
   * @returns {{ channel_id, secret_mode, system_msg: { msg_id, seq, ts, text } }}
   */
  setSecretMode({ channelId, requestingUserId, enabled, requestingUserDisplayName = null }) {
    const channel = this.channelRepo.findById({ channelId })
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    if (channel.kind !== 'dm') throw new ServiceError('BAD_REQUEST', 'Secret mode is only available on DM channels')

    const membership = this.channelRepo.findMembership({ channelId, userId: requestingUserId })
    if (!membership || membership.left_at || membership.banned_at) {
      throw new ServiceError('FORBIDDEN', 'Not a member of this channel')
    }

    this.channelRepo.setDmSecretMode({ channelId, enabled })

    const name = requestingUserDisplayName ?? requestingUserId
    const text  = enabled
      ? `${name} turned on secret messages`
      : `${name} turned off secret messages`

    const now   = this.nowFn()
    const msgId = newId('m')
    const { seq } = this.messageRepo.insertSystemMessage({ msgId, channelId, userId: requestingUserId, now, text })

    return {
      channel_id:  channelId,
      secret_mode: enabled,
      system_msg:  { msg_id: msgId, seq, ts: now, text, msg_type: 'system', user_id: requestingUserId },
    }
  }

  // ── Public key management ──────────────────────────────────────────────────

  getPublicKey({ userId }) {
    return this.publicKeyRepo.getByUserId({ userId })
  }

  setPublicKey({ userId, publicKeyJwk }) {
    if (!publicKeyJwk || typeof publicKeyJwk !== 'string') {
      throw new ServiceError('BAD_REQUEST', 'publicKeyJwk must be a non-empty string')
    }
    // Validate it's parseable JSON before storing
    try { JSON.parse(publicKeyJwk) } catch {
      throw new ServiceError('BAD_REQUEST', 'publicKeyJwk must be valid JSON')
    }
    this.publicKeyRepo.upsert({ userId, publicKeyJwk, now: this.nowFn() })
  }
}
