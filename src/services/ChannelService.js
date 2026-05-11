import { newId } from '../util/ids.js'
import { hashToken, randomToken } from '../util/crypto.js'
import { ServiceError } from '../util/errors.js'

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
    if (hubId) {
      return isAdmin
        ? this.channelRepo.listInHub({ hubId })
        : this.channelRepo.listAccessibleInHub({ hubId, userId })
    }
    return isAdmin
      ? this.channelRepo.listAll()
      : this.channelRepo.listAccessible({ userId })
  }

  joinChannel({ channelId, userId, userRoles = [] }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    if (!this.hubService.canAccessHub(channel.hub_id, userId, userRoles)) throw new ServiceError('FORBIDDEN', 'Cannot access hub')

    if (channel.visibility === 'private') {
      const member = this.getMembership(channelId, userId)
      if (!member || member.left_at || member.banned_at) throw new ServiceError('FORBIDDEN', 'Not a member of this channel')
      return { channel_id: channelId, kind: channel.kind }
    }

    this.channelRepo.upsertMembership({ channelId, userId, role: 'member', now: this.nowFn() })
    return { channel_id: channelId, kind: channel.kind }
  }

  leaveChannel({ channelId, userId }) {
    this.channelRepo.setMemberLeft({ channelId, userId, now: this.nowFn() })
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
    if (!this.hubService.canAccessHub(channel.hub_id, userId, roles)) return false
    if (channel.visibility === 'public') return true
    return this.isMember(channelId, userId)
  }

  listChannelMembers(channelId) {
    return this.channelRepo.listActiveMembers({ channelId })
  }

  createChannelInvite({ channelId, createdByUserId, ttlMs = 24 * 60 * 60 * 1000, maxUses = 1 }) {
    const member = this.getMembership(channelId, createdByUserId)
    if (!member || !['owner', 'mod'].includes(member.role)) throw new ServiceError('FORBIDDEN', 'Channel invite requires owner or mod')
    const channel = this.getChannel(channelId)
    if (!channel || channel.visibility !== 'private') throw new ServiceError('BAD_REQUEST', 'Invites are only for private channels')

    const inviteToken = randomToken()
    const inviteId = newId('cinvite')
    const now = this.nowFn()

    this.channelRepo.insertInvite({ inviteId, channelId, tokenHash: hashToken(inviteToken), createdByUserId, now, expiresAt: now + ttlMs, maxUses })

    return { inviteToken, inviteId, expiresAt: now + ttlMs, maxUses }
  }

  redeemChannelInvite({ inviteToken, userId }) {
    const invite = this.channelRepo.findInviteByTokenHash({ tokenHash: hashToken(inviteToken) })
    const now = this.nowFn()
    if (!invite) throw new ServiceError('NOT_FOUND', 'Invite not found')
    if (invite.expires_at <= now) throw new ServiceError('BAD_REQUEST', 'Invite expired')
    if (invite.uses >= invite.max_uses) throw new ServiceError('BAD_REQUEST', 'Invite already used')

    this.channelRepo.redeemInvite({ inviteId: invite.invite_id, channelId: invite.channel_id, userId, now })

    return { channel_id: invite.channel_id }
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

  ensureDefaultChannel(hubId, createdByUserId) {
    const existing = this.channelRepo.findByHubAndName({ hubId, name: 'general' })
    if (existing) return existing
    return this.createChannel({ hubId, kind: 'text', name: 'general', topic: 'General discussions', visibility: 'public', createdByUserId, userRoles: ['admin'] })
  }

  updateChannel({ channelId, userId, roles = [], name = null, topic = null }) {
    const channel = this.getChannel(channelId)
    if (!channel || channel.deleted_at) throw new ServiceError('NOT_FOUND', 'Channel not found')
    const membership = this.getMembership(channelId, userId)
    const isOwner = membership && membership.role === 'owner' && !membership.left_at && !membership.banned_at
    if (!roles.includes('admin') && channel.created_by_user_id !== userId && !isOwner) throw new ServiceError('FORBIDDEN', 'Cannot update channel')
    if (name === null && topic === null) throw new ServiceError('BAD_REQUEST', 'No fields to update')

    const patch = {}
    if (name !== null) {
      if (!name.trim()) throw new ServiceError('BAD_REQUEST', 'Channel name cannot be empty')
      patch.name = name.trim()
    }
    if (topic !== null) patch.topic = topic

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
