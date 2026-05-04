import { EventEmitter } from 'node:events'
import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'

export class SignalingService {
  constructor({ signalingRepo, nowFn = () => Date.now() } = {}) {
    this.nowFn = nowFn
    this.signalingRepo = signalingRepo ?? null
    this.calls = new Map()   // callId → { call_id, room_id, created_by_user_id, topology, peers: Map }
    this.emitter = new EventEmitter()

    if (this.signalingRepo) {
      this.#loadActiveCallsFromDb()
    }
  }

  // On startup: restore active calls into in-memory map so signaling can
  // continue for calls that were in progress when the server last stopped.
  // Peers reconnect via normal WS hello → channel.join → rtc.call_create flow.
  #loadActiveCallsFromDb() {
    const rows = this.signalingRepo.findActiveCalls()
    for (const row of rows) {
      this.calls.set(row.call_id, {
        call_id: row.call_id,
        room_id: row.channel_id,
        created_by_user_id: row.created_by_user_id,
        topology: row.topology,
        peers: new Map()  // peers reconnect fresh; previous peer_ids are gone
      })
    }
  }

  onEvent(handler) {
    this.emitter.on('event', handler)
  }

  createCall({ roomId, createdByUserId, topology = 'mesh' }) {
    // Check in-memory first (fast path)
    for (const call of this.calls.values()) {
      if (call.room_id === roomId) {
        return { call_id: call.call_id, room_id: call.room_id, topology: call.topology }
      }
    }

    // Check DB (covers calls restored from a previous server run that may not
    // have been re-hydrated into memory yet)
    if (this.signalingRepo) {
      const existing = this.signalingRepo.findActiveByChannel({ channelId: roomId })
      if (existing) {
        if (!this.calls.has(existing.call_id)) {
          this.calls.set(existing.call_id, {
            call_id: existing.call_id,
            room_id: existing.channel_id,
            created_by_user_id: existing.created_by_user_id,
            topology: existing.topology,
            peers: new Map()
          })
        }
        return { call_id: existing.call_id, room_id: existing.channel_id, topology: existing.topology }
      }
    }

    const callId = newId('call')
    const now = Math.floor(this.nowFn() / 1000)
    this.calls.set(callId, { call_id: callId, room_id: roomId, created_by_user_id: createdByUserId, topology, peers: new Map() })
    this.signalingRepo?.insertCall({ callId, channelId: roomId, createdByUserId, topology, startedAt: now })
    return { call_id: callId, room_id: roomId, topology }
  }

  joinCall({ callId, userId, displayName }) {
    const call = this.calls.get(callId)
    if (!call) throw new ServiceError('NOT_FOUND', 'Call not found')
    const peerId = newId('peer')
    const now = Math.floor(this.nowFn() / 1000)
    call.peers.set(peerId, { peer_id: peerId, user_id: userId, display_name: displayName ?? null, joined_at: now })
    this.signalingRepo?.insertParticipant({ callId, userId, peerId, joinedAt: now })
    const peers = Array.from(call.peers.values()).map(p => ({ peer_id: p.peer_id, user_id: p.user_id, display_name: p.display_name }))
    return { peerId, peers }
  }

  leaveCall({ callId, peerId }) {
    const call = this.calls.get(callId)
    if (!call) return { removed: false, peers: [], ended: false, room_id: null }
    const now = Math.floor(this.nowFn() / 1000)
    this.signalingRepo?.leaveParticipant({ callId, peerId, leftAt: now })
    const removed = call.peers.delete(peerId)
    const peers = Array.from(call.peers.values()).map(p => ({ peer_id: p.peer_id, user_id: p.user_id }))
    const roomId = call.room_id
    const ended = call.peers.size === 0
    if (ended) {
      this.calls.delete(callId)
      this.signalingRepo?.endCall({ callId, endedAt: now })
    }
    return { removed, peers, ended, room_id: roomId }
  }

  endCall({ callId }) {
    const call = this.calls.get(callId)
    if (!call) return null
    const now = Math.floor(this.nowFn() / 1000)
    this.calls.delete(callId)
    this.signalingRepo?.endCall({ callId, endedAt: now })
    return { call_id: call.call_id, room_id: call.room_id, peers: Array.from(call.peers.values()).map(p => ({ peer_id: p.peer_id, user_id: p.user_id })) }
  }

  getCall(callId) { return this.calls.get(callId) }

  getActiveCallForChannel(channelId) {
    for (const call of this.calls.values()) {
      if (call.room_id === channelId) return call
    }
    return null
  }

  routeOffer({ callId, fromPeerId, toPeerId, sdp }) {
    this.#route({ callId, fromPeerId, toPeerId, payload: { sdp }, type: 'rtc.offer_event' })
  }

  routeAnswer({ callId, fromPeerId, toPeerId, sdp }) {
    this.#route({ callId, fromPeerId, toPeerId, payload: { sdp }, type: 'rtc.answer_event' })
  }

  routeIce({ callId, fromPeerId, toPeerId, candidate }) {
    this.#route({ callId, fromPeerId, toPeerId, payload: { candidate }, type: 'rtc.ice_event' })
  }

  #route({ callId, fromPeerId, toPeerId, payload, type }) {
    const call = this.calls.get(callId)
    if (!call) throw new ServiceError('NOT_FOUND', 'Call not found')
    if (!call.peers.has(fromPeerId) || !call.peers.has(toPeerId)) throw new ServiceError('BAD_REQUEST', 'Peer not in call')
    this.emitter.emit('event', { t: type, body: { call_id: callId, from_peer_id: fromPeerId, to_peer_id: toPeerId, ...payload } })
  }
}
