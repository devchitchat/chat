import { test, expect, beforeEach } from 'bun:test'
import { ReactionService } from '../src/services/ReactionService.js'
import { InMemoryReactionRepository } from '../src/adapters/InMemoryReactionRepository.js'
import { ServiceError } from '../src/util/errors.js'

function makeChannelService(members = new Set()) {
  return { isMember: (channelId, userId) => members.has(userId) }
}

let reactionRepo, service

beforeEach(() => {
  reactionRepo = new InMemoryReactionRepository()
  service = new ReactionService({
    reactionRepo,
    channelService: makeChannelService(new Set(['u1', 'u2'])),
    nowFn: () => 1000,
  })
})

// ── addReaction ───────────────────────────────────────────────────────────────

test('addReaction returns summary with the new reaction', () => {
  const reactions = service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  expect(reactions).toHaveLength(1)
  expect(reactions[0].emoji).toBe('👍')
  expect(reactions[0].count).toBe(1)
  expect(reactions[0].reacted).toBe(true)
})

test('addReaction by two users increments count', () => {
  service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  const reactions = service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u2', emoji: '👍' })
  expect(reactions[0].count).toBe(2)
})

test('addReaction is idempotent — same user same emoji does not double-count', () => {
  service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  const reactions = service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  expect(reactions[0].count).toBe(1)
})

test('addReaction throws FORBIDDEN for non-member', () => {
  expect(() => service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'outsider', emoji: '👍' }))
    .toThrow(ServiceError)
})

test('addReaction throws BAD_REQUEST for invalid emoji', () => {
  expect(() => service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '' }))
    .toThrow(ServiceError)
})

// ── removeReaction ────────────────────────────────────────────────────────────

test('removeReaction removes the emoji from the summary', () => {
  service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  const reactions = service.removeReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  expect(reactions).toHaveLength(0)
})

test('removeReaction is a no-op when reaction does not exist', () => {
  const reactions = service.removeReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  expect(reactions).toHaveLength(0)
})

test('removeReaction throws FORBIDDEN for non-member', () => {
  expect(() => service.removeReaction({ msgId: 'm1', channelId: 'c1', userId: 'outsider', emoji: '👍' }))
    .toThrow(ServiceError)
})

// ── toggle (add then remove) ──────────────────────────────────────────────────

test('toggle: add then remove returns empty reactions', () => {
  service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '❤️' })
  const reactions = service.removeReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '❤️' })
  expect(reactions).toHaveLength(0)
})

// ── reaction cap ──────────────────────────────────────────────────────────────

test('addReaction throws BAD_REQUEST when 21st distinct emoji is added', () => {
  const emojis = ['😀','😂','❤️','👍','👎','🔥','✅','🎉','🚀','👀','😎','💯','🤣','😍','🙌','💪','🎯','⭐','🌟','💥']
  expect(emojis).toHaveLength(20)
  for (const emoji of emojis) {
    service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji })
  }
  expect(() => service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '🆕' }))
    .toThrow(ServiceError)
})

test('addReaction does not throw when existing emoji is re-added after cap reached', () => {
  const emojis = ['😀','😂','❤️','👍','👎','🔥','✅','🎉','🚀','👀','😎','💯','🤣','😍','🙌','💪','🎯','⭐','🌟','💥']
  for (const emoji of emojis) {
    service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji })
  }
  // re-adding an existing emoji — should not throw
  expect(() => service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u2', emoji: '😀' }))
    .not.toThrow()
})

// ── enrichWithReactions ───────────────────────────────────────────────────────

test('enrichWithReactions populates reactions array on each message', () => {
  service.addReaction({ msgId: 'm1', channelId: 'c1', userId: 'u1', emoji: '👍' })
  service.addReaction({ msgId: 'm2', channelId: 'c1', userId: 'u2', emoji: '❤️' })

  const messages = [
    { msg_id: 'm1', text: 'hello' },
    { msg_id: 'm2', text: 'world' },
    { msg_id: 'm3', text: 'no reactions' },
  ]
  const enriched = service.enrichWithReactions({ messages, requestingUserId: 'u1' })

  expect(enriched[0].reactions).toHaveLength(1)
  expect(enriched[0].reactions[0].emoji).toBe('👍')
  expect(enriched[0].reactions[0].reacted).toBe(true)

  expect(enriched[1].reactions).toHaveLength(1)
  expect(enriched[1].reactions[0].emoji).toBe('❤️')
  expect(enriched[1].reactions[0].reacted).toBe(false)  // u1 did not react with ❤️

  expect(enriched[2].reactions).toHaveLength(0)
})

test('enrichWithReactions returns original array when messages is empty', () => {
  const result = service.enrichWithReactions({ messages: [], requestingUserId: 'u1' })
  expect(result).toHaveLength(0)
})
