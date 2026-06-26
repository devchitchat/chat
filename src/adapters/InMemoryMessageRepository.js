export class InMemoryMessageRepository {
  constructor() {
    this._messages = [] // { msg_id, channel_id, seq, user_id, user_handle, ts, text, client_msg_id, deleted_at, edited_at }
    this._seqs = new Map() // channelId → current max seq
  }

  insertMessage({ msgId, channelId, userId, now, text, clientMsgId }) {
    const seq = (this._seqs.get(channelId) ?? 0) + 1
    this._seqs.set(channelId, seq)
    this._messages.push({ msg_id: msgId, channel_id: channelId, seq, user_id: userId, user_handle: userId, ts: now, text, client_msg_id: clientMsgId, deleted_at: null, edited_at: null })
    return { seq }
  }

  getById(msgId) {
    return this._messages.find(m => m.msg_id === msgId) ?? null
  }

  updateMessage({ msgId, text, editedAt }) {
    const msg = this._messages.find(m => m.msg_id === msgId)
    if (msg) { msg.text = text; msg.edited_at = editedAt }
  }

  deleteMessage({ msgId, deletedAt }) {
    const msg = this._messages.find(m => m.msg_id === msgId)
    if (msg) msg.deleted_at = deletedAt
  }

  listMessages({ channelId, afterSeq, limit }) {
    return this._messages
      .filter(m => m.channel_id === channelId && m.seq > afterSeq && m.deleted_at == null)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(m => ({ msg_id: m.msg_id, seq: m.seq, user_id: m.user_id, user_handle: m.user_handle, ts: m.ts, text: m.text, edited_at: m.edited_at ?? null }))
  }
}
