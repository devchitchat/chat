export class InMemoryReactionRepository {
  constructor() {
    this._reactions = [] // { reaction_id, msg_id, channel_id, user_id, emoji, ts }
  }

  upsertReaction({ reactionId, msgId, channelId, userId, emoji, ts }) {
    const exists = this._reactions.find(r => r.msg_id === msgId && r.user_id === userId && r.emoji === emoji)
    if (!exists) {
      this._reactions.push({ reaction_id: reactionId, msg_id: msgId, channel_id: channelId, user_id: userId, emoji, ts })
    }
  }

  removeReaction({ msgId, userId, emoji }) {
    this._reactions = this._reactions.filter(r => !(r.msg_id === msgId && r.user_id === userId && r.emoji === emoji))
  }

  listReactionsForMsgs({ msgIds, requestingUserId }) {
    const map = new Map()
    if (!msgIds || msgIds.length === 0) return map

    const msgIdSet = new Set(msgIds)
    const relevant = this._reactions.filter(r => msgIdSet.has(r.msg_id))

    // Group by msg_id + emoji, preserving insertion order
    const grouped = new Map() // key: `${msgId}|${emoji}` → { msg_id, emoji, count, minTs, reacted }
    for (const r of relevant) {
      const key = `${r.msg_id}|${r.emoji}`
      if (!grouped.has(key)) {
        grouped.set(key, { msg_id: r.msg_id, emoji: r.emoji, count: 0, minTs: r.ts, reacted: false })
      }
      const entry = grouped.get(key)
      entry.count++
      if (r.ts < entry.minTs) entry.minTs = r.ts
      if (r.user_id === requestingUserId) entry.reacted = true
    }

    // Sort by minTs and build the output map
    const sorted = Array.from(grouped.values()).sort((a, b) => a.minTs - b.minTs)
    for (const entry of sorted) {
      if (!map.has(entry.msg_id)) map.set(entry.msg_id, [])
      map.get(entry.msg_id).push({ emoji: entry.emoji, count: entry.count, reacted: entry.reacted })
    }
    return map
  }
}
