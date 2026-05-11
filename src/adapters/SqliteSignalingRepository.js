export class SqliteSignalingRepository {
  constructor({ db }) {
    this._findActiveByChannel = db.prepare(`
      SELECT call_id, channel_id, created_by_user_id, topology, started_at
        FROM calls WHERE channel_id = ? AND ended_at IS NULL LIMIT 1
    `)
    this._findActiveCalls = db.prepare(`
      SELECT call_id, channel_id, created_by_user_id, topology, started_at
        FROM calls WHERE ended_at IS NULL
    `)
    this._insertCall = db.prepare(`
      INSERT INTO calls (call_id, channel_id, created_by_user_id, topology, started_at)
        VALUES (?, ?, ?, ?, ?)
    `)
    this._endCall = db.prepare(`
      UPDATE calls SET ended_at = ? WHERE call_id = ?
    `)
    this._insertParticipant = db.prepare(`
      INSERT INTO call_participants (call_id, user_id, peer_id, joined_at)
        VALUES (?, ?, ?, ?)
    `)
    this._leaveParticipant = db.prepare(`
      UPDATE call_participants SET left_at = ? WHERE call_id = ? AND peer_id = ?
    `)
  }

  findActiveByChannel({ channelId }) {
    return this._findActiveByChannel.get(channelId) ?? null
  }

  findActiveCalls() {
    return this._findActiveCalls.all()
  }

  insertCall({ callId, channelId, createdByUserId, topology, startedAt }) {
    this._insertCall.run(callId, channelId, createdByUserId, topology, startedAt)
  }

  endCall({ callId, endedAt }) {
    this._endCall.run(endedAt, callId)
  }

  insertParticipant({ callId, userId, peerId, joinedAt }) {
    this._insertParticipant.run(callId, userId, peerId, joinedAt)
  }

  leaveParticipant({ callId, peerId, leftAt }) {
    this._leaveParticipant.run(leftAt, callId, peerId)
  }
}
