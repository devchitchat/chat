export class InMemorySearchRepository {
  constructor() {
    this._index = [] // { msg_id, channel_id, seq, user_id, ts, text }
    this._ftsEnabled = true
  }

  isFtsEnabled() {
    return this._ftsEnabled
  }

  indexMessage({ msg_id, channel_id, seq, user_id, ts, text }) {
    this._index.push({ msg_id, channel_id, seq, user_id, ts, text })
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
