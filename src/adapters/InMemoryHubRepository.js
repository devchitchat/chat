export class InMemoryHubRepository {
  constructor() {
    this._hubs = new Map()        // hubId → hub record
    this._members = new Map()     // `${hubId}:${userId}` → membership record
  }

  insertHubWithOwner({ hubId, name, description, visibility, createdByUserId, now }) {
    this._hubs.set(hubId, { hub_id: hubId, name, description, visibility, created_by_user_id: createdByUserId, created_at: now, deleted_at: null })
    const key = `${hubId}:${createdByUserId}`
    this._members.set(key, { hub_id: hubId, user_id: createdByUserId, joined_at: now, left_at: null })
  }

  _channelCount(hubId) {
    // Channels are tracked externally — return 0 in isolation
    return 0
  }

  _toPublic(hub) {
    return { hub_id: hub.hub_id, name: hub.name, description: hub.description, visibility: hub.visibility, channel_count: 0 }
  }

  listAllHubs() {
    return [...this._hubs.values()].filter(h => !h.deleted_at).sort((a, b) => a.name.localeCompare(b.name)).map(h => this._toPublic(h))
  }

  listAccessibleHubs({ userId }) {
    return [...this._hubs.values()]
      .filter(h => {
        if (h.deleted_at) return false
        if (h.visibility === 'public') return true
        const m = this._members.get(`${h.hub_id}:${userId}`)
        return m && !m.left_at
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(h => this._toPublic(h))
  }

  findById({ hubId }) {
    return this._hubs.get(hubId) ?? null
  }

  findByName({ name }) {
    return [...this._hubs.values()].find(h => h.name === name && !h.deleted_at) ?? null
  }

  findMembership({ hubId, userId }) {
    return this._members.get(`${hubId}:${userId}`) ?? null
  }

  upsertMembership({ hubId, userId, now }) {
    const key = `${hubId}:${userId}`
    const existing = this._members.get(key)
    if (existing) { existing.left_at = null }
    else { this._members.set(key, { hub_id: hubId, user_id: userId, joined_at: now, left_at: null }) }
  }

  setMemberLeft({ hubId, userId, now }) {
    const m = this._members.get(`${hubId}:${userId}`)
    if (m) m.left_at = now
  }

  listMembers({ hubId }) {
    return [...this._members.values()]
      .filter(m => m.hub_id === hubId && !m.left_at)
      .sort((a, b) => (a.joined_at ?? 0) - (b.joined_at ?? 0))
      .map(m => ({ user_id: m.user_id, handle: null, display_name: null, joined_at: m.joined_at }))
  }

  patchHub({ hubId, name, description, visibility }) {
    const hub = this._hubs.get(hubId)
    if (!hub) return
    if (name !== undefined) hub.name = name
    if (description !== undefined) hub.description = description
    if (visibility !== undefined) hub.visibility = visibility
  }

  listActiveChannelIds({ hubId }) {
    return [] // channels not tracked in HubRepo; test via integration if needed
  }

  softDeleteHub({ hubId, now }) {
    const hub = this._hubs.get(hubId)
    if (hub) hub.deleted_at = now
  }
}
