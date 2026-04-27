import { test, expect, beforeEach } from 'bun:test'
import { AuthService } from '../src/services/AuthService.js'
import { InMemoryAuthRepository } from '../src/adapters/InMemoryAuthRepository.js'
import { ServiceError } from '../src/util/errors.js'

let repo, service

function makeService(overrides = {}) {
  repo = new InMemoryAuthRepository()
  service = new AuthService({ authRepo: repo, nowFn: () => 1000, sessionTtlMs: 86400000, ...overrides })
  return { repo, service }
}

beforeEach(() => { makeService() })

test('redeemInvite creates user and returns session token', async () => {
  // seed an admin user so createInvite works
  repo.registerBootstrapUser({ userId: 'u_admin', handle: 'admin', displayName: 'Admin', rolesJson: JSON.stringify(['admin']), passwordHash: 'x', now: 1000, sessionId: 's0', sessionTokenHash: 'h0', sessionExpiresAt: 9999999 })

  const { inviteToken } = service.createInvite({ createdByUserId: 'u_admin' })
  const result = await service.redeemInvite({ inviteToken, profile: { handle: 'alice' }, password: 'secret123' })

  expect(result.sessionToken).toBeTruthy()
  expect(result.user.handle).toBe('alice')
  expect(result.user.roles).toContain('user')
})

test('redeemInvite throws when invite is expired', async () => {
  repo.registerBootstrapUser({ userId: 'u_admin', handle: 'admin', displayName: 'Admin', rolesJson: JSON.stringify(['admin']), passwordHash: 'x', now: 1000, sessionId: 's0', sessionTokenHash: 'h0', sessionExpiresAt: 9999999 })

  const { inviteToken } = service.createInvite({ createdByUserId: 'u_admin', ttlMs: 1 })
  // nowFn advances past expiry
  service.nowFn = () => 9999999
  await expect(service.redeemInvite({ inviteToken, profile: { handle: 'bob' }, password: 'secret' })).rejects.toThrow(ServiceError)
})

test('tryBootstrap creates admin user when no users exist', async () => {
  const { service: s } = makeService({ bootstrapToken: 'boot-tok' })
  const result = await s.redeemInvite({ inviteToken: 'boot-tok', profile: { handle: 'firstadmin' }, password: 'pass123' })
  expect(result.user.roles).toContain('admin')
  expect(result.sessionToken).toBeTruthy()
})

test('tryBootstrap is rejected when users already exist', async () => {
  const { service: s, repo: r } = makeService({ bootstrapToken: 'boot-tok' })
  r.registerBootstrapUser({ userId: 'u1', handle: 'existing', displayName: 'X', rolesJson: '["user"]', passwordHash: 'x', now: 1000, sessionId: 's1', sessionTokenHash: 'h1', sessionExpiresAt: 9999999 })
  await expect(s.redeemInvite({ inviteToken: 'boot-tok', profile: { handle: 'admin' }, password: 'pass' })).rejects.toThrow(ServiceError)
})

test('signInWithPassword returns session token for valid credentials', async () => {
  const { service: s, repo: r } = makeService({ bootstrapToken: 'boot-tok' })
  await s.redeemInvite({ inviteToken: 'boot-tok', profile: { handle: 'firstadmin' }, password: 'mypassword' })
  const result = await s.signInWithPassword({ handle: 'firstadmin', password: 'mypassword' })
  expect(result.sessionToken).toBeTruthy()
  expect(result.user.handle).toBe('firstadmin')
})

test('signInWithPassword throws AUTH_FAILED for wrong password', async () => {
  const { service: s } = makeService({ bootstrapToken: 'boot-tok' })
  await s.redeemInvite({ inviteToken: 'boot-tok', profile: { handle: 'firstadmin' }, password: 'mypassword' })
  await expect(s.signInWithPassword({ handle: 'firstadmin', password: 'wrongpassword' })).rejects.toThrow(ServiceError)
})

test('validateSession returns user for valid token', async () => {
  const { service: s } = makeService({ bootstrapToken: 'boot-tok' })
  const { sessionToken } = await s.redeemInvite({ inviteToken: 'boot-tok', profile: { handle: 'admin' }, password: 'pass' })
  const result = s.validateSession(sessionToken)
  expect(result?.user?.handle).toBe('admin')
})

test('validateSession returns null after revokeSession', async () => {
  const { service: s } = makeService({ bootstrapToken: 'boot-tok' })
  const { sessionToken } = await s.redeemInvite({ inviteToken: 'boot-tok', profile: { handle: 'admin' }, password: 'pass' })
  const { session_id } = s.validateSession(sessionToken)
  s.revokeSession(session_id)
  expect(s.validateSession(sessionToken)).toBeNull()
})

test('createInvite throws FORBIDDEN for non-admin user', () => {
  repo.registerBootstrapUser({ userId: 'u_regular', handle: 'regular', displayName: 'Regular', rolesJson: JSON.stringify(['user']), passwordHash: 'x', now: 1000, sessionId: 's0', sessionTokenHash: 'h0', sessionExpiresAt: 9999999 })
  expect(() => service.createInvite({ createdByUserId: 'u_regular' })).toThrow(ServiceError)
})
