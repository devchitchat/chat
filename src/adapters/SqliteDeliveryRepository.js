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
      `UPDATE deliveries SET after_seq = ?, last_delivered_at = ? WHERE channel_id = ? AND user_id = ?`
    ).run(afterSeq, now, channelId, userId)
  }
}
