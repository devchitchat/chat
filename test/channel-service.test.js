import { test, expect, beforeEach } from 'bun:test'
import { ChannelService } from '../src/services/ChannelService.js'
import { InMemoryChannelRepository } from '../src/adapters/InMemoryChannelRepository.js'
import { ServiceError } from '../src/util/errors.js'

// Hub service stub — 'h1' is accessible to all; 'h_restricted' only to 'u1'
const hubService = {
  canAccessHub: (hubId, userId) => hubId === 'h1' || userId === 'u1',
}

let repo, service

beforeEach(() => {
  repo = new InMemoryChannelRepository()
  service = new ChannelService({ channelRepo: repo, hubService, nowFn: () => 1000 })
})

test('createChannel returns channel with generated id', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'general', createdByUserId: 'u1' })
  expect(ch.channel_id).toMatch(/^c_/)
  expect(ch.name).toBe('general')
  expect(ch.kind).toBe('text')
})

test('createChannel throws BAD_REQUEST for invalid kind', () => {
  expect(() => service.createChannel({ hubId: 'h1', kind: 'video', name: 'x', createdByUserId: 'u1' })).toThrow(ServiceError)
})

test('createChannel throws FORBIDDEN when user cannot access hub', () => {
  expect(() => service.createChannel({ hubId: 'h_restricted', kind: 'text', name: 'x', createdByUserId: 'u2' })).toThrow(ServiceError)
})

test('isMember returns true after createChannel for owner', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'general', createdByUserId: 'u1' })
  expect(service.isMember(ch.channel_id, 'u1')).toBe(true)
})

test('joinChannel adds public channel membership', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'pub', visibility: 'public', createdByUserId: 'u1' })
  service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(true)
})

test('joinChannel throws FORBIDDEN for private channel when not pre-added', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'secret', visibility: 'private', createdByUserId: 'u1' })
  expect(() => service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })).toThrow(ServiceError)
})

test('leaveChannel removes membership', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'pub', createdByUserId: 'u1' })
  service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })
  service.leaveChannel({ channelId: ch.channel_id, userId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(false)
})

test('listChannelMembers returns active members only', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'pub', createdByUserId: 'u1' })
  service.joinChannel({ channelId: ch.channel_id, userId: 'u2' })
  service.leaveChannel({ channelId: ch.channel_id, userId: 'u2' })
  const members = service.listChannelMembers(ch.channel_id)
  expect(members.length).toBe(1)
  expect(members[0].user_id).toBe('u1')
})

test('addMember fails when adder is not owner or mod', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'priv', visibility: 'private', createdByUserId: 'u1' })
  expect(() => service.addMember({ channelId: ch.channel_id, createdByUserId: 'u2', targetUserId: 'u3' })).toThrow(ServiceError)
})

test('addMember adds the target user', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'priv', visibility: 'private', createdByUserId: 'u1' })
  service.addMember({ channelId: ch.channel_id, createdByUserId: 'u1', targetUserId: 'u2' })
  expect(service.isMember(ch.channel_id, 'u2')).toBe(true)
})


test('ensureDefaultChannel is idempotent', () => {
  const a = service.ensureDefaultChannel('h1', 'u1')
  const b = service.ensureDefaultChannel('h1', 'u1')
  expect(a.channel_id).toBe(b.channel_id)
})

test('updateChannel patches name', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'old', createdByUserId: 'u1' })
  const updated = service.updateChannel({ channelId: ch.channel_id, userId: 'u1', name: 'new' })
  expect(updated.name).toBe('new')
})

test('deleteChannel soft-deletes', () => {
  const ch = service.createChannel({ hubId: 'h1', kind: 'text', name: 'bye', createdByUserId: 'u1' })
  service.deleteChannel({ channelId: ch.channel_id, userId: 'u1' })
  expect(service.getChannel(ch.channel_id).deleted_at).not.toBeNull()
})
