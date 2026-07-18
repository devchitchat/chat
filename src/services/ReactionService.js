import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'
import { validateEmoji } from '../core/reactions.js'

const MAX_DISTINCT_EMOJI = 20

export class ReactionService {
  constructor({ reactionRepo, channelService, nowFn = () => Date.now() }) {
    this.reactionRepo = reactionRepo
    this.channelService = channelService
    this.nowFn = nowFn
  }

  addReaction({ msgId, channelId, userId, emoji }) {
    validateEmoji(emoji)
    if (!this.channelService.isMember(channelId, userId)) {
      throw new ServiceError('FORBIDDEN', 'Not a member')
    }

    // Enforce cap of 20 distinct emoji per message
    const current = this.reactionRepo.listReactionsForMsgs({ msgIds: [msgId], requestingUserId: userId })
    const existing = current.get(msgId) ?? []
    const alreadyHasEmoji = existing.some(r => r.emoji === emoji)
    if (!alreadyHasEmoji && existing.length >= MAX_DISTINCT_EMOJI) {
      throw new ServiceError('BAD_REQUEST', 'Reaction limit reached')
    }

    const reactionId = newId('rx')
    const ts = this.nowFn()
    this.reactionRepo.upsertReaction({ reactionId, msgId, channelId, userId, emoji, ts })
    return this.#summaryFor(msgId, userId)
  }

  removeReaction({ msgId, channelId, userId, emoji }) {
    validateEmoji(emoji)
    if (!this.channelService.isMember(channelId, userId)) {
      throw new ServiceError('FORBIDDEN', 'Not a member')
    }
    this.reactionRepo.removeReaction({ msgId, userId, emoji })
    return this.#summaryFor(msgId, userId)
  }

  /** Enriches a messages array with reactions — called by MessageService after list queries. */
  enrichWithReactions({ messages, requestingUserId }) {
    if (messages.length === 0) return messages
    const map = this.reactionRepo.listReactionsForMsgs({
      msgIds: messages.map(m => m.msg_id),
      requestingUserId,
    })
    return messages.map(m => ({ ...m, reactions: map.get(m.msg_id) ?? [] }))
  }

  #summaryFor(msgId, requestingUserId) {
    const map = this.reactionRepo.listReactionsForMsgs({ msgIds: [msgId], requestingUserId })
    return map.get(msgId) ?? []
  }
}
