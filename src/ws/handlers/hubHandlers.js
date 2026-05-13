/**
 * Hub WS handlers.
 */

export function handleHubList(ws, msg, ctx) {
  const { auth, hubService, sendWs } = ctx
  const user = auth.getUser(ws.data.userId)
  const hubs = hubService.listHubs(ws.data.userId, user?.roles || [])
  sendWs(ws, { t: 'hub.list_result', reply_to: msg.id, ok: true, body: { hubs } })
}

export function handleHubCreate(ws, msg, ctx) {
  const { hubService, sendWs, broadcastToHubAudience } = ctx
  const { name, description, visibility } = msg.body || {}
  const hub = hubService.createHub({ name, description, visibility, createdByUserId: ws.data.userId })
  sendWs(ws, { t: 'hub.created', reply_to: msg.id, ok: true, body: { hub } })
  broadcastToHubAudience(hub.hub_id, { t: 'hub.created', ok: true, body: { hub } }, ws)
}

export function handleHubUpdate(ws, msg, ctx) {
  const { auth, hubService, sendWs, broadcastToHubAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_id, name, description, visibility } = msg.body || {}
  const hub = hubService.updateHub({ hubId: hub_id, userId: ws.data.userId, roles: user?.roles || [], name, description, visibility })
  sendWs(ws, { t: 'hub.updated', reply_to: msg.id, ok: true, body: { hub } })
  broadcastToHubAudience(hub.hub_id, { t: 'hub.updated', ok: true, body: { hub } }, ws)
}

export function handleHubDelete(ws, msg, ctx) {
  const { auth, hubService, sendWs, collectHubAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_id } = msg.body || {}
  // Collect audience before deletion — access checks fail once deleted_at is set
  const audience = collectHubAudience(hub_id, ws)
  const result = hubService.deleteHub({ hubId: hub_id, userId: ws.data.userId, roles: user?.roles || [] })
  sendWs(ws, { t: 'hub.deleted', reply_to: msg.id, ok: true, body: result })
  audience.forEach(conn => sendWs(conn, { t: 'hub.deleted', ok: true, body: result }))
}

export function handleHubAddMember(ws, msg, ctx) {
  const { auth, hubService, sendWs, broadcastToHubAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_id, user_id } = msg.body || {}
  const result = hubService.addHubMember({ hubId: hub_id, targetUserId: user_id, requestingUserId: ws.data.userId, requestingRoles: user?.roles || [] })
  sendWs(ws, { t: 'hub.member_added', reply_to: msg.id, ok: true, body: result })
  ctx.server?.publish(`user:${user_id}`, JSON.stringify({ v: 1, server_ts: Date.now(), t: 'hub.member_added', ok: true, body: result }))
  broadcastToHubAudience(hub_id, { t: 'hub.member_added', ok: true, body: result }, ws)
}

export function handleHubRemoveMember(ws, msg, ctx) {
  const { auth, hubService, sendWs, broadcastToHubAudience } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_id, user_id } = msg.body || {}
  const result = hubService.removeHubMember({ hubId: hub_id, targetUserId: user_id, requestingUserId: ws.data.userId, requestingRoles: user?.roles || [] })
  sendWs(ws, { t: 'hub.member_removed', reply_to: msg.id, ok: true, body: result })
  ctx.server?.publish(`user:${user_id}`, JSON.stringify({ v: 1, server_ts: Date.now(), t: 'hub.member_removed', ok: true, body: result }))
  broadcastToHubAudience(hub_id, { t: 'hub.member_removed', ok: true, body: result }, ws)
}

export function handleHubReorder(ws, msg, ctx) {
  const { auth, hubService, sendWs, connections } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_ids } = msg.body || {}
  const hubs = hubService.reorderHubs({ hubIds: hub_ids, userId: ws.data.userId, userRoles: user?.roles || [] })
  // Broadcast to all authenticated connections — every sidebar needs to update
  for (const [, conn] of connections) {
    if (conn.data.userId) sendWs(conn, { t: 'hub.reordered', ok: true, body: { hubs } })
  }
}

export function handleHubListMembers(ws, msg, ctx) {
  const { auth, hubService, sendWs } = ctx
  const user = auth.getUser(ws.data.userId)
  const { hub_id } = msg.body || {}
  const members = hubService.listHubMembers({ hubId: hub_id, requestingUserId: ws.data.userId, requestingRoles: user?.roles || [] })
  const enriched = members.map(m => {
    if (m.handle) return m  // SqliteHubRepository joins users — already enriched
    const u = auth.getUser(m.user_id)
    return { user_id: m.user_id, handle: u?.handle ?? null, display_name: u?.display_name ?? null, joined_at: m.joined_at }
  })
  sendWs(ws, { t: 'hub.list_members_result', reply_to: msg.id, ok: true, body: { hub_id, members: enriched } })
}
