import { newId } from '../util/ids.js'

export class SqliteDeliveryRepository {
  constructor({ db }) {
    this.db = db
  }

  findByChannelAndUser({ channelId, userId }) {
    return this.db.prepare('SELECT * FROM deliveries WHERE channel_id = ? AND user_id = ?').get(channelId, userId) ?? null
  }

  create({ channelId, userId, now }) {
    const deliveryId = newId('del')
    this.db.prepare(
      `INSERT INTO deliveries (delivery_id, user_id, channel_id, after_seq, last_delivered_at, status) VALUES (?, ?, ?, 0, ?, 'active')`
    ).run(deliveryId, userId, channelId, now)
    return this.db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').get(deliveryId)
  }

  advance({ channelId, userId, afterSeq, now }) {
    this.db.prepare(
      `UPDATE deliveries
       SET after_seq = ?, last_delivered_at = ?,
           mention_seq = CASE WHEN mention_seq > 0 AND mention_seq <= ? THEN 0 ELSE mention_seq END
       WHERE channel_id = ? AND user_id = ?`
    ).run(afterSeq, now, afterSeq, channelId, userId)
  }

  advanceMention({ channelId, userId, mentionSeq, priority = 'normal' }) {
    this.db.prepare(
      `UPDATE deliveries SET mention_seq = ?, mention_priority = ?
       WHERE channel_id = ? AND user_id = ? AND mention_seq < ?`
    ).run(mentionSeq, priority, channelId, userId, mentionSeq)
  }

  buildDigestData({ userId }) {
    return this.db.prepare(
      `SELECT
         d.channel_id, c.name, c.kind, d.after_seq, d.mention_seq, d.mention_priority,
         COALESCE(
           (SELECT MAX(seq) FROM messages WHERE channel_id = d.channel_id AND deleted_at IS NULL),
           0
         ) AS max_seq,
         (SELECT cm2.user_id FROM channel_members cm2
          WHERE cm2.channel_id = c.channel_id AND cm2.user_id != d.user_id
            AND cm2.left_at IS NULL AND c.kind = 'dm'
          LIMIT 1) AS other_user_id
       FROM deliveries d
       JOIN channels c ON d.channel_id = c.channel_id AND c.deleted_at IS NULL
       WHERE d.user_id = ?`
    ).all(userId)
  }
}
