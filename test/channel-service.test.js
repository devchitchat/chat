import { test, expect, beforeEach } from 'bun:test'
import { ChannelService } from '../src/services/ChannelService.js'
import { InMemoryChannelRepository } from '../src/adapters/InMemoryChannelRepository.js'
import { ServiceError } from '../src/util/errors.js'

let repo, service

beforeEach(() => {
  repo = new InMemoryChannelRepository()
  service = new ChannelService({ channelRepo: repo, nowFn: () => 1000 })
})

test('createChannel returns channel with generated id', () => {
  const ch = service.createChannel({ kind: 'text', name: 'general', createdByUserId: 'u1' })
  expect(ch.channel_id).toMatch(/^c_/)
  expect(ch.name).toBe('general')
  expect(ch.kind).toBe('text')
})

test('createChannel throws BAD_REQUEST for invalid kind', () => {
  expect(() => service.createChannel({ kind: 'video', name: 'x', createdByUserId: 'u1' })).toThrow(ServiceError)
})

test('isMember returns true after createChannel for owner', () => {
  const ch = service.createChannel({ kind: 'text', name: 'general', createdByUserId: 'u1' })
  expect(service.isMember(ch.channel_id, 'u1')).toBe(true)
})

test('joinChannel adds public channel membership', () => {
  const ch = service.createChannel({ kind: 'text', name: 'pub', visibility: 'public', createdByUserId: 'u1' })
  service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(true)
})

test('joinChannel throws FORBIDDEN for private channel when not pre-added', () => {
  const ch = service.createChannel({ kind: 'text', name: 'secret', visibility: 'private', createdByUserId: 'u1' })
  expect(() => service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })).toThrow(ServiceError)
})

test('leaveChannel removes membership', () => {
  const ch = service.createChannel({ kind: 'text', name: 'pub', createdByUserId: 'u1' })
  service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })
  service.leaveChannel({ channelId: ch.channel_id, userId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(false)
})

test('listChannelMembers returns active members only', () => {
  const ch = service.createChannel({ kind: 'text', name: 'pub', createdByUserId: 'u1' })
  service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })
  service.leaveChannel({ channelId: ch.channel_id, userId: 'u2' })
  const members = service.listChannelMembers(ch.channel_id)
  expect(members.length).toBe(1)
  expect(members[0].user_id).toBe('u1')
})

test('addMember fails when requester has no permission', () => {
  const ch = service.createChannel({ kind: 'text', name: 'priv', visibility: 'private', createdByUserId: 'u1' })
  expect(() => service.addMember({ channelId: ch.channel_id, requestingUserId: 'u2', requestingRoles: [], targetUserId: 'u3' })).toThrow(ServiceError)
})

test('addMember succeeds when requester is the channel creator', () => {
  const ch = service.createChannel({ kind: 'text', name: 'priv', visibility: 'private', createdByUserId: 'u1' })
  service.addMember({ channelId: ch.channel_id, requestingUserId: 'u1', requestingRoles: [], targetUserId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(true)
})

test('addMember succeeds when requester is admin', () => {
  const ch = service.createChannel({ kind: 'text', name: 'priv', visibility: 'private', createdByUserId: 'u1' })
  service.addMember({ channelId: ch.channel_id, requestingUserId: 'u99', requestingRoles: ['admin'], targetUserId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(true)
})

test('ensureDefaultChannel is idempotent', () => {
  const a = service.ensureDefaultChannel('u1')
  const b = service.ensureDefaultChannel('u1')
  expect(a.channel_id).toBe(b.channel_id)
})

test('updateChannel patches name', () => {
  const ch = service.createChannel({ kind: 'text', name: 'old', createdByUserId: 'u1' })
  const updated = service.updateChannel({ channelId: ch.channel_id, userId: 'u1', name: 'new' })
  expect(updated.name).toBe('new')
})

test('deleteChannel soft-deletes', () => {
  const ch = service.createChannel({ kind: 'text', name: 'bye', createdByUserId: 'u1' })
  service.deleteChannel({ channelId: ch.channel_id, userId: 'u1' })
  expect(service.getChannel(ch.channel_id).deleted_at).not.toBeNull()
})
