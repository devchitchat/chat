export class InMemorySearchRepository {
  constructor() {
    this._index = [] // { msg_id, channel_id, seq, user_id, ts, text }
    this._ftsEnabled = true
  }

  isFtsEnabled() {
    return this._ftsEnabled
  }

  indexMessage({ msg_id, channel_id, seq, user_id, ts, text }) {
    const existing = this._index.findIndex(r => r.msg_id === msg_id)
    if (existing >= 0) this._index.splice(existing, 1)
    this._index.push({ msg_id, channel_id, seq, user_id, ts, text })
  }

  removeMessage({ msgId }) {
    const i = this._index.findIndex(r => r.msg_id === msgId)
    if (i >= 0) this._index.splice(i, 1)
  }

  searchFts({ channelId, query, limit }) {
    const q = query.toLowerCase()
    return this._index
      .filter(r => r.channel_id === channelId && r.text.toLowerCase().includes(q))
      .slice(0, limit)
      .map(r => ({ ...r, snippet: r.text }))
  }

  searchLike({ channelId, query, limit }) {
    const q = query.toLowerCase()
    return this._index
      .filter(r => r.channel_id === channelId && r.text.toLowerCase().includes(q))
      .slice(0, limit)
      .map(r => ({ ...r, snippet: r.text }))
  }
}
