/**
 * Channel, user, and DM WS handlers.
 */

export function handleChannelList(ws, msg, ctx) {
  const { auth, channelService, sendWs } = ctx
  const user = auth.getUser(ws.data.userId)
  const channels = channelService.listChannels(ws.data.userId, user?.roles || [], msg.body?.hub_id)
  sendWs(ws, { t: 'channel.list_result', reply_to: msg.id, ok: true, body: { channels, hub_id: msg.body?.hub_id } })
}

export function handleChannelCreate(ws, msg, ctx) {
  const { auth, hubService, channelService, sendWs, broadcastToChannelAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  let { hub_id, kind, name, topic, visibility } = msg.body || {}
  if (!hub_id || hub_id === 'default') {
    hub_id = hubService.ensureDefaultHub(ws.data.userId).hub_id
  }
  const channel = channelService.createChannel({ hubId: hub_id, kind, name, topic, visibility, createdByUserId: ws.data.userId, userRoles: user?.roles || [] })
  sendWs(ws, { t: 'channel.created', reply_to: msg.id, ok: true, body: { channel } })
  broadcastToChannelAudience(channel.channel_id, { t: 'channel.created', ok: true, body: { channel } }, ws)
}

export function handleChannelUpdate(ws, msg, ctx) {
  const { auth, channelService, sendWs, publishChannel } = ctx
  const user = auth.getUser(ws.data.userId)
  const { channel_id, name, topic, visibility } = msg.body || {}
  const channel = channelService.updateChannel({ channelId: channel_id, userId: ws.data.userId, roles: user?.roles || [], name, topic, visibility })
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
  const { auth, channelService, broadcastToHubAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_id, channel_ids } = msg.body || {}
  const channels = channelService.reorderChannels({ hubId: hub_id, channelIds: channel_ids, userId: ws.data.userId, userRoles: user?.roles || [] })
  broadcastToHubAudience(hub_id, { t: 'channel.reordered', ok: true, body: { hub_id, channels } }, null)
}

export function handleChannelAddMember(ws, msg, ctx) {
  const { channelService, sendWs } = ctx
  const { channel_id, user_id } = msg.body || {}
  const result = channelService.addMember({ channelId: channel_id, createdByUserId: ws.data.userId, targetUserId: user_id })
  sendWs(ws, { t: 'channel.member_added', reply_to: msg.id, ok: true, body: result })
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
