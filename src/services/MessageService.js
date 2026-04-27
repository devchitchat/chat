import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'

export class MessageService {
  constructor({ messageRepo, nowFn = () => Date.now(), channelService, searchService }) {
    this.messageRepo = messageRepo
    this.nowFn = nowFn
    this.channelService = channelService
    this.searchService = searchService
  }

  sendMessage({ channelId, userId, text, clientMsgId = null }) {
    if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')
    if (!text?.trim()) throw new ServiceError('BAD_REQUEST', 'Message text required')

    const msgId = newId('m')
    const now = this.nowFn()
    const trimmed = text.trim()

    const { seq } = this.messageRepo.insertMessage({ msgId, channelId, userId, now, text: trimmed, clientMsgId })

    this.searchService.indexMessage({ msg_id: msgId, channel_id: channelId, seq, user_id: userId, ts: now, text: trimmed })

    return { msg_id: msgId, seq, ts: now }
  }

  listMessages({ channelId, userId, afterSeq = 0, limit = 50 }) {
    if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')

    const rows = this.messageRepo.listMessages({ channelId, afterSeq, limit })
    const lastSeq = rows.length ? rows[rows.length - 1].seq : afterSeq
    return { messages: rows, next_after_seq: lastSeq }
  }
}
