export class InMemoryChannelRepository {
  constructor() {
    this._channels = new Map()    // channelId → channel record
    this._members = new Map()     // `${channelId}:${userId}` → membership record
    this._invites = new Map()     // tokenHash → invite record
  }

  insertChannelWithOwner({ channelId, hubId, kind, name, topic, visibility, createdByUserId, now }) {
    const nextOrder = [...this._channels.values()]
      .filter(c => c.hub_id === hubId && !c.deleted_at)
      .reduce((max, c) => Math.max(max, c.sort_order ?? 0), -1) + 1
    this._channels.set(channelId, { channel_id: channelId, hub_id: hubId, kind, name, topic, visibility, sort_order: nextOrder, created_by_user_id: createdByUserId, created_at: now, deleted_at: null })
    this._members.set(`${channelId}:${createdByUserId}`, { channel_id: channelId, user_id: createdByUserId, role: 'owner', joined_at: now, left_at: null, banned_at: null })
  }

  _sortOrder(a, b) {
    const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
    return orderDiff !== 0 ? orderDiff : (a.created_at ?? 0) - (b.created_at ?? 0)
  }

  _toPublic(c) {
    return { channel_id: c.channel_id, hub_id: c.hub_id, name: c.name, kind: c.kind, visibility: c.visibility, topic: c.topic, sort_order: c.sort_order ?? 0 }
  }

  listInHub({ hubId }) {
    return [...this._channels.values()]
      .filter(c => c.hub_id === hubId && !c.deleted_at)
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => this._toPublic(c))
  }

  listAccessibleInHub({ hubId, userId }) {
    return [...this._channels.values()]
      .filter(c => {
        if (c.hub_id !== hubId || c.deleted_at) return false
        if (c.visibility === 'public') return true
        const m = this._members.get(`${c.channel_id}:${userId}`)
        return m && !m.left_at && !m.banned_at
      })
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => this._toPublic(c))
  }

  listAll() {
    return [...this._channels.values()]
      .filter(c => !c.deleted_at)
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => ({ ...this._toPublic(c), hub_name: c.hub_id }))
  }

  listAccessible({ userId }) {
    return [...this._channels.values()]
      .filter(c => {
        if (c.deleted_at) return false
        const cm = this._members.get(`${c.channel_id}:${userId}`)
        if (cm && !cm.left_at && !cm.banned_at) return true
        if (c.visibility === 'public') return true
        return false
      })
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => ({ ...this._toPublic(c), hub_name: c.hub_id }))
  }

  findById({ channelId }) {
    return this._channels.get(channelId) ?? null
  }

  findMembership({ channelId, userId }) {
    return this._members.get(`${channelId}:${userId}`) ?? null
  }

  findByHubAndName({ hubId, name }) {
    return [...this._channels.values()].find(c => c.hub_id === hubId && c.name === name && !c.deleted_at) ?? null
  }

  upsertMembership({ channelId, userId, role, now }) {
    const key = `${channelId}:${userId}`
    const existing = this._members.get(key)
    if (existing) { existing.left_at = null; existing.banned_at = null }
    else { this._members.set(key, { channel_id: channelId, user_id: userId, role, joined_at: now, left_at: null, banned_at: null }) }
  }

  setMemberLeft({ channelId, userId, now }) {
    const m = this._members.get(`${channelId}:${userId}`)
    if (m) m.left_at = now
  }

  listActiveMembers({ channelId }) {
    return [...this._members.values()]
      .filter(m => m.channel_id === channelId && !m.left_at && !m.banned_at)
      .map(m => ({ user_id: m.user_id, role: m.role }))
  }

  insertInvite({ inviteId, channelId, tokenHash, createdByUserId, now, expiresAt, maxUses }) {
    this._invites.set(tokenHash, { invite_id: inviteId, channel_id: channelId, token_hash: tokenHash, created_by_user_id: createdByUserId, created_at: now, expires_at: expiresAt, max_uses: maxUses, uses: 0 })
  }

  findInviteByTokenHash({ tokenHash }) {
    return this._invites.get(tokenHash) ?? null
  }

  redeemInvite({ inviteId, channelId, userId, now }) {
    for (const invite of this._invites.values()) {
      if (invite.invite_id === inviteId) { invite.uses += 1; break }
    }
    this.upsertMembership({ channelId, userId, role: 'member', now })
  }

  patchChannel({ channelId, name, topic }) {
    const c = this._channels.get(channelId)
    if (!c) return
    if (name !== undefined) c.name = name
    if (topic !== undefined) c.topic = topic
  }

  softDeleteChannel({ channelId, now }) {
    const c = this._channels.get(channelId)
    if (c) c.deleted_at = now
  }

  reorderChannels({ hubId, channelIds }) {
    channelIds.forEach((channelId, index) => {
      const c = this._channels.get(channelId)
      if (c && c.hub_id === hubId && !c.deleted_at) c.sort_order = index
    })
    return this.listInHub({ hubId })
  }
}
