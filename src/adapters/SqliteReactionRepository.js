export class SqliteReactionRepository {
  constructor({ db }) {
    this.db = db
  }

  /** Returns void. UNIQUE constraint is the idempotency guard. */
  upsertReaction({ reactionId, msgId, channelId, userId, emoji, ts }) {
    this.db.prepare(
      `INSERT INTO message_reactions (reaction_id, msg_id, channel_id, user_id, emoji, ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (msg_id, user_id, emoji) DO NOTHING`
    ).run(reactionId, msgId, channelId, userId, emoji, ts)
  }

  /** Returns void. No-op if the row doesn't exist. */
  removeReaction({ msgId, userId, emoji }) {
    this.db.prepare(
      `DELETE FROM message_reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?`
    ).run(msgId, userId, emoji)
  }

  /**
   * Returns Map<msgId, [{emoji, count, reacted}]>
   * requestingUserId used to compute the `reacted` flag.
   */
  listReactionsForMsgs({ msgIds, requestingUserId }) {
    if (!msgIds || msgIds.length === 0) return new Map()

    const placeholders = msgIds.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT msg_id, emoji, COUNT(*) AS count,
              MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reacted
       FROM message_reactions
       WHERE msg_id IN (${placeholders})
       GROUP BY msg_id, emoji
       ORDER BY MIN(ts) ASC`
    ).all(requestingUserId, ...msgIds)

    const map = new Map()
    for (const row of rows) {
      if (!map.has(row.msg_id)) map.set(row.msg_id, [])
      map.get(row.msg_id).push({
        emoji: row.emoji,
        count: row.count,
        reacted: row.reacted === 1,
      })
    }
    return map
  }
}
