import { test, expect, beforeEach } from 'bun:test'
import { MessageService } from '../src/services/MessageService.js'
import { InMemoryMessageRepository } from '../src/adapters/InMemoryMessageRepository.js'
import { InMemorySearchRepository } from '../src/adapters/InMemorySearchRepository.js'
import { SearchService } from '../src/services/SearchService.js'
import { ServiceError } from '../src/util/errors.js'

// Minimal channel service stub — member list controlled per test
function makeChannelService(members = new Set()) {
  return { isMember: (channelId, userId) => members.has(userId) }
}

let messageRepo, searchRepo, searchService, service

beforeEach(() => {
  messageRepo = new InMemoryMessageRepository()
  searchRepo = new InMemorySearchRepository()
  searchService = new SearchService({ searchRepo })
  service = new MessageService({
    messageRepo,
    nowFn: () => 1000,
    channelService: makeChannelService(new Set(['u1', 'u2'])),
    searchService,
  })
})

test('sendMessage returns msg_id, seq, ts', () => {
  const result = service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'hello' })
  expect(result.msg_id).toMatch(/^m_/)
  expect(result.seq).toBe(1)
  expect(result.ts).toBe(1000)
})

test('sendMessage increments seq per channel', () => {
  const a = service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'first' })
  const b = service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'second' })
  expect(b.seq).toBe(a.seq + 1)
})

test('sendMessage indexes the message for search', () => {
  service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'unique token xyz' })
  const results = searchService.searchMessages({ channelId: 'c1', query: 'xyz' })
  expect(results.length).toBe(1)
})

test('sendMessage throws FORBIDDEN when user is not a member', () => {
  expect(() => service.sendMessage({ channelId: 'c1', userId: 'outsider', text: 'hi' }))
    .toThrow(ServiceError)
})

test('sendMessage throws BAD_REQUEST for empty text', () => {
  expect(() => service.sendMessage({ channelId: 'c1', userId: 'u1', text: '   ' }))
    .toThrow(ServiceError)
})

test('listMessages returns messages in seq order after afterSeq', () => {
  service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'one' })
  service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'two' })
  service.sendMessage({ channelId: 'c1', userId: 'u1', text: 'three' })

  const { messages, next_after_seq } = service.listMessages({ channelId: 'c1', userId: 'u1', afterSeq: 1 })
  expect(messages.length).toBe(2)
  expect(messages[0].text).toBe('two')
  expect(next_after_seq).toBe(3)
})
