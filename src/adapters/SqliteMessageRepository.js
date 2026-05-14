import { runTransaction } from '../db/transaction.js'

export class SqliteMessageRepository {
  constructor({ db }) {
    this.db = db
  }

  /**
   * Atomically allocates the next seq, inserts the message and an audit event.
   * Returns { seq }.
   */
  insertMessage({ msgId, channelId, userId, now, text, clientMsgId, priority = 'normal', attachmentsJson = null }) {
    return runTransaction(this.db, () => {
      const row = this.db.prepare('SELECT MAX(seq) AS max_seq FROM messages WHERE channel_id = ?').get(channelId)
      const seq = (row?.max_seq || 0) + 1

      this.db.prepare(
        `INSERT INTO messages (msg_id, channel_id, seq, user_id, ts, text, client_msg_id, priority, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(msgId, channelId, seq, userId, now, text, clientMsgId, priority, attachmentsJson)

      this.db.prepare(
        `INSERT INTO events (ts, actor_user_id, scope_kind, scope_id, type, body_json)
         VALUES (?, ?, 'channel', ?, 'msg.send', ?)`
      ).run(now, userId, channelId, JSON.stringify({ msg_id: msgId, seq }))

      return { seq }
    })
  }

  listMessages({ channelId, afterSeq, limit }) {
    const rows = this.db.prepare(
      `SELECT m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name, m.ts, m.text, m.attachments_json
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`
    ).all(channelId, afterSeq, limit)
    return rows.map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }

  listLatestMessages({ channelId, limit }) {
    const rows = this.db.prepare(
      `SELECT m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name, m.ts, m.text, m.attachments_json
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.channel_id = ?
       ORDER BY m.seq DESC LIMIT ?`
    ).all(channelId, limit)
    return rows.reverse().map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }

  listMessagesBefore({ channelId, beforeSeq, limit }) {
    const rows = this.db.prepare(
      `SELECT m.msg_id, m.seq, m.user_id, u.display_name AS user_display_name, m.ts, m.text, m.attachments_json
       FROM messages m LEFT JOIN users u ON m.user_id = u.user_id
       WHERE m.channel_id = ? AND m.seq < ?
       ORDER BY m.seq DESC LIMIT ?`
    ).all(channelId, beforeSeq, limit)
    return rows.reverse().map(r => ({
      ...r,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : [],
      attachments_json: undefined,
    }))
  }
}
