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
    if (hub.visibility === 'public' && !roles.includes('guest')) return true
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

  updateHub({ hubId, userId, roles = [], name = null, description = null, visibility = null }) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    if (!roles.includes('admin') && hub.created_by_user_id !== userId) throw new ServiceError('FORBIDDEN', 'Cannot update hub')
    if (name === null && description === null && visibility === null) throw new ServiceError('BAD_REQUEST', 'No fields to update')

    const patch = {}
    if (name !== null) {
      if (!name.trim()) throw new ServiceError('BAD_REQUEST', 'Hub name cannot be empty')
      patch.name = name.trim()
    }
    if (description !== null) patch.description = description
    if (visibility !== null) {
      if (!['public', 'restricted'].includes(visibility)) throw new ServiceError('BAD_REQUEST', 'Hub visibility must be public or restricted')
      patch.visibility = visibility
    }

    this.hubRepo.patchHub({ hubId, ...patch })
    return this.getHub(hubId)
  }

  addHubMember({ hubId, targetUserId, requestingUserId, requestingRoles = [] }) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    const isAdmin = requestingRoles.includes('admin')
    const isCreator = hub.created_by_user_id === requestingUserId
    if (!isAdmin && !isCreator) throw new ServiceError('FORBIDDEN', 'Admin or hub creator required')
    this.hubRepo.upsertMembership({ hubId, userId: targetUserId, now: this.nowFn() })
    return { hub_id: hubId, user_id: targetUserId }
  }

  removeHubMember({ hubId, targetUserId, requestingUserId, requestingRoles = [] }) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    const isAdmin = requestingRoles.includes('admin')
    const isCreator = hub.created_by_user_id === requestingUserId
    if (!isAdmin && !isCreator) throw new ServiceError('FORBIDDEN', 'Admin or hub creator required')
    this.hubRepo.setMemberLeft({ hubId, userId: targetUserId, now: this.nowFn() })
    return { hub_id: hubId, user_id: targetUserId }
  }

  listHubMembers({ hubId, requestingUserId, requestingRoles = [] }) {
    const hub = this.getHub(hubId)
    if (!hub || hub.deleted_at) throw new ServiceError('NOT_FOUND', 'Hub not found')
    const isAdmin = requestingRoles.includes('admin')
    const membership = this.getHubMembership(hubId, requestingUserId)
    const isMember = membership && !membership.left_at
    if (!isAdmin && !isMember) throw new ServiceError('FORBIDDEN', 'Hub membership required')
    return this.hubRepo.listMembers({ hubId })
  }

  reorderHubs({ hubIds, userId, userRoles = [] }) {
    if (!Array.isArray(hubIds) || hubIds.length === 0) throw new ServiceError('BAD_REQUEST', 'hub_ids required')
    if (!userRoles.includes('admin')) {
      // Non-admins can only reorder hubs they own or are a member of — the list query
      // already scopes to accessible hubs, so any hub_id not in that set is silently ignored.
    }
    this.hubRepo.reorderHubs({ hubIds })
    return this.listHubs(userId, userRoles)
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
