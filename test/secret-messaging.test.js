import { test, expect, describe, beforeEach } from 'bun:test'
import { SecretModeService } from '../src/services/SecretModeService.js'
import { InMemoryChannelRepository } from '../src/adapters/InMemoryChannelRepository.js'
import { InMemoryMessageRepository } from '../src/adapters/InMemoryMessageRepository.js'
import { InMemoryPublicKeyRepository } from '../src/adapters/InMemoryPublicKeyRepository.js'
import { ServiceError } from '../src/util/errors.js'

function makeService(overrides = {}) {
  const channelRepo   = new InMemoryChannelRepository()
  const messageRepo   = new InMemoryMessageRepository()
  const publicKeyRepo = new InMemoryPublicKeyRepository()
  let now = 1_000_000
  const nowFn = () => now

  const service = new SecretModeService({ channelRepo, messageRepo, publicKeyRepo, nowFn, ...overrides })
  return { service, channelRepo, messageRepo, publicKeyRepo, nowFn: () => now, advanceTime: (ms) => { now += ms } }
}

describe('SecretModeService.setSecretMode', () => {
  test('turns on secret mode and returns a system message', () => {
    const { service, channelRepo } = makeService()

    channelRepo.insertDmChannel({ channelId: 'c1', name: 'dm:u1:u2', userIdA: 'u1', userIdB: 'u2', now: 1000 })

    const result = service.setSecretMode({ channelId: 'c1', requestingUserId: 'u1', enabled: true, requestingUserDisplayName: 'Alice' })

    expect(result.channel_id).toBe('c1')
    expect(result.secret_mode).toBe(true)
    expect(result.system_msg.text).toBe('Alice turned on secret messages')
    expect(result.system_msg.msg_type).toBe('system')
    expect(result.system_msg.msg_id).toBeTruthy()

    // channel flag updated
    const ch = channelRepo.findById({ channelId: 'c1' })
    expect(ch.secret_mode).toBe(1)
  })

  test('turns off secret mode', () => {
    const { service, channelRepo } = makeService()
    channelRepo.insertDmChannel({ channelId: 'c1', name: 'dm:u1:u2', userIdA: 'u1', userIdB: 'u2', now: 1000, secretMode: 1 })

    const result = service.setSecretMode({ channelId: 'c1', requestingUserId: 'u1', enabled: false, requestingUserDisplayName: 'Alice' })

    expect(result.secret_mode).toBe(false)
    expect(result.system_msg.text).toBe('Alice turned off secret messages')

    const ch = channelRepo.findById({ channelId: 'c1' })
    expect(ch.secret_mode).toBe(0)
  })

  test('system message is stored in the message repo', () => {
    const { service, channelRepo, messageRepo } = makeService()
    channelRepo.insertDmChannel({ channelId: 'c1', name: 'dm:u1:u2', userIdA: 'u1', userIdB: 'u2', now: 1000 })

    service.setSecretMode({ channelId: 'c1', requestingUserId: 'u1', enabled: true, requestingUserDisplayName: 'Alice' })

    const msgs = messageRepo.listMessages({ channelId: 'c1', afterSeq: 0, limit: 10 })
    expect(msgs.length).toBe(1)
    expect(msgs[0].msg_type).toBe('system')
    expect(msgs[0].text).toContain('turned on secret messages')
  })

  test('throws NOT_FOUND for unknown channel', () => {
    const { service } = makeService()
    expect(() =>
      service.setSecretMode({ channelId: 'nope', requestingUserId: 'u1', enabled: true })
    ).toThrow(ServiceError)
  })

  test('throws BAD_REQUEST for non-DM channels', () => {
    const { service, channelRepo } = makeService()
    channelRepo.insertChannelWithOwner({ channelId: 'c1', kind: 'text', name: 'general', topic: null, visibility: 'public', createdByUserId: 'u1', now: 1000 })
    expect(() =>
      service.setSecretMode({ channelId: 'c1', requestingUserId: 'u1', enabled: true })
    ).toThrow(ServiceError)
  })

  test('throws FORBIDDEN for non-members', () => {
    const { service, channelRepo } = makeService()
    channelRepo.insertDmChannel({ channelId: 'c1', name: 'dm:u1:u2', userIdA: 'u1', userIdB: 'u2', now: 1000 })
    expect(() =>
      service.setSecretMode({ channelId: 'c1', requestingUserId: 'outsider', enabled: true })
    ).toThrow(ServiceError)
  })
})

describe('SecretModeService.setPublicKey / getPublicKey', () => {
  test('stores and retrieves a public key', () => {
    const { service } = makeService()
    const jwk = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' })

    service.setPublicKey({ userId: 'u1', publicKeyJwk: jwk })

    const result = service.getPublicKey({ userId: 'u1' })
    expect(result?.public_key_jwk).toBe(jwk)
    expect(result?.user_id).toBe('u1')
  })

  test('overwrites an existing key (upsert)', () => {
    const { service } = makeService()
    const jwk1 = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'old', y: 'old' })
    const jwk2 = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'new', y: 'new' })

    service.setPublicKey({ userId: 'u1', publicKeyJwk: jwk1 })
    service.setPublicKey({ userId: 'u1', publicKeyJwk: jwk2 })

    expect(service.getPublicKey({ userId: 'u1' })?.public_key_jwk).toBe(jwk2)
  })

  test('returns null for unknown user', () => {
    const { service } = makeService()
    expect(service.getPublicKey({ userId: 'unknown' })).toBeNull()
  })

  test('throws BAD_REQUEST for empty key', () => {
    const { service } = makeService()
    expect(() => service.setPublicKey({ userId: 'u1', publicKeyJwk: '' })).toThrow(ServiceError)
  })

  test('throws BAD_REQUEST for non-JSON key', () => {
    const { service } = makeService()
    expect(() => service.setPublicKey({ userId: 'u1', publicKeyJwk: 'not-json' })).toThrow(ServiceError)
  })
})
