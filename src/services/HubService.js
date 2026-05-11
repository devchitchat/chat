import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'

export class HubService {
  constructor({ hubRepo, nowFn = () => Date.now() }) {
    this.hubRepo = hubRepo
    this.nowFn = nowFn
  }

  createHub({ name, description = null, visibility = 'public', createdByUserId }) {
    if (!['public', 'restricted'].includes(visibility)) throw new ServiceError('BAD_REQUEST', 'Invalid hub visibility')
    if (!name?.trim()) throw new ServiceError('BAD_REQUEST', 'Hub name required')
    const hubId = newId('h')
    const now = this.nowFn()

    this.hubRepo.insertHubWithOwner({ hubId, name: name.trim(), description, visibility, createdByUserId, now })

    return { hub_id: hubId, name: name.trim(), description, visibility }
  }

  listHubs(userId, roles = []) {
    if (roles.includes('admin')) return this.hubRepo.listAllHubs()
    return this.hubRepo.listAccessibleHubs({ userId })
  }

  canAccessHub(hubId, userId, roles = []) {
    if (roles.includes('admin')) return true
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) return false
    if (hub.visibility === 'public') return true
    const member = this.getHubMembership(hubId, userId)
    return !!member && !member.left_at
  }

  getHub(hubId) {
    return this.hubRepo.findById({ hubId })
  }

  getHubMembership(hubId, userId) {
    return this.hubRepo.findMembership({ hubId, userId })
  }

  joinHub(hubId, userId) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    this.hubRepo.upsertMembership({ hubId, userId, now: this.nowFn() })
    return { hub_id: hubId }
  }

  leaveHub(hubId, userId) {
    this.hubRepo.setMemberLeft({ hubId, userId, now: this.nowFn() })
    return { hub_id: hubId }
  }

  ensureDefaultHub(createdByUserId) {
    const existing = this.hubRepo.findByName({ name: 'Lobby' })
    if (existing) return existing
    return this.createHub({ name: 'Lobby', description: 'Main hub for general discussions', visibility: 'public', createdByUserId })
  }

  updateHub({ hubId, userId, roles = [], name = null, description = null }) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    if (!roles.includes('admin') && hub.created_by_user_id !== userId) throw new ServiceError('FORBIDDEN', 'Cannot update hub')
    if (name === null && description === null) throw new ServiceError('BAD_REQUEST', 'No fields to update')

    const patch = {}
    if (name !== null) {
      if (!name.trim()) throw new ServiceError('BAD_REQUEST', 'Hub name cannot be empty')
      patch.name = name.trim()
    }
    if (description !== null) patch.description = description

    this.hubRepo.patchHub({ hubId, ...patch })
    return this.getHub(hubId)
  }

  deleteHub({ hubId, userId, roles = [] }) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    if (!roles.includes('admin') && hub.created_by_user_id !== userId) throw new ServiceError('FORBIDDEN', 'Cannot delete hub')

    const channelIds = this.hubRepo.listActiveChannelIds({ hubId })
    const now = this.nowFn()
    this.hubRepo.softDeleteHub({ hubId, now })

    return { hub_id: hubId, channel_ids: channelIds }
  }
}
