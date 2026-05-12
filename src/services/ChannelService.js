import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'
import { buildDmChannelName } from '../core/dm.js'

export class ChannelService {
  constructor({ channelRepo, hubService, nowFn = () => Date.now() }) {
    this.channelRepo = channelRepo
    this.hubService = hubService
    this.nowFn = nowFn
  }

  createChannel({ hubId, kind, name, topic = null, visibility = 'public', createdByUserId, userRoles = [] }) {
    if (!['text', 'voice'].includes(kind)) throw new ServiceError('BAD_REQUEST', 'Invalid channel kind')
    if (!name?.trim()) throw new ServiceError('BAD_REQUEST', 'Channel name required')
    if (!this.hubService.canAccessHub(hubId, createdByUserId, userRoles)) throw new ServiceError('FORBIDDEN', 'Cannot access hub')

    const channelId = newId('c')
    const now = this.nowFn()

    this.channelRepo.insertChannelWithOwner({ channelId, hubId, kind, name: name.trim(), topic, visibility, createdByUserId, now })

    return { channel_id: channelId, hub_id: hubId, kind, name: name.trim(), topic, visibility }
  }

  listChannels(userId, userRoles = [], hubId = null) {
    const isAdmin = userRoles.includes('admin')
    const isGuest = userRoles.includes('guest')
    if (hubId) {
      return isAdmin
        ? this.channelRepo.listInHub({ hubId })
        : this.channelRepo.listAccessibleInHub({ hubId, userId, isGuest })
    }
    return isAdmin
      ? this.channelRepo.listAll()
      : this.channelRepo.listAccessible({ userId, isGuest })
  }

  joinChannel({ channelId, userId, userRoles = [] }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    if (channel.hub_id !== null && !this.hubService.canAccessHub(channel.hub_id, userId, userRoles)) throw new ServiceError('FORBIDDEN', 'Cannot access hub')

    if (channel.visibility === 'private') {
      const member = this.getMembership(channelId, userId)
      if (!member || member.left_at || member.banned_at) throw new ServiceError('FORBIDDEN', 'Not a member of this channel')
      return { channel_id: channelId, kind: channel.kind }
    }

    this.channelRepo.upsertMembership({ channelId, userId, role: 'member', now: this.nowFn() })
    return { channel_id: channelId, kind: channel.kind }
  }

  leaveChannel({ channelId, userId }) {
    const channel = this.getChannel(channelId)
    // DM channels have permanent membership — leaving only unsubscribes the WS topic,
    // not the DB row, so the user can rejoin and still access history.
    if (channel?.kind !== 'dm') {
      this.channelRepo.setMemberLeft({ channelId, userId, now: this.nowFn() })
    }
    return { channel_id: channelId }
  }

  isMember(channelId, userId) {
    const member = this.getMembership(channelId, userId)
    return !!member && !member.left_at && !member.banned_at
  }

  canAccessChannel(channelId, userId, roles = []) {
    if (roles.includes('admin')) return true
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) return false
    // DM channels (hub_id = null) skip the hub access check — membership is the sole gate
    if (channel.hub_id !== null && !this.hubService.canAccessHub(channel.hub_id, userId, roles)) return false
    if (channel.visibility === 'public' && !roles.includes('guest')) return true
    return this.isMember(channelId, userId)
  }

  listChannelMembers(channelId) {
    return this.channelRepo.listActiveMembers({ channelId })
  }

  addMember({ channelId, createdByUserId, targetUserId }) {
    const adder = this.getMembership(channelId, createdByUserId)
    if (!adder || !['owner', 'mod'].includes(adder.role)) throw new ServiceError('FORBIDDEN', 'Only owner or mod can add members')
    const channel = this.getChannel(channelId)
    if (!channel) throw new ServiceError('NOT_FOUND', 'Channel not found')
    const existing = this.getMembership(channelId, targetUserId)
    if (existing && !existing.left_at && !existing.banned_at) throw new ServiceError('BAD_REQUEST', 'User is already a member')

    this.channelRepo.upsertMembership({ channelId, userId: targetUserId, role: 'member', now: this.nowFn() })

    return { channel_id: channelId, user_id: targetUserId }
  }

  getChannel(channelId) {
    return this.channelRepo.findById({ channelId })
  }

  getMembership(channelId, userId) {
    return this.channelRepo.findMembership({ channelId, userId })
  }

  findOrCreateDm({ userId, targetUserId }) {
    if (userId === targetUserId) throw new ServiceError('BAD_REQUEST', 'Cannot DM yourself')
    const name = buildDmChannelName(userId, targetUserId)
    const existing = this.channelRepo.findDmByName({ name })
    if (existing) return { channel_id: existing.channel_id, is_new: false }
    const channelId = newId('c')
    this.channelRepo.insertDmChannel({ channelId, name, userIdA: userId, userIdB: targetUserId, now: this.nowFn() })
    return { channel_id: channelId, is_new: true }
  }

  listDms({ userId }) {
    return this.channelRepo.listDmsByUser({ userId })
  }

  ensureDefaultChannel(hubId, createdByUserId) {
    const existing = this.channelRepo.findByHubAndName({ hubId, name: 'general' })
    if (existing) return existing
    return this.createChannel({ hubId, kind: 'text', name: 'general', topic: 'General discussions', visibility: 'public', createdByUserId, userRoles: ['admin'] })
  }

  updateChannel({ channelId, userId, roles = [], name = null, topic = null, visibility = null }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    const membership = this.getMembership(channelId, userId)
    const isOwner = membership && membership.role === 'owner' && !membership.left_at && !membership.banned_at
    if (!roles.includes('admin') && channel.created_by_user_id !== userId && !isOwner) throw new ServiceError('FORBIDDEN', 'Cannot update channel')
    if (name === null && topic === null && visibility === null) throw new ServiceError('BAD_REQUEST', 'No fields to update')

    const patch = {}
    if (name !== null) {
      if (!name.trim()) throw new ServiceError('BAD_REQUEST', 'Channel name cannot be empty')
      patch.name = name.trim()
    }
    if (topic !== null) patch.topic = topic
    if (visibility !== null) {
      if (!['public', 'private'].includes(visibility)) throw new ServiceError('BAD_REQUEST', 'Channel visibility must be public or private')
      patch.visibility = visibility
    }

    this.channelRepo.patchChannel({ channelId, ...patch })
    return this.getChannel(channelId)
  }

  deleteChannel({ channelId, userId, roles = [] }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    const membership = this.getMembership(channelId, userId)
    const isOwner = membership && membership.role === 'owner' && !membership.left_at && !membership.banned_at
    if (!roles.includes('admin') && channel.created_by_user_id !== userId && !isOwner) throw new ServiceError('FORBIDDEN', 'Cannot delete channel')

    this.channelRepo.softDeleteChannel({ channelId, now: this.nowFn() })
    return { channel_id: channel.channel_id, hub_id: channel.hub_id }
  }

  reorderChannels({ hubId, channelIds, userId, userRoles = [] }) {
    if (!this.hubService.canAccessHub(hubId, userId, userRoles)) throw new ServiceError('FORBIDDEN', 'Cannot access hub')
    if (!Array.isArray(channelIds) || channelIds.length === 0) throw new ServiceError('BAD_REQUEST', 'channelIds must be a non-empty array')
    return this.channelRepo.reorderChannels({ hubId, channelIds })
  }
}
