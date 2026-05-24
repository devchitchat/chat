/**
 * WebRTC signaling WS handlers.
 */

export function handleRtcCallCreate(ws, msg, ctx) {
  const { auth, channelService, signalingService, sendWs, getIceServers } = ctx
  const { channel_id, kind = 'mesh' } = msg.body || {}
  const roles = auth.getUser(ws.data.userId)?.roles || []
  if (!channelService.canAccessChannel(channel_id, ws.data.userId, roles)) {
    return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Access denied' } })
  }
  const result = signalingService.createCall({ roomId: channel_id, createdByUserId: ws.data.userId, topology: kind })
  sendWs(ws, { t: 'rtc.call', reply_to: msg.id, ok: true, body: { ...result, channel_id, ice_servers: getIceServers() } })
}

export function handleRtcJoin(ws, msg, ctx) {
  const { auth, channelService, signalingService, sendWs, publishCall, publishChannel, publishCallState, getIceServers, peerConnections } = ctx
  const { call_id } = msg.body || {}

  // Guard: verify user can access the channel this call belongs to
  const call = signalingService.getCall(call_id)
  if (call) {
    const roles = auth.getUser(ws.data.userId)?.roles || []
    if (!channelService.canAccessChannel(call.room_id, ws.data.userId, roles)) {
      return sendWs(ws, { t: 'error', reply_to: msg.id, ok: false, body: { code: 'FORBIDDEN', message: 'Access denied' } })
    }
  }

  const result = signalingService.joinOrSwitch({
    callId: call_id,
    userId: ws.data.userId,
    displayName: ws.data.displayName,
    currentPeerId: ws.data.peerId,
    currentCallId: ws.data.callId,
  })

  if (result.status === 'already_in_call') {
    sendWs(ws, { t: 'rtc.joined', reply_to: msg.id, ok: true, body: { call_id, peer_id: result.peerId, peers: result.peers, ice_servers: getIceServers() } })
    return
  }

  // Publish transport side effects for previous call departure (status === 'switched')
  if (result.previousLeft) {
    const { call_id: prevCallId, room_id, peerId: prevPeerId, removed, ended } = result.previousLeft
    peerConnections.delete(prevPeerId)
    ws.unsubscribe(`call:${prevCallId}`)
    if (removed) {
      publishCall(prevCallId, { t: 'rtc.peer_event', ok: true, body: { call_id: prevCallId, kind: 'leave', peer: { peer_id: prevPeerId, user_id: ws.data.userId } } })
    }
    if (ended) {
      publishChannel(room_id, { t: 'rtc.call_end', ok: true, body: { call_id: prevCallId, channel_id: room_id } })
      publishCallState(room_id, null, [])
    }
  }

  ws.data.peerId = result.peerId
  ws.data.callId = call_id
  peerConnections.set(result.peerId, ws.data.connectionId)
  ws.subscribe(`call:${call_id}`)
  sendWs(ws, { t: 'rtc.joined', reply_to: msg.id, ok: true, body: { call_id, peer_id: result.peerId, peers: result.peers, ice_servers: getIceServers() } })
  publishCall(call_id, { t: 'rtc.peer_event', ok: true, body: { call_id, kind: 'join', peer: { peer_id: result.peerId, user_id: ws.data.userId, display_name: ws.data.displayName } } })

  const updatedCall = signalingService.getCall(call_id)
  if (updatedCall) publishCallState(updatedCall.room_id, call_id, Array.from(updatedCall.peers.values()))
}

export function handleRtcOffer(ws, msg, ctx) {
  const { signalingService } = ctx
  const { call_id, to_peer_id, sdp } = msg.body || {}
  if (!ws.data.peerId || ws.data.callId !== call_id) return
  signalingService.routeOffer({ callId: call_id, fromPeerId: ws.data.peerId, toPeerId: to_peer_id, sdp })
}

export function handleRtcAnswer(ws, msg, ctx) {
  const { signalingService } = ctx
  const { call_id, to_peer_id, sdp } = msg.body || {}
  if (!ws.data.peerId || ws.data.callId !== call_id) return
  signalingService.routeAnswer({ callId: call_id, fromPeerId: ws.data.peerId, toPeerId: to_peer_id, sdp })
}

export function handleRtcIce(ws, msg, ctx) {
  const { signalingService } = ctx
  const { call_id, to_peer_id, candidate } = msg.body || {}
  if (!ws.data.peerId || ws.data.callId !== call_id) return
  signalingService.routeIce({ callId: call_id, fromPeerId: ws.data.peerId, toPeerId: to_peer_id, candidate })
}

export function handleRtcStreamPublish(ws, msg, ctx) {
  const { publishCall } = ctx
  const { call_id, stream } = msg.body || {}
  publishCall(call_id, { t: 'rtc.stream_event', ok: true, body: { call_id, peer_id: ws.data.peerId, stream } })
}

export function handleRtcLeave(ws, msg, ctx) {
  const { signalingService, sendWs, publishCall, publishChannel, publishCallState, peerConnections } = ctx
  const { call_id } = msg.body || {}
  if (!ws.data.peerId) return
  const leavingPeerId = ws.data.peerId
  const result = signalingService.leaveCall({ callId: call_id, peerId: leavingPeerId })
  ws.unsubscribe(`call:${call_id}`)
  peerConnections.delete(leavingPeerId)
  ws.data.peerId = null
  ws.data.callId = null
  sendWs(ws, { t: 'rtc.left', reply_to: msg.id, ok: true, body: { call_id } })
  if (result.removed) {
    publishCall(call_id, { t: 'rtc.peer_event', ok: true, body: { call_id, kind: 'leave', peer: { peer_id: leavingPeerId, user_id: ws.data.userId } } })
  }
  if (result.ended && result.room_id) {
    publishChannel(result.room_id, { t: 'rtc.call_end', ok: true, body: { call_id, channel_id: result.room_id } })
    publishCallState(result.room_id, null, [])
  } else if (result.removed && result.room_id) {
    const call = signalingService.getCall(call_id)
    publishCallState(result.room_id, call_id, call ? Array.from(call.peers.values()) : [])
  }
}

export function handleRtcEndCall(ws, msg, ctx) {
  const { signalingService, sendWs, publishCall, publishChannel, publishCallState } = ctx
  const { call_id } = msg.body || {}
  const result = signalingService.endCall({ callId: call_id })
  if (!result) return
  publishCall(call_id, { t: 'rtc.call_end', ok: true, body: { call_id, channel_id: result.room_id } })
  publishChannel(result.room_id, { t: 'rtc.call_end', ok: true, body: { call_id, channel_id: result.room_id } })
  publishCallState(result.room_id, null, [])
  sendWs(ws, { t: 'rtc.call_ended', reply_to: msg.id, ok: true, body: { call_id } })
}
