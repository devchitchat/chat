import { ServiceError } from '../util/errors.js'
import { newId } from '../util/ids.js'
import { randomToken } from '../util/crypto.js'
import { AuthService } from '../services/AuthService.js'
import { HubService } from '../services/HubService.js'
import { ChannelService } from '../services/ChannelService.js'
import { MessageService } from '../services/MessageService.js'
import { DeliveryService } from '../services/DeliveryService.js'
import { SearchService } from '../services/SearchService.js'
import { PresenceService } from '../services/PresenceService.js'
import { SignalingService } from '../services/SignalingService.js'
import { SqliteAuthRepository } from '../adapters/SqliteAuthRepository.js'
import { SqliteHubRepository } from '../adapters/SqliteHubRepository.js'
import { SqliteChannelRepository } from '../adapters/SqliteChannelRepository.js'
import { SqliteMessageRepository } from '../adapters/SqliteMessageRepository.js'
import { SqliteDeliveryRepository } from '../adapters/SqliteDeliveryRepository.js'
import { SqliteSearchRepository } from '../adapters/SqliteSearchRepository.js'
import { SqliteSignalingRepository } from '../adapters/SqliteSignalingRepository.js'

/**
 * ChatServer — Bun native WebSocket implementation.
 *
 * Connection state lives in ws.data (set during upgrade):
 *   { connectionId, userId, sessionId, peerId, callId }
 *
 * Broadcasting uses Bun's topic pub/sub:
 *   ws.subscribe('channel:<id>')  — for channel message delivery
 *   ws.subscribe('call:<id>')     — for RTC signaling delivery
 *   ws.subscribe('user:<id>')     — for direct user delivery
 *
 * The `websocket` property is passed directly to Bun.serve({ websocket }).
 */
export class ChatServer {
  constructor({ db, logger }) {
    this.db = db
    this.logger = logger

    const authRepo = new SqliteAuthRepository({ db })
    const hubRepo = new SqliteHubRepository({ db })
    const channelRepo = new SqliteChannelRepository({ db })
    const searchRepo = new SqliteSearchRepository({ db })
    const messageRepo = new SqliteMessageRepository({ db })
    const deliveryRepo = new SqliteDeliveryRepository({ db })

    this.auth = new AuthService({ authRepo, sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000) })
    this.hubService = new HubService({ hubRepo })
    this.channelService = new ChannelService({ channelRepo, hubService: this.hubService })
    this.searchService = new SearchService({ searchRepo })
    this.messageService = new MessageService({ messageRepo, channelService: this.channelService, searchService: this.searchService })
    this.deliveryService = new DeliveryService({ deliveryRepo })
    this.presenceService = new PresenceService()
    this.signalingService = new SignalingService({ signalingRepo: new SqliteSignalingRepository({ db }) })

    // connectionId → ws (for direct lookup when we only have the id)
    this.connections = new Map()
    // peerId → connectionId (for RTC routing)
    this.peerConnections = new Map()

    this.signalingService.onEvent(event => this.#handleSignalingEvent(event))

    this.#ensureBootstrap()

    // Expose as a plain object for Bun.serve({ websocket })
    this.websocket = {
      open: (ws) => this.#open(ws),
      message: (ws, data) => this.#message(ws, data),
      close: (ws) => this.#close(ws),
    }
  }

  // ── Bun WebSocket lifecycle ────────────────────────────────────────────────

  #open(ws) {
    const connectionId = newId('conn')
    const userId    = ws.data?.userId    ?? null
    const sessionId = ws.data?.sessionId ?? null
    ws.data = { connectionId, userId, sessionId, peerId: null, callId: null }
    if (userId) {
      // Pre-authenticated via cookie at upgrade time — wire presence + user topic
      ws.subscribe(`user:${userId}`)
      this.presenceService.addConnection(connectionId, userId)
    }
    this.connections.set(connectionId, ws)
  }

  async #message(ws, data) {
    let msg
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
    } catch {
      this.#sendWs(ws, { t: 'error', ok: false, body: { code: 'BAD_REQUEST', message: 'Invalid JSON' } })
      return
    }

    if (!this.#isValidEnvelope(msg)) {
      this.#sendWs(ws, { t: 'error', ok: false, reply_to: msg?.id, body: { code: 'BAD_REQUEST', message: 'Invalid message envelope' } })
      return
    }

    const isAuthed = !!ws.data.userId
    if (!isAuthed && !['hello', 'auth.invite_redeem', 'auth.signin'].includes(msg.t)) {
      this.#sendWs(ws, { t: 'error', ok: false, reply_to: msg.id, body: { code: 'AUTH_REQUIRED', message: 'Authenticate first' } })
      return
    }

    try {
      await this.#route(ws, msg)
    } catch (err) {
      if (err instanceof ServiceError) {
        this.#sendWs(ws, { t: 'error', ok: false, reply_to: msg.id, body: { code: err.code, message: err.message } })
      } else {
        this.logger.error('ws.handle_error', { error: err?.message })
        this.#sendWs(ws, { t: 'error', ok: false, reply_to: msg.id, body: { code: 'INTERNAL', message: 'Internal error' } })
      }
    }
  }

  #close(ws) {
    const { connectionId, userId, peerId, callId } = ws.data
    if (peerId && callId) {
      this.peerConnections.delete(peerId)
      const result = this.signalingService.leaveCall({ callId, peerId })
      if (result.removed) {
        this.#publishCall(callId, { t: 'rtc.peer_event', ok: true, body: { call_id: callId, kind: 'leave', peer: { peer_id: peerId, user_id: userId } } })
      }
      if (result.ended && result.room_id) {
        this.#publishChannel(result.room_id, { t: 'rtc.call_end', ok: true, body: { call_id: callId, channel_id: result.room_id } })
        this.#publishCallState(result.room_id, null, [])
      } else if (result.removed && result.room_id) {
        const call = this.signalingService.getCall(callId)
        this.#publishCallState(result.room_id, callId, call ? Array.from(call.peers.values()) : [])
      }
    }
    if (userId) this.presenceService.removeConnection(connectionId, userId)
    this.connections.delete(connectionId)
  }

  // ── Message router ─────────────────────────────────────────────────────────

  async #route(ws, msg) {
    switch (msg.t) {
      case 'hello':                 return this.#handleHello(ws, msg)
      case 'auth.invite_redeem':    return this.#handleInviteRedeem(ws, msg)
      case 'auth.signin':           return this.#handleSignIn(ws, msg)
      case 'auth.signout':          return this.#handleSignOut(ws, msg)
      case 'admin.invite_create':   return this.#handleAdminInviteCreate(ws, msg)
      case 'hub.list':              return this.#handleHubList(ws, msg)
      case 'hub.create':            return this.#handleHubCreate(ws, msg)
      case 'hub.update':            return this.#handleHubUpdate(ws, msg)
      case 'hub.delete':            return this.#handleHubDelete(ws, msg)
      case 'channel.list':          return this.#handleChannelList(ws, msg)
      case 'channel.create':        return this.#handleChannelCreate(ws, msg)
      case 'channel.update':        return this.#handleChannelUpdate(ws, msg)
      case 'channel.delete':        return this.#handleChannelDelete(ws, msg)
      case 'channel.reorder':       return this.#handleChannelReorder(ws, msg)
      case 'channel.join':          return this.#handleChannelJoin(ws, msg)
      case 'channel.leave':         return this.#handleChannelLeave(ws, msg)
      case 'channel.invite_create': return this.#handleChannelInviteCreate(ws, msg)
      case 'channel.add_member':    return this.#handleChannelAddMember(ws, msg)
      case 'msg.send':              return this.#handleMsgSend(ws, msg)
      case 'msg.list':              return this.#handleMsgList(ws, msg)
      case 'search.query':          return this.#handleSearchQuery(ws, msg)
      case 'presence.subscribe':    return this.#handlePresenceSubscribe(ws, msg)
      case 'rtc.call_create':       return this.#handleRtcCallCreate(ws, msg)
      case 'rtc.join':              return this.#handleRtcJoin(ws, msg)
      case 'rtc.offer':             return this.#handleRtcOffer(ws, msg)
      case 'rtc.answer':            return this.#handleRtcAnswer(ws, msg)
      case 'rtc.ice':               return this.#handleRtcIce(ws, msg)
      case 'rtc.stream_publish':    return this.#handleRtcStreamPublish(ws, msg)
      case 'rtc.leave':             return this.#handleRtcLeave(ws, msg)
      case 'rtc.end_call':          return this.#handleRtcEndCall(ws, msg)
      default:
        this.#sendWs(ws, { t: 'error', ok: false, reply_to: msg.id, body: { code: 'BAD_REQUEST', message: 'Unknown message type' } })
    }
  }

  // ── Auth handlers ──────────────────────────────────────────────────────────

  #handleHello(ws, msg) {
    const resume = msg.body?.resume?.session_token
    let session = null
    if (resume) session = this.auth.validateSession(resume)
    if (session) this.#attachUser(ws, session.user, session.session_id)

    this.#sendWs(ws, {
      t: 'hello_ack', reply_to: msg.id, ok: true,
      body: {
        server: { name: 'devchitchat', ver: '2.0.0' },
        session: { authenticated: !!session, user: session?.user ?? null, session_token: resume ?? null },
        limits: { max_channels: 200, max_group_members: 20, max_message_bytes: 8000, max_signaling_bytes: 64000 }
      }
    })
  }

  async #handleInviteRedeem(ws, msg) {
    const { invite_token, profile, password } = msg.body || {}
    const result = await this.auth.redeemInvite({ inviteToken: invite_token, profile, password })
    const session = this.auth.validateSession(result.sessionToken)
    this.#attachUser(ws, session.user, session.session_id)
    this.#sendWs(ws, { t: 'auth.session', reply_to: msg.id, ok: true, body: { session_token: result.sessionToken, user: result.user } })
  }

  async #handleSignIn(ws, msg) {
    const { handle, password } = msg.body || {}
    const result = await this.auth.signInWithPassword({ handle, password })
    const session = this.auth.validateSession(result.sessionToken)
    this.#attachUser(ws, session.user, session.session_id)
    this.#sendWs(ws, { t: 'auth.session', reply_to: msg.id, ok: true, body: { session_token: result.sessionToken, user: result.user } })
  }

  #handleSignOut(ws, msg) {
    if (ws.data.sessionId) this.auth.revokeSession(ws.data.sessionId)
    ws.data.userId = null
    ws.data.sessionId = null
    this.#sendWs(ws, { t: 'auth.signed_out', reply_to: msg.id, ok: true, body: {} })
  }

  #handleAdminInviteCreate(ws, msg) {
    const { ttl_ms, max_uses, note } = msg.body || {}
    const invite = this.auth.createInvite({ createdByUserId: ws.data.userId, ttlMs: ttl_ms, maxUses: max_uses, note })
    this.#sendWs(ws, { t: 'admin.invite', reply_to: msg.id, ok: true, body: { invite_token: invite.inviteToken, expires_at: invite.expiresAt, max_uses: invite.maxUses } })
  }

  // ── Hub handlers ───────────────────────────────────────────────────────────

  #handleHubList(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const hubs = this.hubService.listHubs(ws.data.userId, user?.roles || [])
    this.#sendWs(ws, { t: 'hub.list_result', reply_to: msg.id, ok: true, body: { hubs } })
  }

  #handleHubCreate(ws, msg) {
    const { name, description, visibility } = msg.body || {}
    const hub = this.hubService.createHub({ name, description, visibility, createdByUserId: ws.data.userId })
    this.#sendWs(ws, { t: 'hub.created', reply_to: msg.id, ok: true, body: { hub } })
    this.#broadcastToHubAudience(hub.hub_id, { t: 'hub.created', ok: true, body: { hub } }, ws)
  }

  #handleHubUpdate(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const { hub_id, name, description } = msg.body || {}
    const hub = this.hubService.updateHub({ hubId: hub_id, userId: ws.data.userId, roles: user?.roles || [], name, description })
    this.#sendWs(ws, { t: 'hub.updated', reply_to: msg.id, ok: true, body: { hub } })
    this.#broadcastToHubAudience(hub.hub_id, { t: 'hub.updated', ok: true, body: { hub } }, ws)
  }

  #handleHubDelete(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const { hub_id } = msg.body || {}
    // Collect audience before deletion — access checks fail once deleted_at is set
    const audience = this.#collectHubAudience(hub_id, ws)
    const result = this.hubService.deleteHub({ hubId: hub_id, userId: ws.data.userId, roles: user?.roles || [] })
    this.#sendWs(ws, { t: 'hub.deleted', reply_to: msg.id, ok: true, body: result })
    audience.forEach(conn => this.#sendWs(conn, { t: 'hub.deleted', ok: true, body: result }))
  }

  // ── Channel handlers ───────────────────────────────────────────────────────

  #handleChannelList(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const channels = this.channelService.listChannels(ws.data.userId, user?.roles || [], msg.body?.hub_id)
    this.#sendWs(ws, { t: 'channel.list_result', reply_to: msg.id, ok: true, body: { channels, hub_id: msg.body?.hub_id } })
  }

  #handleChannelCreate(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    let { hub_id, kind, name, topic, visibility } = msg.body || {}
    if (!hub_id || hub_id === 'default') {
      hub_id = this.hubService.ensureDefaultHub(ws.data.userId).hub_id
    }
    const channel = this.channelService.createChannel({ hubId: hub_id, kind, name, topic, visibility, createdByUserId: ws.data.userId, userRoles: user?.roles || [] })
    this.#sendWs(ws, { t: 'channel.created', reply_to: msg.id, ok: true, body: { channel } })
    this.#broadcastToChannelAudience(channel.channel_id, { t: 'channel.created', ok: true, body: { channel } }, ws)
  }

  #handleChannelUpdate(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const { channel_id, name, topic } = msg.body || {}
    const channel = this.channelService.updateChannel({ channelId: channel_id, userId: ws.data.userId, roles: user?.roles || [], name, topic })
    this.#sendWs(ws, { t: 'channel.updated', reply_to: msg.id, ok: true, body: { channel } })
    this.#publishChannel(channel_id, { t: 'channel.updated', ok: true, body: { channel } })
  }

  #handleChannelDelete(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const { channel_id } = msg.body || {}
    // Collect audience before deletion — access checks fail once deleted_at is set,
    // and #publishChannel only reaches pub/sub subscribers (not sidebar connections)
    const audience = this.#collectChannelAudience(channel_id, ws)
    const result = this.channelService.deleteChannel({ channelId: channel_id, userId: ws.data.userId, roles: user?.roles || [] })
    this.#sendWs(ws, { t: 'channel.deleted', reply_to: msg.id, ok: true, body: result })
    audience.forEach(conn => this.#sendWs(conn, { t: 'channel.deleted', ok: true, body: result }))
  }

  #handleChannelJoin(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const { channel_id } = msg.body || {}
    const result = this.channelService.joinChannel({ channelId: channel_id, userId: ws.data.userId, userRoles: user?.roles || [] })
    ws.subscribe(`channel:${channel_id}`)
    this.presenceService.joinChannel(ws.data.connectionId, channel_id)
    this.deliveryService.getOrCreate({ channelId: channel_id, userId: ws.data.userId })
    this.#sendWs(ws, { t: 'channel.joined', reply_to: msg.id, ok: true, body: result })

    // Push current call state so the joining client immediately sees "N in call" or nothing
    const activeCall = this.signalingService.getActiveCallForChannel(channel_id)
    const peers = activeCall ? Array.from(activeCall.peers.values()) : []
    this.#sendWs(ws, {
      t: 'rtc.call_state', ok: true,
      body: { channel_id, call_id: activeCall?.call_id ?? null, count: peers.length, users: peers.map(p => ({ user_id: p.user_id })) }
    })
  }

  #handleChannelLeave(ws, msg) {
    const { channel_id } = msg.body || {}
    this.channelService.leaveChannel({ channelId: channel_id, userId: ws.data.userId })
    ws.unsubscribe(`channel:${channel_id}`)
    this.presenceService.leaveChannel(ws.data.connectionId, channel_id)
    this.#sendWs(ws, { t: 'channel.left', reply_to: msg.id, ok: true, body: { channel_id } })
  }

  #handleChannelReorder(ws, msg) {
    const user = this.auth.getUser(ws.data.userId)
    const { hub_id, channel_ids } = msg.body || {}
    const channels = this.channelService.reorderChannels({ hubId: hub_id, channelIds: channel_ids, userId: ws.data.userId, userRoles: user?.roles || [] })
    this.#broadcastToHubAudience(hub_id, { t: 'channel.reordered', ok: true, body: { hub_id, channels } }, null)
  }

  #handleChannelInviteCreate(ws, msg) {
    const { channel_id, ttl_ms, max_uses } = msg.body || {}
    const invite = this.channelService.createChannelInvite({ channelId: channel_id, createdByUserId: ws.data.userId, ttlMs: ttl_ms, maxUses: max_uses })
    this.#sendWs(ws, { t: 'channel.invite', reply_to: msg.id, ok: true, body: { invite_token: invite.inviteToken, expires_at: invite.expiresAt, max_uses: invite.maxUses } })
  }

  #handleChannelAddMember(ws, msg) {
    const { channel_id, user_id } = msg.body || {}
    const result = this.channelService.addMember({ channelId: channel_id, createdByUserId: ws.data.userId, targetUserId: user_id })
    this.#sendWs(ws, { t: 'channel.member_added', reply_to: msg.id, ok: true, body: result })
  }

  // ── Message handlers ───────────────────────────────────────────────────────

  #handleMsgSend(ws, msg) {
    const { channel_id, text, client_msg_id } = msg.body || {}
    const result = this.messageService.sendMessage({ channelId: channel_id, userId: ws.data.userId, text, clientMsgId: client_msg_id })
    const user = this.auth.getUser(ws.data.userId)

    this.#sendWs(ws, { t: 'msg.ack', reply_to: msg.id, ok: true, body: { msg_id: result.msg_id, seq: result.seq, client_msg_id } })

    this.#publishChannel(channel_id, {
      t: 'msg.event', ok: true,
      body: { msg_id: result.msg_id, channel_id, seq: result.seq, user_id: ws.data.userId, user_handle: user?.handle, ts: result.ts, text }
    })

    this.deliveryService.advance({ channelId: channel_id, userId: ws.data.userId, afterSeq: result.seq })
  }

  #handleMsgList(ws, msg) {
    const { channel_id, after_seq, limit } = msg.body || {}
    const result = this.messageService.listMessages({ channelId: channel_id, userId: ws.data.userId, afterSeq: after_seq ?? 0, limit: limit ?? 50 })
    this.#sendWs(ws, { t: 'msg.list_result', reply_to: msg.id, ok: true, body: result })
  }

  #handleSearchQuery(ws, msg) {
    const { channel_id, q, limit } = msg.body || {}
    const hits = this.searchService.searchMessages({ channelId: channel_id, query: q, limit })
    this.#sendWs(ws, { t: 'search.result', reply_to: msg.id, ok: true, body: { hits } })
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  #handlePresenceSubscribe(ws, msg) {
    const users = this.presenceService.listOnlineUsers()
    this.#sendWs(ws, { t: 'presence.snapshot', reply_to: msg.id, ok: true, body: { users } })
  }

  // ── RTC handlers ───────────────────────────────────────────────────────────

  #handleRtcCallCreate(ws, msg) {
    const { channel_id, kind = 'mesh' } = msg.body || {}
    const result = this.signalingService.createCall({ roomId: channel_id, createdByUserId: ws.data.userId, topology: kind })
    const iceServers = this.#getIceServers()
    this.#sendWs(ws, { t: 'rtc.call', reply_to: msg.id, ok: true, body: { ...result, channel_id, ice_servers: iceServers } })
  }

  #handleRtcJoin(ws, msg) {
    const { call_id } = msg.body || {}

    // Guard: if already in this call, return current participant list without re-joining
    if (ws.data.peerId && ws.data.callId === call_id) {
      const call = this.signalingService.getCall(call_id)
      if (call?.peers.has(ws.data.peerId)) {
        const peers = Array.from(call.peers.values()).map(p => ({ peer_id: p.peer_id, user_id: p.user_id }))
        this.#sendWs(ws, { t: 'rtc.joined', reply_to: msg.id, ok: true, body: { call_id, peer_id: ws.data.peerId, peers, ice_servers: this.#getIceServers() } })
        return
      }
    }

    // If already in a different call, leave it first
    if (ws.data.peerId && ws.data.callId && ws.data.callId !== call_id) {
      const prevCallId = ws.data.callId
      const prevPeerId = ws.data.peerId
      const leaveResult = this.signalingService.leaveCall({ callId: prevCallId, peerId: prevPeerId })
      this.peerConnections.delete(prevPeerId)
      ws.unsubscribe(`call:${prevCallId}`)
      if (leaveResult.removed) {
        this.#publishCall(prevCallId, { t: 'rtc.peer_event', ok: true, body: { call_id: prevCallId, kind: 'leave', peer: { peer_id: prevPeerId, user_id: ws.data.userId } } })
      }
      if (leaveResult.ended && leaveResult.room_id) {
        this.#publishChannel(leaveResult.room_id, { t: 'rtc.call_end', ok: true, body: { call_id: prevCallId, channel_id: leaveResult.room_id } })
        this.#publishCallState(leaveResult.room_id, null, [])
      }
    }

    const result = this.signalingService.joinCall({ callId: call_id, userId: ws.data.userId })
    ws.data.peerId = result.peerId
    ws.data.callId = call_id
    this.peerConnections.set(result.peerId, ws.data.connectionId)
    ws.subscribe(`call:${call_id}`)
    this.#sendWs(ws, { t: 'rtc.joined', reply_to: msg.id, ok: true, body: { call_id, peer_id: result.peerId, peers: result.peers, ice_servers: this.#getIceServers() } })
    this.#publishCall(call_id, { t: 'rtc.peer_event', ok: true, body: { call_id, kind: 'join', peer: { peer_id: result.peerId, user_id: ws.data.userId } } })

    // Broadcast updated call state to all channel subscribers (sidebar badges, "N in call" rows)
    const call = this.signalingService.getCall(call_id)
    if (call) this.#publishCallState(call.room_id, call_id, Array.from(call.peers.values()))
  }

  #handleRtcOffer(ws, msg) {
    const { call_id, to_peer_id, sdp } = msg.body || {}
    this.signalingService.routeOffer({ callId: call_id, fromPeerId: ws.data.peerId, toPeerId: to_peer_id, sdp })
  }

  #handleRtcAnswer(ws, msg) {
    const { call_id, to_peer_id, sdp } = msg.body || {}
    this.signalingService.routeAnswer({ callId: call_id, fromPeerId: ws.data.peerId, toPeerId: to_peer_id, sdp })
  }

  #handleRtcIce(ws, msg) {
    const { call_id, to_peer_id, candidate } = msg.body || {}
    this.signalingService.routeIce({ callId: call_id, fromPeerId: ws.data.peerId, toPeerId: to_peer_id, candidate })
  }

  #handleRtcStreamPublish(ws, msg) {
    const { call_id, stream } = msg.body || {}
    this.#publishCall(call_id, { t: 'rtc.stream_event', ok: true, body: { call_id, peer_id: ws.data.peerId, stream } })
  }

  #handleRtcLeave(ws, msg) {
    const { call_id } = msg.body || {}
    if (!ws.data.peerId) return
    const leavingPeerId = ws.data.peerId
    const result = this.signalingService.leaveCall({ callId: call_id, peerId: leavingPeerId })
    ws.unsubscribe(`call:${call_id}`)
    this.peerConnections.delete(leavingPeerId)
    ws.data.peerId = null
    ws.data.callId = null
    this.#sendWs(ws, { t: 'rtc.left', reply_to: msg.id, ok: true, body: { call_id } })
    if (result.removed) {
      this.#publishCall(call_id, { t: 'rtc.peer_event', ok: true, body: { call_id, kind: 'leave', peer: { peer_id: leavingPeerId, user_id: ws.data.userId } } })
    }
    if (result.ended && result.room_id) {
      this.#publishChannel(result.room_id, { t: 'rtc.call_end', ok: true, body: { call_id, channel_id: result.room_id } })
      this.#publishCallState(result.room_id, null, [])
    } else if (result.removed && result.room_id) {
      // Still an active call — broadcast updated participant count
      const call = this.signalingService.getCall(call_id)
      this.#publishCallState(result.room_id, call_id, call ? Array.from(call.peers.values()) : [])
    }
  }

  #handleRtcEndCall(ws, msg) {
    const { call_id } = msg.body || {}
    const result = this.signalingService.endCall({ callId: call_id })
    if (!result) return
    this.#publishCall(call_id, { t: 'rtc.call_end', ok: true, body: { call_id, channel_id: result.room_id } })
    this.#publishChannel(result.room_id, { t: 'rtc.call_end', ok: true, body: { call_id, channel_id: result.room_id } })
    this.#publishCallState(result.room_id, null, [])
    this.#sendWs(ws, { t: 'rtc.call_ended', reply_to: msg.id, ok: true, body: { call_id } })
  }

  // ── Signaling event (from SignalingService emitter → specific peer) ────────

  #handleSignalingEvent(event) {
    const toPeerId = event.body?.to_peer_id
    if (!toPeerId) return
    const connectionId = this.peerConnections.get(toPeerId)
    if (!connectionId) return
    const ws = this.connections.get(connectionId)
    if (ws) this.#sendWs(ws, event)
  }

  // ── Broadcasting helpers ───────────────────────────────────────────────────

  /** Publish to all subscribers of a channel topic */
  #publishChannel(channelId, payload) {
    this.server?.publish(`channel:${channelId}`, JSON.stringify(payload))
  }

  /** Publish to all subscribers of a call topic */
  #publishCall(callId, payload) {
    this.server?.publish(`call:${callId}`, JSON.stringify(payload))
  }

  /** Broadcast current call participant count to all channel subscribers */
  #publishCallState(channelId, callId, peers) {
    this.#publishChannel(channelId, {
      t: 'rtc.call_state', ok: true,
      body: { channel_id: channelId, call_id: callId, count: peers.length, users: peers.map(p => ({ user_id: p.user_id })) }
    })
  }

  /** Collect authenticated connections that can access a hub (used before deletion). */
  #collectHubAudience(hubId, excludeWs = null) {
    const audience = []
    const hub = this.hubService.getHub(hubId)
    if (!hub || hub.deleted_at) return audience
    const rolesCache = new Map()
    for (const [, ws] of this.connections) {
      if (!ws.data.userId || ws === excludeWs) continue
      if (!rolesCache.has(ws.data.userId)) {
        rolesCache.set(ws.data.userId, this.auth.getUser(ws.data.userId)?.roles || [])
      }
      if (this.hubService.canAccessHub(hubId, ws.data.userId, rolesCache.get(ws.data.userId))) {
        audience.push(ws)
      }
    }
    return audience
  }

  /** Collect authenticated connections that can access a channel (used before deletion). */
  #collectChannelAudience(channelId, excludeWs = null) {
    const audience = []
    const rolesCache = new Map()
    for (const [, ws] of this.connections) {
      if (!ws.data.userId || ws === excludeWs) continue
      if (!rolesCache.has(ws.data.userId)) {
        rolesCache.set(ws.data.userId, this.auth.getUser(ws.data.userId)?.roles || [])
      }
      if (this.channelService.canAccessChannel(channelId, ws.data.userId, rolesCache.get(ws.data.userId))) {
        audience.push(ws)
      }
    }
    return audience
  }

  /** Broadcast to all authenticated connections that can access a hub */
  #broadcastToHubAudience(hubId, payload, excludeWs = null) {
    const hub = this.hubService.getHub(hubId)
    if (!hub || hub.deleted_at) return
    const rolesCache = new Map()
    for (const [, ws] of this.connections) {
      if (!ws.data.userId || ws === excludeWs) continue
      if (!rolesCache.has(ws.data.userId)) {
        rolesCache.set(ws.data.userId, this.auth.getUser(ws.data.userId)?.roles || [])
      }
      if (this.hubService.canAccessHub(hubId, ws.data.userId, rolesCache.get(ws.data.userId))) {
        this.#sendWs(ws, payload)
      }
    }
  }

  /** Broadcast to all authenticated connections that can access a channel */
  #broadcastToChannelAudience(channelId, payload, excludeWs = null) {
    const rolesCache = new Map()
    for (const [, ws] of this.connections) {
      if (!ws.data.userId || ws === excludeWs) continue
      if (!rolesCache.has(ws.data.userId)) {
        rolesCache.set(ws.data.userId, this.auth.getUser(ws.data.userId)?.roles || [])
      }
      if (this.channelService.canAccessChannel(channelId, ws.data.userId, rolesCache.get(ws.data.userId))) {
        this.#sendWs(ws, payload)
      }
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  #sendWs(ws, payload) {
    try {
      ws.send(JSON.stringify({ v: 1, server_ts: Date.now(), ...payload }))
    } catch { /* ws may be closing */ }
  }

  #attachUser(ws, user, sessionId) {
    const alreadyAttached = ws.data.userId === user.user_id
    ws.data.userId = user.user_id
    ws.data.sessionId = sessionId
    if (!alreadyAttached) {
      ws.subscribe(`user:${user.user_id}`)
      this.presenceService.addConnection(ws.data.connectionId, user.user_id)
    }
  }

  #isValidEnvelope(msg) {
    return msg && msg.v === 1 && typeof msg.t === 'string' && typeof msg.id === 'string' && typeof msg.ts === 'number' && typeof msg.body === 'object'
  }

  #getIceServers() {
    const servers = [{ urls: process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302' }]
    if (process.env.TURN_URLS) {
      servers.push({ urls: process.env.TURN_URLS, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL })
    }
    return servers
  }

  #ensureBootstrap() {
    if (this.auth.getUserCount() > 0) return
    const token = process.env.BOOTSTRAP_TOKEN || randomToken(18)
    this.auth.bootstrapToken = token
    this.logger.info('auth.bootstrap_ready', { bootstrap_code: token })
  }

  /** Called by index.js after Bun.serve() returns, so publish works */
  attachServer(server) {
    this.server = server
  }
}
