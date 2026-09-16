/**
 * Message, search, and presence WS handlers.
 */
import { renderMarkdown } from '@devchitchat/index97/markdown'

/**
 * Auto-join a public channel on first message send if the user is not yet a member.
 * This is transport-layer orchestration: the service checks membership, and the
 * handler publishes the join event.
 */
function _autoJoinIfPublic(ws, channelId, ctx) {
  const { channelService, publishChannel } = ctx
  const channel = channelService?.getChannel(channelId)
  if (channelService && channel && channel.visibility === 'public' && channel.kind !== 'dm' && !channelService.isMember(channelId, ws.data.userId)) {
    channelService.joinChannel({ channelId, userId: ws.data.userId })
    publishChannel(channelId, {
      t: 'channel.joined', ok: true,
      body: { channel_id: channelId, user_id: ws.data.userId, display_name: ws.data.displayName, auto_joined: true }
    })
  }
}

export function handleMsgSend(ws, msg, ctx) {
  const { channelService, messageService, deliveryService, sendWs, publishChannel, dispatchMentions } = ctx
  const { channel_id, text, client_msg_id, priority, attachments, parent_msg_id } = msg.body || {}

  const channel = channelService?.getChannel(channel_id)

  // Reject messages in ended sessions
  if (channel?.kind === 'session' && channel.session_ends_at != null && channel.session_ends_at <= Date.now()) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'SESSION_ENDED', message: 'This session has ended' } })
  }

  // Auto-join public channels on first message send
  _autoJoinIfPublic(ws, channel_id, ctx)

  const result = messageService.sendMessage({
    channelId: channel_id, userId: ws.data.userId, text, clientMsgId: client_msg_id, priority,
    attachments: Array.isArray(attachments) ? attachments : [],
    parentMsgId: parent_msg_id ?? null
  })

  sendWs(ws, { t: 'msg.ack', reply_to: msg.id, ok: true, body: { msg_id: result.msg_id, seq: result.seq, client_msg_id, priority: result.priority } })

  const eventBody = {
    msg_id: result.msg_id, channel_id, seq: result.seq,
    user_id: ws.data.userId, user_display_name: ws.data.displayName,
    ts: result.ts, text, rendered_text: renderMarkdown(text).html,
    priority: result.priority, attachments: result.attachments ?? [],
    parent_msg_id: result.parent_msg_id ?? null
  }

  publishChannel(channel_id, { t: 'msg.event', ok: true, body: eventBody })

  // If this is a thread reply, also publish thread.reply_event so open thread panels update
  if (result.parent_msg_id) {
    publishChannel(channel_id, {
      t: 'thread.reply_event', ok: true,
      body: { parent_msg_id: result.parent_msg_id, channel_id, reply: eventBody }
    })
  }

  deliveryService.advance({ channelId: channel_id, userId: ws.data.userId, afterSeq: result.seq })
  dispatchMentions({ channelId: channel_id, senderId: ws.data.userId, text, msgId: result.msg_id, seq: result.seq, priority: result.priority })
}

export function handleMsgEdit(ws, msg, ctx) {
  const { messageService, publishChannel } = ctx
  const { msg_id, channel_id, text } = msg.body ?? {}
  const result = messageService.editMessage({ msgId: msg_id, channelId: channel_id, userId: ws.data.userId, newText: text })
  const renderedText = renderMarkdown(result.text).html
  publishChannel(channel_id, {
    t: 'msg.edited', ok: true,
    body: { msg_id: result.msgId, channel_id: result.channelId, text: result.text, edited_at: result.editedAt, rendered_text: renderedText },
  })
}

export function handleMsgList(ws, msg, ctx) {
  const { messageService, sendWs } = ctx
  const { channel_id, after_seq, before_seq, limit } = msg.body || {}

  const withRendered = messages => messages.map(m => ({ ...m, rendered_text: renderMarkdown(m.text).html }))

  if (before_seq != null) {
    const result = messageService.listMessagesBefore({
      channelId: channel_id,
      userId: ws.data.userId,
      beforeSeq: before_seq,
      limit: limit ?? 50,
    })
    sendWs(ws, { t: 'msg.list_result', reply_to: msg.id, ok: true, body: { ...result, messages: withRendered(result.messages), channel_id, direction: 'before' } })
    return
  }

  const result = messageService.listMessages({ channelId: channel_id, userId: ws.data.userId, afterSeq: after_seq ?? 0, limit: limit ?? 50 })
  sendWs(ws, { t: 'msg.list_result', reply_to: msg.id, ok: true, body: { ...result, messages: withRendered(result.messages), channel_id, direction: 'after' } })
}

export function handleMsgDelete(ws, msg, ctx) {
  const { messageService, publishChannel } = ctx
  const { msg_id, channel_id } = msg.body ?? {}
  const result = messageService.deleteMessage({ msgId: msg_id, channelId: channel_id, userId: ws.data.userId })
  publishChannel(channel_id, {
    t: 'msg.deleted', ok: true,
    body: { msg_id: result.msgId, channel_id: result.channelId, seq: result.seq },
  })
}

export function handleThreadChannelList(ws, msg, ctx) {
  const { messageService, sendWs } = ctx
  const { channel_id, limit } = msg.body || {}
  const threads = messageService.listChannelThreads({ channelId: channel_id, userId: ws.data.userId, limit: limit ?? 20 })
  sendWs(ws, { t: 'thread.channel_list_result', reply_to: msg.id, ok: true, body: { channel_id, threads } })
}

export function handleThreadList(ws, msg, ctx) {
  const { messageService, sendWs } = ctx
  const { parent_msg_id, channel_id } = msg.body || {}
  const replies = messageService.listThreadReplies({ parentMsgId: parent_msg_id, channelId: channel_id, userId: ws.data.userId })
  const withRendered = replies.map(m => ({ ...m, rendered_text: renderMarkdown(m.text).html }))
  sendWs(ws, { t: 'thread.list_result', reply_to: msg.id, ok: true, body: { parent_msg_id, channel_id, replies: withRendered } })
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

export function handleSearchGlobal(ws, msg, ctx) {
  const { auth, channelService, searchService, sendWs } = ctx
  const { q, limit } = msg.body || {}
  if (!q?.trim()) return sendWs(ws, { t: 'search.global_result', reply_to: msg.id, ok: true, body: { q: q ?? '', hits: [] } })
  const roles = auth.getUser(ws.data.userId)?.roles || []
  const accessibleChannels = channelService.listChannels(ws.data.userId, roles)
  const channelMap = new Map(accessibleChannels.map(c => [c.channel_id, c.name]))
  const hits = searchService.searchGlobal({ channelIds: [...channelMap.keys()], query: q.trim(), limit })
  const enriched = hits.map(h => ({ ...h, channel_name: channelMap.get(h.channel_id) ?? '' }))
  sendWs(ws, { t: 'search.global_result', reply_to: msg.id, ok: true, body: { q, hits: enriched } })
}

export function handlePresenceSubscribe(ws, msg, ctx) {
  const { auth, channelService, presenceService, sendWs } = ctx
  const roles = auth.getUser(ws.data.userId)?.roles || []
  const accessibleChannels = channelService.listChannels(ws.data.userId, roles)
  const channelIds = accessibleChannels.map(c => c.channel_id)
  const users = presenceService.listOnlineUsersInChannels(channelIds)
  sendWs(ws, { t: 'presence.snapshot', reply_to: msg.id, ok: true, body: { users } })
}
