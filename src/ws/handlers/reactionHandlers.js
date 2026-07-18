/**
 * Reaction WS handlers.
 */

export function handleReactionAdd(ws, msg, ctx) {
  const { reactionService, publishChannel } = ctx
  const { msg_id, channel_id, emoji } = msg.body ?? {}
  const reactions = reactionService.addReaction({
    msgId: msg_id, channelId: channel_id, userId: ws.data.userId, emoji,
  })
  publishChannel(channel_id, {
    t: 'reaction.event', ok: true,
    body: { msg_id, channel_id, emoji, user_id: ws.data.userId, action: 'add', reactions },
  })
}

export function handleReactionRemove(ws, msg, ctx) {
  const { reactionService, publishChannel } = ctx
  const { msg_id, channel_id, emoji } = msg.body ?? {}
  const reactions = reactionService.removeReaction({
    msgId: msg_id, channelId: channel_id, userId: ws.data.userId, emoji,
  })
  publishChannel(channel_id, {
    t: 'reaction.event', ok: true,
    body: { msg_id, channel_id, emoji, user_id: ws.data.userId, action: 'remove', reactions },
  })
}
