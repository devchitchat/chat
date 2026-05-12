import { newId } from '../util/ids.js'

export class InMemoryDeliveryRepository {
  constructor() {
    this._store = new Map() // deliveryId → record
  }

  _key(channelId, userId) { return `${channelId}:${userId}` }

  findByChannelAndUser({ channelId, userId }) {
    for (const record of this._store.values()) {
      if (record.channel_id === channelId && record.user_id === userId) return record
    }
    return null
  }

  create({ channelId, userId, now }) {
    const deliveryId = newId('del')
    const record = { delivery_id: deliveryId, user_id: userId, channel_id: channelId, after_seq: 0, mention_seq: 0, last_delivered_at: now, status: 'active' }
    this._store.set(deliveryId, record)
    return { ...record }
  }

  advance({ channelId, userId, afterSeq, now }) {
    for (const record of this._store.values()) {
      if (record.channel_id === channelId && record.user_id === userId) {
        record.after_seq = afterSeq
        record.last_delivered_at = now
        if (record.mention_seq > 0 && record.mention_seq <= afterSeq) record.mention_seq = 0
        return
      }
    }
  }

  advanceMention({ channelId, userId, mentionSeq }) {
    for (const record of this._store.values()) {
      if (record.channel_id === channelId && record.user_id === userId) {
        if ((record.mention_seq ?? 0) < mentionSeq) record.mention_seq = mentionSeq
        return
      }
    }
  }

  buildDigestData({ userId }) {
    return [...this._store.values()]
      .filter(d => d.user_id === userId)
      .map(d => ({ channel_id: d.channel_id, name: d.channel_id, kind: 'text', after_seq: d.after_seq, mention_seq: d.mention_seq ?? 0, max_seq: 0, other_user_id: null }))
  }
}
