import { test, expect, beforeEach } from 'bun:test'
import { SearchService } from '../src/services/SearchService.js'
import { InMemorySearchRepository } from '../src/adapters/InMemorySearchRepository.js'

let repo, service

beforeEach(() => {
  repo = new InMemorySearchRepository()
  service = new SearchService({ searchRepo: repo })
})

test('indexMessage and searchMessages returns matching results', () => {
  service.indexMessage({ msg_id: 'm1', channel_id: 'c1', seq: 1, user_id: 'u1', ts: 1000, text: 'hello world' })
  service.indexMessage({ msg_id: 'm2', channel_id: 'c1', seq: 2, user_id: 'u1', ts: 1001, text: 'goodbye' })
  const results = service.searchMessages({ channelId: 'c1', query: 'hello' })
  expect(results.length).toBe(1)
  expect(results[0].msg_id).toBe('m1')
})

test('searchMessages returns empty array when no match', () => {
  service.indexMessage({ msg_id: 'm1', channel_id: 'c1', seq: 1, user_id: 'u1', ts: 1000, text: 'hello' })
  const results = service.searchMessages({ channelId: 'c1', query: 'xyz' })
  expect(results.length).toBe(0)
})

test('searchMessages does not cross channel boundaries', () => {
  service.indexMessage({ msg_id: 'm1', channel_id: 'c1', seq: 1, user_id: 'u1', ts: 1000, text: 'hello' })
  const results = service.searchMessages({ channelId: 'c2', query: 'hello' })
  expect(results.length).toBe(0)
})
