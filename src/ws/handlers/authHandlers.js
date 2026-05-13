/**
 * Auth & admin WS handlers.
 *
 * Each function receives (ws, msg, ctx) where ctx is the shared context
 * object built in ChatServer — services, state maps, and bound helpers.
 */

export function handleHello(ws, msg, ctx) {
  const { auth, botService, sendWs, sendDigest, attachUser } = ctx
  const { session_token, bot_token } = msg.body?.resume ?? {}
  let user = null
  let lastSeenAt = null

  if (bot_token) {
    const bot = botService.authenticateToken(bot_token)
    user = { user_id: bot.userId, handle: bot.handle, display_name: bot.displayName, roles: bot.roles }
    attachUser(ws, user, null)
  } else if (session_token) {
    const session = auth.validateSession(session_token)
    if (session) {
      user = session.user
      lastSeenAt = session.last_seen_at
      attachUser(ws, user, session.session_id)
    }
  }

  sendWs(ws, {
    t: 'hello_ack', reply_to: msg.id, ok: true,
    body: {
      server: { name: 'devchitchat', ver: '2.0.0' },
      session: { authenticated: !!user, user: user ?? null, session_token: session_token ?? null },
      limits: { max_channels: 200, max_group_members: 20, max_message_bytes: 8000, max_signaling_bytes: 64000 }
    }
  })

  if (user) sendDigest(ws, user.user_id, lastSeenAt)
}

export async function handleInviteRedeem(ws, msg, ctx) {
  const { auth, sendWs, sendDigest, attachUser } = ctx
  const { invite_token, profile, password } = msg.body || {}
  const result = await auth.redeemInvite({ inviteToken: invite_token, profile, password })
  const session = auth.validateSession(result.sessionToken)
  attachUser(ws, session.user, session.session_id)
  sendWs(ws, { t: 'auth.session', reply_to: msg.id, ok: true, body: { session_token: result.sessionToken, user: result.user } })
  sendDigest(ws, session.user.user_id, null)
}

export async function handleSignIn(ws, msg, ctx) {
  const { auth, sendWs, sendDigest, attachUser } = ctx
  const { handle, password } = msg.body || {}
  const result = await auth.signInWithPassword({ handle, password })
  const session = auth.validateSession(result.sessionToken)
  attachUser(ws, session.user, session.session_id)
  sendWs(ws, { t: 'auth.session', reply_to: msg.id, ok: true, body: { session_token: result.sessionToken, user: result.user } })
  sendDigest(ws, session.user.user_id, session.last_seen_at)
}

export function handleSignOut(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  if (ws.data.sessionId) auth.revokeSession(ws.data.sessionId)
  ws.data.userId = null
  ws.data.sessionId = null
  sendWs(ws, { t: 'auth.signed_out', reply_to: msg.id, ok: true, body: {} })
}

// ── Admin — invites ────────────────────────────────────────────────────────────

export function handleAdminInviteCreate(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const { ttl_ms, max_uses, note, roles } = msg.body || {}
  const invite = auth.createInvite({ createdByUserId: ws.data.userId, ttlMs: ttl_ms, maxUses: max_uses, note, roles })
  sendWs(ws, { t: 'admin.invite', reply_to: msg.id, ok: true, body: { invite_token: invite.inviteToken, expires_at: invite.expiresAt, max_uses: invite.maxUses, roles: invite.roles } })
}

export function handleAdminInviteList(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const invites = auth.listInvites({ requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.invite_list_result', reply_to: msg.id, ok: true, body: { invites } })
}

export function handleAdminInviteRevoke(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const { invite_id } = msg.body || {}
  auth.revokeInvite({ inviteId: invite_id, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.invite_revoked', reply_to: msg.id, ok: true, body: { invite_id } })
}

// ── Admin — users ──────────────────────────────────────────────────────────────

export function handleAdminUserList(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const users = auth.listUsers({ requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.user_list_result', reply_to: msg.id, ok: true, body: { users } })
}

export function handleAdminUserSetRoles(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const { user_id, roles } = msg.body || {}
  auth.setUserRoles({ targetUserId: user_id, roles, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.user_updated', reply_to: msg.id, ok: true, body: { user_id } })
}

export async function handleAdminUserSetPassword(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const { user_id, new_password } = msg.body || {}
  await auth.adminSetPassword({ targetUserId: user_id, newPassword: new_password, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.user_updated', reply_to: msg.id, ok: true, body: { user_id } })
}

export function handleAdminUserSetDisplayName(ws, msg, ctx) {
  const { auth, sendWs } = ctx
  const { user_id, display_name } = msg.body || {}
  auth.adminUpdateDisplayName({ targetUserId: user_id, displayName: display_name, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.user_updated', reply_to: msg.id, ok: true, body: { user_id } })
}

// ── Admin — bots ───────────────────────────────────────────────────────────────

export function handleAdminBotCreate(ws, msg, ctx) {
  const { botService, sendWs } = ctx
  const { handle, display_name, token_label } = msg.body || {}
  const result = botService.createBot({ handle, displayName: display_name, tokenLabel: token_label, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.bot_created', reply_to: msg.id, ok: true, body: result })
}

export function handleAdminBotList(ws, msg, ctx) {
  const { botService, sendWs } = ctx
  const bots = botService.listBots({ requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.bot_list_result', reply_to: msg.id, ok: true, body: { bots } })
}

export function handleAdminBotTokenCreate(ws, msg, ctx) {
  const { botService, sendWs } = ctx
  const { user_id, label } = msg.body || {}
  const result = botService.createToken({ userId: user_id, label, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.bot_token_created', reply_to: msg.id, ok: true, body: result })
}

export function handleAdminBotTokenRevoke(ws, msg, ctx) {
  const { botService, sendWs } = ctx
  const { token_id } = msg.body || {}
  botService.revokeToken({ tokenId: token_id, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.bot_token_revoked', reply_to: msg.id, ok: true, body: { token_id } })
}

export function handleAdminBotSetChannels(ws, msg, ctx) {
  const { botService, sendWs } = ctx
  const { user_id, channel_ids } = msg.body || {}
  botService.setBotChannels({ userId: user_id, channelIds: channel_ids, requestingUserId: ws.data.userId })
  sendWs(ws, { t: 'admin.bot_updated', reply_to: msg.id, ok: true, body: { user_id } })
}
