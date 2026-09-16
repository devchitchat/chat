/**
 * Sanitize a free-text query for FTS5's MATCH operator.
 *
 * FTS5 treats single quotes as phrase delimiters, so an apostrophe inside a
 * word (e.g. "doesn't") causes a syntax error. Wrapping each whitespace-
 * separated token in double quotes turns the input into a set of exact-token
 * phrase queries and disables all special-character interpretation inside the
 * token, including single quotes.
 *
 * Any literal double-quote characters in the input are removed so they can't
 * break the wrapping.
 */
function sanitizeFtsQuery(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return '""'
  return tokens.map(t => `"${t.replaceAll('"', '')}"`).join(' ')
}

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
    ).all(sanitizeFtsQuery(query), channelId, limit)
  }

  searchLike({ channelId, query, limit }) {
    return this.db.prepare(
      `SELECT channel_id, msg_id, seq, user_id, ts, text AS snippet
       FROM fts_messages WHERE channel_id = ? AND text LIKE ? LIMIT ?`
    ).all(channelId, `%${query}%`, limit)
  }

  searchFtsGlobal({ channelIds, query, limit }) {
    if (channelIds.length === 0) return []
    const placeholders = channelIds.map(() => '?').join(', ')
    return this.db.prepare(
      `SELECT m.channel_id, m.msg_id, m.seq, m.user_id, m.ts, m.parent_msg_id,
         snippet(fts_messages, 0, '<mark>', '</mark>', '…', 10) AS snippet
       FROM fts_messages
       JOIN messages m ON m.msg_id = fts_messages.msg_id
       WHERE fts_messages MATCH ? AND m.channel_id IN (${placeholders})
       ORDER BY bm25(fts_messages) LIMIT ?`
    ).all(sanitizeFtsQuery(query), ...channelIds, limit)
  }

  searchLikeGlobal({ channelIds, query, limit }) {
    if (channelIds.length === 0) return []
    const placeholders = channelIds.map(() => '?').join(', ')
    return this.db.prepare(
      `SELECT channel_id, msg_id, seq, user_id, ts, parent_msg_id, text AS snippet
       FROM fts_messages
       JOIN messages USING (msg_id)
       WHERE channel_id IN (${placeholders}) AND text LIKE ? LIMIT ?`
    ).all(...channelIds, `%${query}%`, limit)
  }
}
