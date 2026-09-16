import { newId } from '../util/ids.js'
import { ServiceError } from '../util/errors.js'
import { buildDmChannelName } from '../core/dm.js'

export class ChannelService {
  constructor({ channelRepo, nowFn = () => Date.now() }) {
    this.channelRepo = channelRepo
    this.nowFn = nowFn
  }

  createChannel({ kind, name, topic = null, visibility = 'public', sessionEndsAt = null, createdByUserId }) {
    if (!['text', 'voice', 'session'].includes(kind)) throw new ServiceError('BAD_REQUEST', 'Invalid channel kind')
    if (!name?.trim()) throw new ServiceError('BAD_REQUEST', 'Channel name required')

    const channelId = newId('c')
    const now = this.nowFn()

    this.channelRepo.insertChannelWithOwner({ channelId, kind, name: name.trim(), topic, visibility, sessionEndsAt, createdByUserId, now })

    return { channel_id: channelId, kind, name: name.trim(), topic, visibility, session_ends_at: sessionEndsAt }
  }

  listChannels(userId, userRoles = []) {
    const isAdmin = userRoles.includes('admin')
    const isGuest = userRoles.includes('guest')
    return isAdmin
      ? this.channelRepo.listAll()
      : this.channelRepo.listAccessible({ userId, isGuest })
  }

  joinChannel({ channelId, userId }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')

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
    // DM and private channels have permanent membership — the WS topic unsubscribes
    // but the DB row is preserved. Private channel members cannot re-add themselves,
    // so clearing left_at here would lock them out until an owner re-adds them.
    const isPermanent = channel?.kind === 'dm' || channel?.visibility === 'private'
    if (!isPermanent) {
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
    if (channel.visibility === 'public' && !roles.includes('guest')) return true
    return this.isMember(channelId, userId)
  }

  listChannelMembers(channelId) {
    return this.channelRepo.listActiveMembers({ channelId })
  }

  addMember({ channelId, requestingUserId, requestingRoles = [], targetUserId }) {
    const isAdmin = requestingRoles.includes('admin')
    const channel = this.getChannel(channelId)
    if (!channel) throw new ServiceError('NOT_FOUND', 'Channel not found')
    if (!isAdmin) {
      const adder = this.getMembership(channelId, requestingUserId)
      const isOwnerOrMod = adder && ['owner', 'mod'].includes(adder.role) && !adder.left_at && !adder.banned_at
      const isCreator = channel.created_by_user_id === requestingUserId
      if (!isOwnerOrMod && !isCreator) throw new ServiceError('FORBIDDEN', 'Only admin, owner, or mod can add members')
    }
    const existing = this.getMembership(channelId, targetUserId)
    if (existing && !existing.left_at && !existing.banned_at) throw new ServiceError('BAD_REQUEST', 'User is already a member')

    this.channelRepo.upsertMembership({ channelId, userId: targetUserId, role: 'member', now: this.nowFn() })
    return { channel_id: channelId, user_id: targetUserId }
  }

  removeMember({ channelId, requestingUserId, requestingRoles = [], targetUserId }) {
    const isAdmin = requestingRoles.includes('admin')
    const channel = this.getChannel(channelId)
    if (!channel) throw new ServiceError('NOT_FOUND', 'Channel not found')
    if (!isAdmin) {
      const remover = this.getMembership(channelId, requestingUserId)
      const isOwnerOrMod = remover && ['owner', 'mod'].includes(remover.role) && !remover.left_at && !remover.banned_at
      const isCreator = channel.created_by_user_id === requestingUserId
      if (!isOwnerOrMod && !isCreator) throw new ServiceError('FORBIDDEN', 'Only admin, owner, or mod can remove members')
    }
    if (requestingUserId === targetUserId) throw new ServiceError('BAD_REQUEST', 'Use leaveChannel to leave a channel')
    const target = this.getMembership(channelId, targetUserId)
    if (!target || target.left_at || target.banned_at) throw new ServiceError('BAD_REQUEST', 'User is not a member')

    this.channelRepo.setMemberLeft({ channelId, userId: targetUserId, now: this.nowFn() })

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

  ensureDefaultChannel(createdByUserId) {
    const existing = this.channelRepo.findByName({ name: 'general' })
    if (existing) return existing
    return this.createChannel({ kind: 'text', name: 'general', topic: 'General discussions', visibility: 'public', createdByUserId })
  }

  updateChannel({ channelId, userId, roles = [], name = null, topic = null, visibility = null, sessionEndsAt = undefined }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    const membership = this.getMembership(channelId, userId)
    const isOwner = membership && membership.role === 'owner' && !membership.left_at && !membership.banned_at
    if (!roles.includes('admin') && channel.created_by_user_id !== userId && !isOwner) throw new ServiceError('FORBIDDEN', 'Cannot update channel')
    if (name === null && topic === null && visibility === null && sessionEndsAt === undefined) throw new ServiceError('BAD_REQUEST', 'No fields to update')

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
    if (sessionEndsAt !== undefined) patch.session_ends_at = sessionEndsAt

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
    return { channel_id: channel.channel_id }
  }

  reorderChannels({ channelIds }) {
    if (!Array.isArray(channelIds) || channelIds.length === 0) throw new ServiceError('BAD_REQUEST', 'channelIds must be a non-empty array')
    return this.channelRepo.reorderChannels({ channelIds })
  }
}
