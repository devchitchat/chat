import { test, expect, beforeEach } from 'bun:test'
import { DeliveryService } from '../src/services/DeliveryService.js'
import { InMemoryDeliveryRepository } from '../src/adapters/InMemoryDeliveryRepository.js'

let repo, service

beforeEach(() => {
  repo = new InMemoryDeliveryRepository()
  service = new DeliveryService({ deliveryRepo: repo, nowFn: () => 1000 })
})

test('getOrCreate creates a new delivery record', () => {
  const d = service.getOrCreate({ channelId: 'c1', userId: 'u1' })
  expect(d.channel_id).toBe('c1')
  expect(d.user_id).toBe('u1')
  expect(d.after_seq).toBe(0)
  expect(d.status).toBe('active')
})

test('getOrCreate returns existing record on second call', () => {
  const a = service.getOrCreate({ channelId: 'c1', userId: 'u1' })
  const b = service.getOrCreate({ channelId: 'c1', userId: 'u1' })
  expect(a.delivery_id).toBe(b.delivery_id)
})

test('advance updates after_seq for the matching record', () => {
  service.getOrCreate({ channelId: 'c1', userId: 'u1' })
  service.advance({ channelId: 'c1', userId: 'u1', afterSeq: 42 })
  const d = service.getOrCreate({ channelId: 'c1', userId: 'u1' })
  expect(d.after_seq).toBe(42)
})
