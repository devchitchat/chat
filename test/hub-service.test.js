import { test, expect, beforeEach } from 'bun:test'
import { HubService } from '../src/services/HubService.js'
import { InMemoryHubRepository } from '../src/adapters/InMemoryHubRepository.js'
import { ServiceError } from '../src/util/errors.js'

let repo, service

beforeEach(() => {
  repo = new InMemoryHubRepository()
  service = new HubService({ hubRepo: repo, nowFn: () => 1000 })
})

test('createHub returns hub with generated id', () => {
  const hub = service.createHub({ name: 'Engineering', createdByUserId: 'u1' })
  expect(hub.hub_id).toMatch(/^h_/)
  expect(hub.name).toBe('Engineering')
  expect(hub.visibility).toBe('public')
})

test('createHub throws BAD_REQUEST for empty name', () => {
  expect(() => service.createHub({ name: '', createdByUserId: 'u1' })).toThrow(ServiceError)
})

test('createHub throws BAD_REQUEST for invalid visibility', () => {
  expect(() => service.createHub({ name: 'X', visibility: 'secret', createdByUserId: 'u1' })).toThrow(ServiceError)
})

test('listHubs returns only public hubs to non-member', () => {
  service.createHub({ name: 'Public', visibility: 'public', createdByUserId: 'u1' })
  service.createHub({ name: 'Restricted', visibility: 'restricted', createdByUserId: 'u1' })
  const hubs = service.listHubs('u2')
  expect(hubs.length).toBe(1)
  expect(hubs[0].name).toBe('Public')
})

test('listHubs returns all hubs to admin', () => {
  service.createHub({ name: 'Public', visibility: 'public', createdByUserId: 'u1' })
  service.createHub({ name: 'Restricted', visibility: 'restricted', createdByUserId: 'u1' })
  const hubs = service.listHubs('u2', ['admin'])
  expect(hubs.length).toBe(2)
})

test('canAccessHub returns true for public hub', () => {
  const hub = service.createHub({ name: 'Public', visibility: 'public', createdByUserId: 'u1' })
  expect(service.canAccessHub(hub.hub_id, 'u2')).toBe(true)
})

test('canAccessHub returns false for restricted hub when not a member', () => {
  const hub = service.createHub({ name: 'Restricted', visibility: 'restricted', createdByUserId: 'u1' })
  expect(service.canAccessHub(hub.hub_id, 'u2')).toBe(false)
})

test('joinHub and leaveHub update membership', () => {
  const hub = service.createHub({ name: 'Restricted', visibility: 'restricted', createdByUserId: 'u1' })
  service.joinHub(hub.hub_id, 'u2')
  expect(service.canAccessHub(hub.hub_id, 'u2')).toBe(true)
  service.leaveHub(hub.hub_id, 'u2')
  expect(service.canAccessHub(hub.hub_id, 'u2')).toBe(false)
})

test('ensureDefaultHub creates Lobby once', () => {
  const a = service.ensureDefaultHub('u1')
  const b = service.ensureDefaultHub('u1')
  expect(a.hub_id).toBe(b.hub_id)
  expect(a.name).toBe('Lobby')
})

test('updateHub patches name', () => {
  const hub = service.createHub({ name: 'Old Name', createdByUserId: 'u1' })
  const updated = service.updateHub({ hubId: hub.hub_id, userId: 'u1', name: 'New Name' })
  expect(updated.name).toBe('New Name')
})

test('updateHub throws FORBIDDEN when user is not owner', () => {
  const hub = service.createHub({ name: 'Mine', createdByUserId: 'u1' })
  expect(() => service.updateHub({ hubId: hub.hub_id, userId: 'u2', name: 'Stolen' })).toThrow(ServiceError)
})

test('deleteHub throws FORBIDDEN when user is not owner', () => {
  const hub = service.createHub({ name: 'Mine', createdByUserId: 'u1' })
  expect(() => service.deleteHub({ hubId: hub.hub_id, userId: 'u2' })).toThrow(ServiceError)
})

test('deleteHub soft-deletes the hub', () => {
  const hub = service.createHub({ name: 'ToDelete', createdByUserId: 'u1' })
  service.deleteHub({ hubId: hub.hub_id, userId: 'u1' })
  const found = service.getHub(hub.hub_id)
  expect(found.deleted_at).toBeDefined()
  expect(found.deleted_at).not.toBeNull()
})
