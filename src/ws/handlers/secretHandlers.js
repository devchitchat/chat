/**
 * Secret messaging WS handlers.
 *
 * dm.set_secret_mode  — toggle secret mode on a DM channel
 * dm.secret           — relay an encrypted message (not stored)
 * user.public_key_set — store the caller's ECDH public key
 */

/**
 * Toggle secret mode on a DM channel.
 * Broadcasts dm.secret_mode_changed to both participants (via channel topic).
 */
export function handleDmSetSecretMode(ws, msg, ctx) {
  const { secretModeService, auth, sendWs, publishChannel } = ctx
  const { channel_id, enabled } = msg.body ?? {}

  const user = auth.getUser(ws.data.userId)
  const result = secretModeService.setSecretMode({
    channelId:                 channel_id,
    requestingUserId:          ws.data.userId,
    enabled:                   !!enabled,
    requestingUserDisplayName: ws.data.displayName ?? user?.display_name ?? ws.data.userId,
  })

  const eventBody = {
    channel_id:  result.channel_id,
    secret_mode: result.secret_mode,
    changed_by:  ws.data.userId,
    system_msg:  result.system_msg,
  }

  sendWs(ws, { t: 'dm.secret_mode_changed', reply_to: msg.id, ok: true, body: eventBody })
  publishChannel(channel_id, { t: 'dm.secret_mode_changed', ok: true, body: eventBody }, ws)
}

/**
 * Relay an encrypted message to the other participant.
 * The ciphertext is NEVER written to the database.
 *
 * Expected body: { channel_id, iv, ciphertext, client_msg_id? }
 */
export function handleDmSecret(ws, msg, ctx) {
  const { channelService, sendWs, connections } = ctx
  const { channel_id, iv, ciphertext, sender_public_key_jwk, client_msg_id } = msg.body ?? {}

  if (!iv || !ciphertext || !sender_public_key_jwk) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'BAD_REQUEST', message: 'iv, ciphertext, and sender_public_key_jwk are required' } })
  }

  if (!channelService.isMember(channel_id, ws.data.userId)) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Not a member of this channel' } })
  }

  const channel = channelService.getChannel(channel_id)
  if (!channel || channel.kind !== 'dm') {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'BAD_REQUEST', message: 'Secret messages are only supported in DMs' } })
  }

  if (!channel.secret_mode) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'BAD_REQUEST', message: 'Secret mode is not enabled on this channel' } })
  }

  const ts  = Date.now()
  const relayBody = {
    channel_id,
    from_user_id:          ws.data.userId,
    user_display_name:     ws.data.displayName ?? ws.data.userId,
    iv,
    ciphertext,
    sender_public_key_jwk,
    ts,
    client_msg_id: client_msg_id ?? null,
  }

  // Find all active connections for the other participant (not the sender)
  const members = channelService.listChannelMembers(channel_id)
  const otherMemberIds = members
    .map(m => m.user_id)
    .filter(uid => uid !== ws.data.userId)

  let delivered = false
  for (const [, conn] of connections) {
    if (otherMemberIds.includes(conn.data.userId)) {
      sendWs(conn, { t: 'dm.secret', ok: true, body: relayBody })
      delivered = true
    }
  }

  // Ack to sender
  sendWs(ws, { t: 'dm.secret_ack', reply_to: msg.id, ok: true, body: { client_msg_id: client_msg_id ?? null, ts, delivered } })

  if (!delivered) {
    sendWs(ws, { t: 'dm.secret_undelivered', ok: true, body: { channel_id, ts, client_msg_id: client_msg_id ?? null } })
  }
}

/**
 * Store or update the caller's ECDH public key.
 */
export function handleUserPublicKeySet(ws, msg, ctx) {
  const { secretModeService, sendWs } = ctx
  const { public_key_jwk } = msg.body ?? {}

  secretModeService.setPublicKey({ userId: ws.data.userId, publicKeyJwk: public_key_jwk })
  sendWs(ws, { t: 'user.public_key_set_ok', reply_to: msg.id, ok: true, body: {} })
}
