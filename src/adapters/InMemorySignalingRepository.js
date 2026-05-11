export class InMemorySignalingRepository {
  constructor() {
    this._calls = new Map()         // callId → { call_id, channel_id, created_by_user_id, topology, started_at, ended_at }
    this._participants = []         // { call_id, user_id, peer_id, joined_at, left_at }
  }

  findActiveByChannel({ channelId }) {
    for (const call of this._calls.values()) {
      if (call.channel_id === channelId && call.ended_at == null) return call
    }
    return null
  }

  findActiveCalls() {
    return [...this._calls.values()].filter(c => c.ended_at == null)
  }

  insertCall({ callId, channelId, createdByUserId, topology, startedAt }) {
    this._calls.set(callId, { call_id: callId, channel_id: channelId, created_by_user_id: createdByUserId, topology, started_at: startedAt, ended_at: null })
  }

  endCall({ callId, endedAt }) {
    const call = this._calls.get(callId)
    if (call) call.ended_at = endedAt
  }

  insertParticipant({ callId, userId, peerId, joinedAt }) {
    this._participants.push({ call_id: callId, user_id: userId, peer_id: peerId, joined_at: joinedAt, left_at: null })
  }

  leaveParticipant({ callId, peerId, leftAt }) {
    const p = this._participants.find(p => p.call_id === callId && p.peer_id === peerId && p.left_at == null)
    if (p) p.left_at = leftAt
  }
}
