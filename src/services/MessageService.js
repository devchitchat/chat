import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'
import { validateEditPermission, validateEditText, assertMessageEditable } from '../core/messages.js'

export class MessageService {
  constructor({ messageRepo, nowFn = () => Date.now(), channelService, searchService, uploadService = null }) {
    this.messageRepo = messageRepo
    this.nowFn = nowFn
    this.channelService = channelService
    this.searchService = searchService
    this.uploadService = uploadService
  }

  setUploadService(uploadService) {
    this.uploadService = uploadService
  }

  sendMessage({ channelId, userId, text, clientMsgId = null, priority = 'normal', attachments = [] }) {
    if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')
    if (!text?.trim() && attachments.length === 0) throw new ServiceError('BAD_REQUEST', 'Message text or attachment required')
    if (!['normal', 'async', 'now'].includes(priority)) throw new ServiceError('BAD_REQUEST', 'Invalid priority')

    const msgId = newId('m')
    const now = this.nowFn()
    const trimmed = text?.trim() ?? ''

    const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null

    const { seq } = this.messageRepo.insertMessage({
      msgId, channelId, userId, now, text: trimmed, clientMsgId, priority, attachmentsJson
    })

    if (trimmed) {
      this.searchService.indexMessage({ msg_id: msgId, channel_id: channelId, seq, user_id: userId, ts: now, text: trimmed })
    }

    let enrichedAttachments = attachments
    if (this.uploadService && attachments.length > 0) {
      const uploadIds = attachments.map(a => a.upload_id).filter(Boolean)
      if (uploadIds.length > 0) {
        this.uploadService.linkToMessage({ uploadIds, msgId, userId, channelId })
        // Enrich with full upload details so consumers get url, mime_type, original_name.
        enrichedAttachments = attachments.map(a => {
          if (!a.upload_id) return a
          const row = this.uploadService.getUpload({ uploadId: a.upload_id })
          if (!row) return a
          return {
            upload_id:     row.upload_id,
            url:           `/uploads/${row.upload_id}/${encodeURIComponent(row.original_name)}`,
            original_name: row.original_name,
            mime_type:     row.mime_type,
            size_bytes:    row.size_bytes,
          }
        })
      }
    }

    return { msg_id: msgId, seq, ts: now, priority, attachments: enrichedAttachments }
  }

  editMessage({ msgId, channelId, userId, newText }) {
    const msg = this.messageRepo.getById(msgId)
    if (!msg) throw new ServiceError('NOT_FOUND', 'Message not found')
    if (msg.channel_id !== channelId) throw new ServiceError('BAD_REQUEST', 'Message does not belong to this channel')

    assertMessageEditable(msg.deleted_at)
    validateEditPermission(userId, msg.user_id)
    const trimmed = validateEditText(newText)

    const editedAt = this.nowFn()
    this.messageRepo.updateMessage({ msgId, text: trimmed, editedAt })

    this.searchService.indexMessage({ msg_id: msgId, channel_id: channelId, seq: msg.seq, user_id: msg.user_id, ts: msg.ts, text: trimmed })

    return { msgId, channelId, text: trimmed, editedAt }
  }

  listMessages({ channelId, userId, afterSeq = 0, limit = 50 }) {
    if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')

    const rows = this.messageRepo.listMessages({ channelId, afterSeq, limit })
    const lastSeq = rows.length ? rows[rows.length - 1].seq : afterSeq
    return { messages: rows, next_after_seq: lastSeq }
  }

  listLatestMessages({ channelId, userId, limit = 50 }) {
    if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')
    const rows = this.messageRepo.listLatestMessages({ channelId, limit })
    return { messages: rows }
  }

  listMessagesBefore({ channelId, userId, beforeSeq, limit = 50 }) {
    if (!this.channelService.isMember(channelId, userId)) throw new ServiceError('FORBIDDEN', 'Not a member of channel')
    const rows = this.messageRepo.listMessagesBefore({ channelId, beforeSeq, limit })
    const hasMore = rows.length === limit
    return { messages: rows, has_more: hasMore }
  }
}
