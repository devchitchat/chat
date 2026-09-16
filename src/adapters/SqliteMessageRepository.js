import { runTransaction } from '../db/transaction.js'

const MSG_COLS = `m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name, m.ts, m.text, m.edited_at, m.attachments_json, m.parent_msg_id`

export class SqliteMessageRepository {
  constructor({ db }) {
    this.db = db
  }

  /**
   * Atomically allocates the next seq, inserts the message and an audit event.
   * Returns { seq }.
   */
  insertMessage({ msgId, channelId, userId, now, text, clientMsgId, priority = 'normal', attachmentsJson = null, parentMsgId = null }) {
    return runTransaction(this.db, () => {
      const row = this.db.prepare('SELECT MAX(seq) AS max_seq FROM messages WHERE channel_id = ?').get(channelId)
      const seq = (row?.max_seq || 0) + 1

      this.db.prepare(
        `INSERT INTO messages (msg_id, channel_id, seq, user_id, ts, text, client_msg_id, priority, attachments_json, parent_msg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(msgId, channelId, seq, userId, now, text, clientMsgId, priority, attachmentsJson, parentMsgId ?? null)

      this.db.prepare(
        `INSERT INTO events (ts, actor_user_id, scope_kind, scope_id, type, body_json)
         VALUES (?, ?, 'channel', ?, 'msg.send', ?)`
      ).run(now, userId, channelId, JSON.stringify({ msg_id: msgId, seq }))

      return { seq }
    })
  }

  listMessages({ channelId, afterSeq, limit }) {
    const rows = this.db.prepare(
      `SELECT ${MSG_COLS}
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.channel_id = ? AND m.seq > ? AND m.deleted_at IS NULL AND m.parent_msg_id IS NULL ORDER BY m.seq ASC LIMIT ?`
    ).all(channelId, afterSeq, limit)
    return rows.map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }

  listLatestMessages({ channelId, limit }) {
    const rows = this.db.prepare(
      `SELECT ${MSG_COLS}
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.parent_msg_id IS NULL
       ORDER BY m.seq DESC LIMIT ?`
    ).all(channelId, limit)
    return rows.reverse().map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }

  getById(msgId) {
    return this.db.prepare(
      `SELECT msg_id, channel_id, seq, user_id, ts, text, deleted_at, parent_msg_id FROM messages WHERE msg_id = ?`
    ).get(msgId) ?? null
  }

  updateMessage({ msgId, text, editedAt }) {
    this.db.prepare(
      `UPDATE messages SET text = ?, edited_at = ? WHERE msg_id = ?`
    ).run(text, editedAt, msgId)
  }

  deleteMessage({ msgId, deletedAt }) {
    this.db.prepare(
      `UPDATE messages SET deleted_at = ? WHERE msg_id = ?`
    ).run(deletedAt, msgId)
  }

  listMessagesBefore({ channelId, beforeSeq, limit }) {
    const rows = this.db.prepare(
      `SELECT ${MSG_COLS}
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.channel_id = ? AND m.seq < ? AND m.deleted_at IS NULL AND m.parent_msg_id IS NULL
       ORDER BY m.seq DESC LIMIT ?`
    ).all(channelId, beforeSeq, limit)
    return rows.reverse().map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }

  listReplies({ parentMsgId }) {
    const rows = this.db.prepare(
      `SELECT ${MSG_COLS}
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.parent_msg_id = ? AND m.deleted_at IS NULL ORDER BY m.seq ASC`
    ).all(parentMsgId)
    return rows.map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }

  listThreads({ channelId, limit = 20 }) {
    const rows = this.db.prepare(
      `SELECT m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name,
              m.ts, m.text,
              COUNT(r.msg_id) AS reply_count,
              MAX(r.ts)       AS last_reply_ts
       FROM messages m
       LEFT JOIN users u ON m.user_id = u.user_id
       JOIN messages r ON r.parent_msg_id = m.msg_id AND r.deleted_at IS NULL
       WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.parent_msg_id IS NULL
       GROUP BY m.msg_id
       ORDER BY MAX(r.ts) DESC
       LIMIT ?`
    ).all(channelId, limit)
    return rows
  }

  getReplyCountsForMessages({ msgIds }) {
    if (!msgIds.length) return {}
    const placeholders = msgIds.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT parent_msg_id, COUNT(*) AS reply_count FROM messages
       WHERE parent_msg_id IN (${placeholders}) AND deleted_at IS NULL
       GROUP BY parent_msg_id`
    ).all(...msgIds)
    const result = {}
    for (const row of rows) result[row.parent_msg_id] = row.reply_count
    return result
  }
}
