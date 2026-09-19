/**
 * Channel, user, and DM WS handlers.
 */

export function handleChannelList(ws, msg, ctx) {
  const { auth, channelService, sendWs } = ctx
  const user = auth.getUser(ws.data.userId)
  const channels = channelService.listChannels(ws.data.userId, user?.roles || [])
  sendWs(ws, { t: 'channel.list_result', reply_to: msg.id, ok: true, body: { channels } })
}

export function handleChannelCreate(ws, msg, ctx) {
  const { auth, channelService, botService, sendWs, broadcastToChannelAudience, subscribeUserToChannel } = ctx
  const { kind, name, topic, visibility, session_ends_at, member_ids } = msg.body || {}

  // Compute session_ends_at from auto_end_days if provided
  const autoEndDays = msg.body?.auto_end_days
  let sessionEndsAt = session_ends_at ?? null
  if (kind === 'session' && autoEndDays != null && autoEndDays > 0) {
    sessionEndsAt = Date.now() + autoEndDays * 24 * 60 * 60 * 1000
  }

  const channel = channelService.createChannel({
    kind, name, topic, visibility,
    sessionEndsAt,
    createdByUserId: ws.data.userId,
  })

  // For session channels: add requested members
  if (kind === 'session' && Array.isArray(member_ids)) {
    const user = auth.getUser(ws.data.userId)
    for (const userId of member_ids) {
      if (userId === ws.data.userId) continue
      try {
        channelService.addMember({
          channelId: channel.channel_id,
          requestingUserId: ws.data.userId,
          requestingRoles: user?.roles || [],
          targetUserId: userId,
        })
        subscribeUserToChannel(userId, channel.channel_id)
      } catch { /* skip if user not found or already member */ }
    }
  }

  // Auto-add all bots to new public channels
  if (channel.visibility === 'public') {
    const botIds = botService.addBotsToPublicChannel({ channelId: channel.channel_id })
    for (const botUserId of botIds) subscribeUserToChannel(botUserId, channel.channel_id)
  }

  sendWs(ws, { t: 'channel.created', reply_to: msg.id, ok: true, body: { channel } })
  broadcastToChannelAudience(channel.channel_id, { t: 'channel.created', ok: true, body: { channel } }, ws)
}

export function handleSessionEnd(ws, msg, ctx) {
  const { auth, channelService, sendWs, publishChannel } = ctx
  const { channel_id } = msg.body || {}
  const user = auth.getUser(ws.data.userId)
  const channel = channelService.getChannel(channel_id)
  if (!channel || channel.kind !== 'session') {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'NOT_FOUND', message: 'Session not found' } })
  }
  const membership = channelService.getMembership(channel_id, ws.data.userId)
  const isOwner = membership?.role === 'owner'
  const isAdmin = user?.roles?.includes('admin')
  if (!isOwner && !isAdmin) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Only owner or admin can end a session' } })
  }
  const updated = channelService.updateChannel({
    channelId: channel_id, userId: ws.data.userId, roles: user?.roles || [],
    sessionEndsAt: Date.now(),
  })
  const result = { channel_id, session_ends_at: updated.session_ends_at }
  sendWs(ws, { t: 'session.ended', reply_to: msg.id, ok: true, body: result })
  publishChannel(channel_id, { t: 'session.ended', ok: true, body: result })
}

export function handleChannelUpdate(ws, msg, ctx) {
  const { auth, channelService, botService, sendWs, publishChannel, subscribeUserToChannel, unsubscribeUserFromChannel } = ctx
  const user = auth.getUser(ws.data.userId)
  const { channel_id, name, topic, visibility } = msg.body || {}

  const before = channelService.getChannel(channel_id)
  const channel = channelService.updateChannel({ channelId: channel_id, userId: ws.data.userId, roles: user?.roles || [], name, topic, visibility })

  // Sync bot memberships when visibility changes
  if (visibility !== undefined && before?.visibility !== visibility) {
    if (visibility === 'public') {
      const botIds = botService.addBotsToPublicChannel({ channelId: channel_id })
      for (const botUserId of botIds) subscribeUserToChannel(botUserId, channel_id)
    } else if (before?.visibility === 'public') {
      const botIds = botService.removeBotsFromChannel({ channelId: channel_id })
      for (const botUserId of botIds) {
        unsubscribeUserFromChannel(botUserId, channel_id)
        for (const [, conn] of ctx.connections) {
          if (conn.data.userId === botUserId) {
            sendWs(conn, { t: 'bot.channels_updated', body: { user_id: botUserId } })
          }
        }
      }
    }
  }

  sendWs(ws, { t: 'channel.updated', reply_to: msg.id, ok: true, body: { channel } })
  publishChannel(channel_id, { t: 'channel.updated', ok: true, body: { channel } })
}

export function handleChannelDelete(ws, msg, ctx) {
  const { auth, channelService, sendWs, collectChannelAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  const { channel_id } = msg.body || {}
  // Collect audience before deletion — access checks fail once deleted_at is set,
  // and publishChannel only reaches pub/sub subscribers (not sidebar connections)
  const audience = collectChannelAudience(channel_id, ws)
  const result = channelService.deleteChannel({ channelId: channel_id, userId: ws.data.userId, roles: user?.roles || [] })
  sendWs(ws, { t: 'channel.deleted', reply_to: msg.id, ok: true, body: result })
  audience.forEach(conn => sendWs(conn, { t: 'channel.deleted', ok: true, body: result }))
}

export function handleChannelJoin(ws, msg, ctx) {
  const { auth, channelService, deliveryService, presenceService, signalingService, sendWs } = ctx
  const user = auth.getUser(ws.data.userId)
  const { channel_id } = msg.body || {}
  const result = channelService.joinChannel({ channelId: channel_id, userId: ws.data.userId, userRoles: user?.roles || [] })
  ws.subscribe(`channel:${channel_id}`)
  presenceService.joinChannel(ws.data.connectionId, channel_id)
  deliveryService.getOrCreate({ channelId: channel_id, userId: ws.data.userId })
  sendWs(ws, { t: 'channel.joined', reply_to: msg.id, ok: true, body: result })

  // Push current call state so the joining client immediately sees "N in call" or nothing
  const activeCall = signalingService.getActiveCallForChannel(channel_id)
  const peers = activeCall ? Array.from(activeCall.peers.values()) : []
  sendWs(ws, {
    t: 'rtc.call_state', ok: true,
    body: { channel_id, call_id: activeCall?.call_id ?? null, count: peers.length, users: peers.map(p => ({ user_id: p.user_id })) }
  })
}

export function handleChannelLeave(ws, msg, ctx) {
  const { channelService, presenceService, sendWs } = ctx
  const { channel_id } = msg.body || {}
  channelService.leaveChannel({ channelId: channel_id, userId: ws.data.userId })
  ws.unsubscribe(`channel:${channel_id}`)
  presenceService.leaveChannel(ws.data.connectionId, channel_id)
  sendWs(ws, { t: 'channel.left', reply_to: msg.id, ok: true, body: { channel_id } })
}

export function handleChannelReorder(ws, msg, ctx) {
  const { channelService, sendWs } = ctx
  const { channel_ids, section } = msg.body || {}
  const channels = channelService.reorderChannels({ channelIds: channel_ids })
  // Broadcast to the requesting client; other clients will see the order on next channel.list_result
  sendWs(ws, { t: 'channel.reordered', reply_to: msg.id, ok: true, body: { channels, section } })
}

export function handleChannelAddMember(ws, msg, ctx) {
  const { auth, channelService, sendWs, subscribeUserToChannel } = ctx
  const { channel_id, user_id } = msg.body || {}
  const user = auth.getUser(ws.data.userId)
  const result = channelService.addMember({ channelId: channel_id, requestingUserId: ws.data.userId, requestingRoles: user?.roles || [], targetUserId: user_id })
  sendWs(ws, { t: 'channel.member_added', reply_to: msg.id, ok: true, body: result })

  // Subscribe the target user's active connections to the channel topic immediately.
  // For bots this is the only way they learn about the new channel at runtime;
  // humans will join explicitly but subscribing now is harmless and ensures
  // they receive any messages sent before they navigate to the channel.
  subscribeUserToChannel(user_id, channel_id)

  // If the target is a bot, also send bot.channels_updated so the bot process
  // can refresh its channel list and internal state.
  const targetUser = auth.getUser(user_id)
  if (targetUser?.roles?.includes('bot')) {
    for (const [, conn] of ctx.connections) {
      if (conn.data.userId === user_id) {
        sendWs(conn, { t: 'bot.channels_updated', body: { user_id } })
      }
    }
  }
}

export function handleChannelRemoveMember(ws, msg, ctx) {
  const { auth, channelService, sendWs, publishChannel, unsubscribeUserFromChannel } = ctx
  const { channel_id, user_id } = msg.body || {}
  const user = auth.getUser(ws.data.userId)
  const result = channelService.removeMember({ channelId: channel_id, requestingUserId: ws.data.userId, requestingRoles: user?.roles || [], targetUserId: user_id })
  sendWs(ws, { t: 'channel.member_removed', reply_to: msg.id, ok: true, body: result })
  publishChannel(channel_id, { t: 'channel.member_removed', ok: true, body: result })

  // If the removed member is a bot, unsubscribe its connections and notify it.
  const targetUser = auth.getUser(user_id)
  if (targetUser?.roles?.includes('bot')) {
    unsubscribeUserFromChannel(user_id, channel_id)
    for (const [, conn] of ctx.connections) {
      if (conn.data.userId === user_id) {
        sendWs(conn, { t: 'bot.channels_updated', body: { user_id } })
      }
    }
  }
}

export function handleChannelListMembers(ws, msg, ctx) {
  const { auth, channelService, sendWs } = ctx
  const { channel_id } = msg.body || {}
  const user = auth.getUser(ws.data.userId)
  const roles = user?.roles || []
  if (!channelService.canAccessChannel(channel_id, ws.data.userId, roles)) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Access denied' } })
  }
  const members = channelService.listChannelMembers(channel_id)
  const enriched = members.map(m => {
    const u = auth.getUser(m.user_id)
    return { user_id: m.user_id, handle: u?.handle ?? null, display_name: u?.display_name ?? null, role: m.role }
  })
  sendWs(ws, { t: 'channel.list_members_result', reply_to: msg.id, ok: true, body: { channel_id, members: enriched } })
}

// ── Users ──────────────────────────────────────────────────────────────────────

export function handleUserList(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const users = auth.listUsersBasic().filter(u => !u.roles.includes('bot'))
  sendWs(ws, { t: 'user.list_result', reply_to: msg.id, ok: true, body: { users } })
}

export function handleBotList(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const bots = auth.listUsersBasic().filter(u => u.roles.includes('bot'))
  sendWs(ws, { t: 'bot.list_result', reply_to: msg.id, ok: true, body: { bots } })
}

// ── Direct messages ────────────────────────────────────────────────────────────

export function handleDmOpen(ws, msg, ctx) {
  const { auth, channelService, sendWs, subscribeUserToChannel } = ctx
  const { target_user_id } = msg.body || {}
  const result = channelService.findOrCreateDm({ userId: ws.data.userId, targetUserId: target_user_id })
  const targetUser = auth.getUser(target_user_id)

  // Subscribe all active connections for both users to the DM channel topic.
  subscribeUserToChannel(ws.data.userId, result.channel_id)
  subscribeUserToChannel(target_user_id, result.channel_id)

  // Tell the initiating connection to navigate (no notify_only)
  sendWs(ws, {
    t: 'dm.opened', reply_to: msg.id, ok: true,
    body: { channel_id: result.channel_id, is_new: result.is_new, with_user: { user_id: target_user_id, display_name: targetUser?.display_name ?? null } }
  })

  // Notify the initiating user's OTHER connections (sidebar) so the DM appears in the list
  ctx.server?.publish(`user:${ws.data.userId}`, JSON.stringify({
    v: 1, server_ts: Date.now(), t: 'dm.opened', ok: true,
    body: { channel_id: result.channel_id, is_new: result.is_new, notify_only: true, with_user: { user_id: target_user_id, display_name: targetUser?.display_name ?? null } }
  }))

  // Notify the target user's connections — add to DM list, show unread dot, don't navigate
  ctx.server?.publish(`user:${target_user_id}`, JSON.stringify({
    v: 1, server_ts: Date.now(), t: 'dm.opened', ok: true,
    body: { channel_id: result.channel_id, is_new: result.is_new, notify_only: true, with_user: { user_id: ws.data.userId, display_name: ws.data.displayName } }
  }))
}

export function handleDmList(ws, msg, ctx) {
  const { auth, channelService, sendWs } = ctx
  const dms = channelService.listDms({ userId: ws.data.userId })
  for (const dm of dms) ws.subscribe(`channel:${dm.channel_id}`)
  const enriched = dms.map(dm => {
    const other = auth.getUser(dm.other_user_id)
    return { channel_id: dm.channel_id, with_user: { user_id: dm.other_user_id, display_name: other?.display_name ?? dm.other_user_id } }
  })
  sendWs(ws, { t: 'dm.list_result', reply_to: msg.id, ok: true, body: { dms: enriched } })
}

export function handleUserAvatarSet(ws, msg, ctx) {
  const { auth, sendWs, broadcastToAll } = ctx
  if (!ws.data.userId) return
  const { initials, color } = msg.body || {}
  auth.updateAvatar(ws.data.userId, { initials, color })
  const user = auth.getUser(ws.data.userId)
  sendWs(ws, { t: 'user.avatar.set_ok', reply_to: msg.id, ok: true, body: { user } })
  broadcastToAll({
    t: 'user.profile_updated', ok: true,
    body: { user_id: user.user_id, avatar_initials: user.avatar_initials, avatar_color: user.avatar_color, avatar_url: user.avatar_url, display_name: user.display_name }
  })
}
