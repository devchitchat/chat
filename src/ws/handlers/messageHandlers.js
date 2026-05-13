/**
 * Message, search, and presence WS handlers.
 */

export function handleMsgSend(ws, msg, ctx) {
  const { messageService, deliveryService, sendWs, publishChannel, dispatchMentions } = ctx
  const { channel_id, text, client_msg_id, priority, attachments } = msg.body || {}
  const result = messageService.sendMessage({
    channelId: channel_id, userId: ws.data.userId, text, clientMsgId: client_msg_id, priority,
    attachments: Array.isArray(attachments) ? attachments : []
  })

  sendWs(ws, { t: 'msg.ack', reply_to: msg.id, ok: true, body: { msg_id: result.msg_id, seq: result.seq, client_msg_id, priority: result.priority } })

  publishChannel(channel_id, {
    t: 'msg.event', ok: true,
    body: {
      msg_id: result.msg_id, channel_id, seq: result.seq,
      user_id: ws.data.userId, user_display_name: ws.data.displayName,
      ts: result.ts, text, priority: result.priority,
      attachments: result.attachments ?? []
    }
  })

  deliveryService.advance({ channelId: channel_id, userId: ws.data.userId, afterSeq: result.seq })
  dispatchMentions({ channelId: channel_id, senderId: ws.data.userId, text, seq: result.seq, priority: result.priority })
}

export function handleMsgList(ws, msg, ctx) {
  const { messageService, sendWs } = ctx
  const { channel_id, after_seq, limit } = msg.body || {}
  const result = messageService.listMessages({ channelId: channel_id, userId: ws.data.userId, afterSeq: after_seq ?? 0, limit: limit ?? 50 })
  sendWs(ws, { t: 'msg.list_result', reply_to: msg.id, ok: true, body: result })
}

export function handleSearchQuery(ws, msg, ctx) {
  const { auth, channelService, searchService, sendWs } = ctx
  const { channel_id, q, limit } = msg.body || {}
  const roles = auth.getUser(ws.data.userId)?.roles || []
  if (!channelService.canAccessChannel(channel_id, ws.data.userId, roles)) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Access denied' } })
  }
  const hits = searchService.searchMessages({ channelId: channel_id, query: q, limit })
  sendWs(ws, { t: 'search.result', reply_to: msg.id, ok: true, body: { hits } })
}

export function handlePresenceSubscribe(ws, msg, ctx) {
  const { auth, channelService, presenceService, sendWs } = ctx
  const roles = auth.getUser(ws.data.userId)?.roles || []
  const accessibleChannels = channelService.listChannels(ws.data.userId, roles)
  const channelIds = accessibleChannels.map(c => c.channel_id)
  const users = presenceService.listOnlineUsersInChannels(channelIds)
  sendWs(ws, { t: 'presence.snapshot', reply_to: msg.id, ok: true, body: { users } })
}
