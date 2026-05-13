import { ServiceError } from '../util/errors.js'
import { newId } from '../util/ids.js'
import { randomToken } from '../util/crypto.js'
import { AuthService } from '../services/AuthService.js'
import { HubService } from '../services/HubService.js'
import { ChannelService } from '../services/ChannelService.js'
import { MessageService } from '../services/MessageService.js'
import { DeliveryService } from '../services/DeliveryService.js'
import { NotificationService } from '../services/NotificationService.js'
import { SearchService } from '../services/SearchService.js'
import { PresenceService } from '../services/PresenceService.js'
import { SignalingService } from '../services/SignalingService.js'
import { BotService } from '../services/BotService.js'
import { parseMentions } from '../core/mentions.js'
import { SqliteAuthRepository } from '../adapters/SqliteAuthRepository.js'
import { SqliteHubRepository } from '../adapters/SqliteHubRepository.js'
import { SqliteChannelRepository } from '../adapters/SqliteChannelRepository.js'
import { SqliteMessageRepository } from '../adapters/SqliteMessageRepository.js'
import { SqliteDeliveryRepository } from '../adapters/SqliteDeliveryRepository.js'
import { SqliteSearchRepository } from '../adapters/SqliteSearchRepository.js'
import { SqliteSignalingRepository } from '../adapters/SqliteSignalingRepository.js'
import { handleHello, handleInviteRedeem, handleSignIn, handleSignOut, handleAdminInviteCreate, handleAdminInviteList, handleAdminInviteRevoke, handleAdminUserList, handleAdminUserSetRoles, handleAdminUserSetPassword, handleAdminUserSetDisplayName, handleAdminBotCreate, handleAdminBotList, handleAdminBotTokenCreate, handleAdminBotTokenRevoke, handleAdminBotSetChannels } from './handlers/authHandlers.js'
import { handleHubList, handleHubCreate, handleHubUpdate, handleHubDelete, handleHubAddMember, handleHubRemoveMember, handleHubListMembers } from './handlers/hubHandlers.js'
import { handleChannelList, handleChannelCreate, handleChannelUpdate, handleChannelDelete, handleChannelJoin, handleChannelLeave, handleChannelReorder, handleChannelAddMember, handleChannelListMembers, handleUserList, handleDmOpen, handleDmList } from './handlers/channelHandlers.js'
import { handleMsgSend, handleMsgList, handleSearchQuery, handlePresenceSubscribe } from './handlers/messageHandlers.js'
import { handleRtcCallCreate, handleRtcJoin, handleRtcOffer, handleRtcAnswer, handleRtcIce, handleRtcStreamPublish, handleRtcLeave, handleRtcEndCall } from './handlers/rtcHandlers.js'

/**
 * ChatServer — Bun native WebSocket implementation.
 *
 * Responsibilities:
 *   1. Composition root — instantiate repos and services
 *   2. WebSocket lifecycle — open, message, close
 *   3. Message routing — delegate to domain handler modules
 *   4. Shared helpers — sendWs, publish*, broadcast*, subscribeUserToChannel,
 *      sendDigest, dispatchMentions, getIceServers, attachUser
 *
 * Connection state lives in ws.data (set during upgrade):
 *   { connectionId, userId, sessionId, displayName, peerId, callId }
 *
 * Broadcasting uses Bun's topic pub/sub:
 *   ws.subscribe('channel:<id>')  — channel message delivery
 *   ws.subscribe('call:<id>')     — RTC signaling delivery
 *   ws.subscribe('user:<id>')     — direct user delivery
 *
 * The `websocket` property is passed directly to Bun.serve({ websocket }).
 */
export class ChatServer {
  constructor({ db, logger }) {
    this.db = db
    this.logger = logger

    // ── Repositories ───────────────────────────────────────────────────────────
    const authRepo     = new SqliteAuthRepository({ db })
    const hubRepo      = new SqliteHubRepository({ db })
    const channelRepo  = new SqliteChannelRepository({ db })
    const searchRepo   = new SqliteSearchRepository({ db })
    const messageRepo  = new SqliteMessageRepository({ db })
    const deliveryRepo = new SqliteDeliveryRepository({ db })

    // ── Services ───────────────────────────────────────────────────────────────
    this.auth             = new AuthService({ authRepo, sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 60 * 60 * 1000) })
    this.hubService       = new HubService({ hubRepo })
    this.channelService   = new ChannelService({ channelRepo, hubService: this.hubService })
    this.searchService    = new SearchService({ searchRepo })
    this.messageService   = new MessageService({ messageRepo, channelService: this.channelService, searchService: this.searchService })
    this.deliveryService  = new DeliveryService({ deliveryRepo })
    this.notificationService = new NotificationService({ deliveryService: this.deliveryService, authService: this.auth })
    this.presenceService  = new PresenceService()
    this.signalingService = new SignalingService({ signalingRepo: new SqliteSignalingRepository({ db }) })
    this.botService       = new BotService({ authService: this.auth, authRepo, channelRepo })

    // ── Connection state ───────────────────────────────────────────────────────
    this.connections    = new Map()  // connectionId → ws
    this.peerConnections = new Map() // peerId → connectionId

    this.signalingService.onEvent(event => this.#handleSignalingEvent(event))

    this.#ensureBootstrap()

    // Expose as a plain object for Bun.serve({ websocket })
    this.websocket = {
      open:    (ws)       => this.#open(ws),
      message: (ws, data) => this.#message(ws, data),
      close:   (ws)       => this.#close(ws),
    }
  }

  // ── Bun WebSocket lifecycle ────────────────────────────────────────────────

  #open(ws) {
    const connectionId = newId('conn')
    const userId       = ws.data?.userId      ?? null
    const sessionId    = ws.data?.sessionId   ?? null
    const displayName  = ws.data?.displayName ?? null
    ws.data = { connectionId, userId, sessionId, displayName, peerId: null, callId: null }
    if (userId) {
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
    const ctx = this.#ctx()
    switch (msg.t) {
      // Auth
      case 'hello':                      return handleHello(ws, msg, ctx)
      case 'auth.invite_redeem':         return handleInviteRedeem(ws, msg, ctx)
      case 'auth.signin':                return handleSignIn(ws, msg, ctx)
      case 'auth.signout':               return handleSignOut(ws, msg, ctx)
      // Admin — invites
      case 'admin.invite_create':        return handleAdminInviteCreate(ws, msg, ctx)
      case 'admin.invite_list':          return handleAdminInviteList(ws, msg, ctx)
      case 'admin.invite_revoke':        return handleAdminInviteRevoke(ws, msg, ctx)
      // Admin — users
      case 'admin.user_list':            return handleAdminUserList(ws, msg, ctx)
      case 'admin.user_set_roles':       return handleAdminUserSetRoles(ws, msg, ctx)
      case 'admin.user_set_password':    return handleAdminUserSetPassword(ws, msg, ctx)
      case 'admin.user_set_display_name': return handleAdminUserSetDisplayName(ws, msg, ctx)
      // Admin — bots
      case 'admin.bot_create':           return handleAdminBotCreate(ws, msg, ctx)
      case 'admin.bot_list':             return handleAdminBotList(ws, msg, ctx)
      case 'admin.bot_token_create':     return handleAdminBotTokenCreate(ws, msg, ctx)
      case 'admin.bot_token_revoke':     return handleAdminBotTokenRevoke(ws, msg, ctx)
      case 'admin.bot_set_channels':     return handleAdminBotSetChannels(ws, msg, ctx)
      // Hubs
      case 'hub.list':                   return handleHubList(ws, msg, ctx)
      case 'hub.create':                 return handleHubCreate(ws, msg, ctx)
      case 'hub.update':                 return handleHubUpdate(ws, msg, ctx)
      case 'hub.delete':                 return handleHubDelete(ws, msg, ctx)
      case 'hub.add_member':             return handleHubAddMember(ws, msg, ctx)
      case 'hub.remove_member':          return handleHubRemoveMember(ws, msg, ctx)
      case 'hub.list_members':           return handleHubListMembers(ws, msg, ctx)
      // Channels
      case 'channel.list':               return handleChannelList(ws, msg, ctx)
      case 'channel.create':             return handleChannelCreate(ws, msg, ctx)
      case 'channel.update':             return handleChannelUpdate(ws, msg, ctx)
      case 'channel.delete':             return handleChannelDelete(ws, msg, ctx)
      case 'channel.reorder':            return handleChannelReorder(ws, msg, ctx)
      case 'channel.join':               return handleChannelJoin(ws, msg, ctx)
      case 'channel.leave':              return handleChannelLeave(ws, msg, ctx)
      case 'channel.add_member':         return handleChannelAddMember(ws, msg, ctx)
      case 'channel.list_members':       return handleChannelListMembers(ws, msg, ctx)
      // Users & DMs
      case 'user.list':                  return handleUserList(ws, msg, ctx)
      case 'dm.open':                    return handleDmOpen(ws, msg, ctx)
      case 'dm.list':                    return handleDmList(ws, msg, ctx)
      // Messages
      case 'msg.send':                   return handleMsgSend(ws, msg, ctx)
      case 'msg.list':                   return handleMsgList(ws, msg, ctx)
      case 'search.query':               return handleSearchQuery(ws, msg, ctx)
      case 'presence.subscribe':         return handlePresenceSubscribe(ws, msg, ctx)
      // RTC
      case 'rtc.call_create':            return handleRtcCallCreate(ws, msg, ctx)
      case 'rtc.join':                   return handleRtcJoin(ws, msg, ctx)
      case 'rtc.offer':                  return handleRtcOffer(ws, msg, ctx)
      case 'rtc.answer':                 return handleRtcAnswer(ws, msg, ctx)
      case 'rtc.ice':                    return handleRtcIce(ws, msg, ctx)
      case 'rtc.stream_publish':         return handleRtcStreamPublish(ws, msg, ctx)
      case 'rtc.leave':                  return handleRtcLeave(ws, msg, ctx)
      case 'rtc.end_call':               return handleRtcEndCall(ws, msg, ctx)
      default:
        this.#sendWs(ws, { t: 'error', ok: false, reply_to: msg.id, body: { code: 'BAD_REQUEST', message: 'Unknown message type' } })
    }
  }

  // ── Shared context passed to all handlers ──────────────────────────────────

  #ctx() {
    const self = this
    return {
      // Services
      auth:                this.auth,
      hubService:          this.hubService,
      channelService:      this.channelService,
      messageService:      this.messageService,
      deliveryService:     this.deliveryService,
      searchService:       this.searchService,
      presenceService:     this.presenceService,
      signalingService:    this.signalingService,
      notificationService: this.notificationService,
      botService:          this.botService,
      // Connection state (mutable references)
      connections:         this.connections,
      peerConnections:     this.peerConnections,
      get server()         { return self.server },
      // Bound helpers
      sendWs:                    (ws, p)            => this.#sendWs(ws, p),
      publishChannel:            (channelId, p)     => this.#publishChannel(channelId, p),
      publishCall:               (callId, p)        => this.#publishCall(callId, p),
      publishCallState:          (chId, callId, ps) => this.#publishCallState(chId, callId, ps),
      broadcastToHubAudience:    (hubId, p, ex)     => this.#broadcastToHubAudience(hubId, p, ex),
      broadcastToChannelAudience:(chId, p, ex)      => this.#broadcastToChannelAudience(chId, p, ex),
      collectHubAudience:        (hubId, ex)        => this.#collectHubAudience(hubId, ex),
      collectChannelAudience:    (chId, ex)         => this.#collectChannelAudience(chId, ex),
      subscribeUserToChannel:    (userId, chId)     => this.#subscribeUserToChannel(userId, chId),
      sendDigest:                (ws, uid, ts)      => this.#sendDigest(ws, uid, ts),
      dispatchMentions:          (args)             => this.#dispatchMentions(args),
      getIceServers:             ()                 => this.#getIceServers(),
      attachUser:                (ws, user, sid)    => this.#attachUser(ws, user, sid),
    }
  }

  // ── Signaling event (SignalingService emitter → specific peer) ─────────────

  #handleSignalingEvent(event) {
    const toPeerId = event.body?.to_peer_id
    if (!toPeerId) return
    const connectionId = this.peerConnections.get(toPeerId)
    if (!connectionId) return
    const ws = this.connections.get(connectionId)
    if (ws) this.#sendWs(ws, event)
  }

  // ── Notification helpers ───────────────────────────────────────────────────

  #sendDigest(ws, userId, lastSeenAt) {
    try {
      const digest = this.notificationService.buildDigest(userId, lastSeenAt)
      if (digest.channels.length > 0 || digest.dms.length > 0) {
        this.#sendWs(ws, { t: 'notification.digest', ok: true, body: digest })
      }
    } catch { /* digest is best-effort */ }
  }

  #dispatchMentions({ channelId, senderId, text, seq }) {
    const rawMembers = this.channelService.listChannelMembers(channelId)
    const members = rawMembers
      .filter(m => m.user_id !== senderId)
      .map(m => {
        const u = this.auth.getUser(m.user_id)
        return u ? { user_id: u.user_id, handle: u.handle } : null
      })
      .filter(Boolean)

    const mentioned = parseMentions(text, members)
    for (const { user_id } of mentioned) {
      this.deliveryService.advanceMention({ channelId, userId: user_id, mentionSeq: seq })
      this.server?.publish(`user:${user_id}`, JSON.stringify({
        v: 1, server_ts: Date.now(), t: 'notification.mention', ok: true,
        body: { channel_id: channelId, seq, from_user_id: senderId }
      }))
    }
  }

  // ── Broadcasting helpers ───────────────────────────────────────────────────

  #publishChannel(channelId, payload) {
    this.server?.publish(`channel:${channelId}`, JSON.stringify(payload))
  }

  #publishCall(callId, payload) {
    this.server?.publish(`call:${callId}`, JSON.stringify(payload))
  }

  #publishCallState(channelId, callId, peers) {
    this.#publishChannel(channelId, {
      t: 'rtc.call_state', ok: true,
      body: { channel_id: channelId, call_id: callId, count: peers.length, users: peers.map(p => ({ user_id: p.user_id })) }
    })
  }

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

  #subscribeUserToChannel(userId, channelId) {
    const topic = `channel:${channelId}`
    for (const [, conn] of this.connections) {
      if (conn.data.userId === userId) conn.subscribe(topic)
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
    ws.data.userId    = user.user_id
    ws.data.sessionId = sessionId
    ws.data.displayName = user.display_name
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
