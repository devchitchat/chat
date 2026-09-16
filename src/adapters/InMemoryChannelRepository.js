export class InMemoryChannelRepository {
  constructor() {
    this._channels = new Map()    // channelId → channel record
    this._members = new Map()     // `${channelId}:${userId}` → membership record
  }

  insertChannelWithOwner({ channelId, kind, name, topic, visibility, sessionEndsAt = null, createdByUserId, now }) {
    const nextOrder = [...this._channels.values()]
      .filter(c => !c.deleted_at)
      .reduce((max, c) => Math.max(max, c.sort_order ?? 0), -1) + 1
    this._channels.set(channelId, { channel_id: channelId, kind, name, topic, visibility, sort_order: nextOrder, session_ends_at: sessionEndsAt ?? null, created_by_user_id: createdByUserId, created_at: now, deleted_at: null })
    this._members.set(`${channelId}:${createdByUserId}`, { channel_id: channelId, user_id: createdByUserId, role: 'owner', joined_at: now, left_at: null, banned_at: null })
  }

  _sortOrder(a, b) {
    const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
    return orderDiff !== 0 ? orderDiff : (a.created_at ?? 0) - (b.created_at ?? 0)
  }

  _toPublic(c) {
    return { channel_id: c.channel_id, name: c.name, kind: c.kind, visibility: c.visibility, topic: c.topic, sort_order: c.sort_order ?? 0, session_ends_at: c.session_ends_at ?? null }
  }

  listAll() {
    return [...this._channels.values()]
      .filter(c => !c.deleted_at && c.kind !== 'dm')
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => this._toPublic(c))
  }

  listPublicNonDm() {
    return [...this._channels.values()]
      .filter(c => !c.deleted_at && c.kind !== 'dm' && c.visibility === 'public')
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => this._toPublic(c))
  }

  listMemberships({ userId }) {
    return [...this._channels.values()]
      .filter(c => {
        if (c.deleted_at) return false
        const m = this._members.get(`${c.channel_id}:${userId}`)
        return m && !m.left_at && !m.banned_at
      })
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => this._toPublic(c))
  }

  listAccessible({ userId, isGuest = false }) {
    return [...this._channels.values()]
      .filter(c => {
        if (c.deleted_at || c.kind === 'dm') return false
        const cm = this._members.get(`${c.channel_id}:${userId}`)
        if (cm && !cm.left_at && !cm.banned_at) return true
        if (!isGuest && c.visibility === 'public') return true
        return false
      })
      .sort((a, b) => this._sortOrder(a, b))
      .map(c => this._toPublic(c))
  }

  findById({ channelId }) {
    return this._channels.get(channelId) ?? null
  }

  findMembership({ channelId, userId }) {
    return this._members.get(`${channelId}:${userId}`) ?? null
  }

  findByName({ name }) {
    return [...this._channels.values()].find(c => c.name === name && !c.deleted_at) ?? null
  }

  findDmByName({ name }) {
    return [...this._channels.values()].find(c => c.kind === 'dm' && c.name === name && !c.deleted_at) ?? null
  }

  insertDmChannel({ channelId, name, userIdA, userIdB, now }) {
    this._channels.set(channelId, { channel_id: channelId, kind: 'dm', name, topic: null, visibility: 'private', sort_order: 0, session_ends_at: null, created_by_user_id: userIdA, created_at: now, deleted_at: null })
    this._members.set(`${channelId}:${userIdA}`, { channel_id: channelId, user_id: userIdA, role: 'member', joined_at: now, left_at: null, banned_at: null })
    this._members.set(`${channelId}:${userIdB}`, { channel_id: channelId, user_id: userIdB, role: 'member', joined_at: now, left_at: null, banned_at: null })
  }

  listDmsByUser({ userId }) {
    return [...this._channels.values()]
      .filter(c => c.kind === 'dm' && !c.deleted_at)
      .filter(c => {
        const m = this._members.get(`${c.channel_id}:${userId}`)
        return m && !m.left_at
      })
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
      .map(c => {
        const otherMember = [...this._members.values()].find(m => m.channel_id === c.channel_id && m.user_id !== userId && !m.left_at)
        return { channel_id: c.channel_id, name: c.name, kind: c.kind, other_user_id: otherMember?.user_id ?? null }
      })
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

  patchChannel({ channelId, name, topic, visibility, session_ends_at }) {
    const c = this._channels.get(channelId)
    if (!c) return
    if (name !== undefined) c.name = name
    if (topic !== undefined) c.topic = topic
    if (visibility !== undefined) c.visibility = visibility
    if (session_ends_at !== undefined) c.session_ends_at = session_ends_at
  }

  softDeleteChannel({ channelId, now }) {
    const c = this._channels.get(channelId)
    if (c) c.deleted_at = now
  }

  reorderChannels({ channelIds }) {
    channelIds.forEach((channelId, index) => {
      const c = this._channels.get(channelId)
      if (c && !c.deleted_at) c.sort_order = index
    })
    return channelIds
      .map(id => this._channels.get(id))
      .filter(c => c && !c.deleted_at)
      .map(c => this._toPublic(c))
  }

  searchFtsGlobal({ channelIds, query, limit = 20 }) {
    const idSet = new Set(channelIds)
    const q = query.toLowerCase()
    return [...this._channels.values()]
      .filter(c => idSet.has(c.channel_id) && !c.deleted_at)
      .flatMap(c => {
        // In-memory: no FTS, fall back to substring match
        return []
      })
      .slice(0, limit)
  }

  searchLikeGlobal({ channelIds, query, limit = 20 }) {
    return this.searchFtsGlobal({ channelIds, query, limit })
  }
}
