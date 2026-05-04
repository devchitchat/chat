export class PresenceService {
  constructor() {
    this.userToConnections = new Map()
    this.connectionToChannels = new Map()
  }

  addConnection(connectionId, userId) {
    if (!this.userToConnections.has(userId)) this.userToConnections.set(userId, new Set())
    this.userToConnections.get(userId).add(connectionId)
    this.connectionToChannels.set(connectionId, new Set())
  }

  removeConnection(connectionId, userId) {
    if (userId && this.userToConnections.has(userId)) {
      const set = this.userToConnections.get(userId)
      set.delete(connectionId)
      if (set.size === 0) this.userToConnections.delete(userId)
    }
    this.connectionToChannels.delete(connectionId)
  }

  joinChannel(connectionId, channelId) {
    this.connectionToChannels.get(connectionId)?.add(channelId)
  }

  leaveChannel(connectionId, channelId) {
    this.connectionToChannels.get(connectionId)?.delete(channelId)
  }

  listOnlineUsers() {
    return Array.from(this.userToConnections.entries()).map(([userId, connections]) => ({
      user_id: userId,
      online: connections.size > 0
    }))
  }

  /** Return online users who are subscribed to at least one of the given channels. */
  listOnlineUsersInChannels(channelIds) {
    const channelSet = new Set(channelIds)
    const result = []
    for (const [userId, connections] of this.userToConnections) {
      if (connections.size === 0) continue
      let visible = false
      for (const connectionId of connections) {
        const channels = this.connectionToChannels.get(connectionId) ?? new Set()
        for (const channelId of channels) {
          if (channelSet.has(channelId)) { visible = true; break }
        }
        if (visible) break
      }
      if (visible) result.push({ user_id: userId, online: true })
    }
    return result
  }
}
