export class SqliteSearchRepository {
  constructor({ db }) {
    this.db = db
  }

  isFtsEnabled() {
    try {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'fts_messages'").get()
      return !!row?.sql && row.sql.toUpperCase().includes('VIRTUAL TABLE')
    } catch {
      return false
    }
  }

  indexMessage({ msg_id, channel_id, seq, user_id, ts, text }) {
    this.db.prepare(
      `INSERT INTO fts_messages (text, channel_id, msg_id, seq, user_id, ts) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(text, channel_id, msg_id, seq, user_id, ts)
  }

  removeMessage({ msgId }) {
    this.db.prepare(`DELETE FROM fts_messages WHERE msg_id = ?`).run(msgId)
  }

  searchFts({ channelId, query, limit }) {
    return this.db.prepare(
      `SELECT m.channel_id, m.msg_id, m.seq, m.user_id, m.ts,
         snippet(fts_messages, 0, '<mark>', '</mark>', '…', 10) AS snippet
       FROM fts_messages
       JOIN messages m ON m.msg_id = fts_messages.msg_id
       WHERE fts_messages MATCH ? AND m.channel_id = ?
       ORDER BY bm25(fts_messages) LIMIT ?`
    ).all(query, channelId, limit)
  }

  searchLike({ channelId, query, limit }) {
    return this.db.prepare(
      `SELECT channel_id, msg_id, seq, user_id, ts, text AS snippet
       FROM fts_messages WHERE channel_id = ? AND text LIKE ? LIMIT ?`
    ).all(channelId, `%${query}%`, limit)
  }
}
