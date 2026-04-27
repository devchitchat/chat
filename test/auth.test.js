import { test, expect, describe, beforeEach } from 'bun:test'
import { createTestContext } from './helpers.js'
import { SqliteAuthRepository } from '../src/adapters/SqliteAuthRepository.js'

describe('AuthService', () => {
  let ctx

  beforeEach(() => { ctx = createTestContext() })

  test('bootstrap token creates an admin user', async () => {
    const result = await ctx.auth.redeemInvite({
      inviteToken: 'test-bootstrap',
      profile: { handle: 'admin', display_name: 'Admin' },
      password: 'secret123',
    })
    expect(result.user.roles).toContain('admin')
    expect(result.sessionToken).toBeTruthy()
  })

  test('bootstrap token is one-time-use', async () => {
    await ctx.insertUser({ handle: 'admin' })
    await expect(ctx.insertUser({ handle: 'second' })).rejects.toThrow()
  })

  test('validateSession returns user for valid token', async () => {
    const { sessionToken } = await ctx.auth.redeemInvite({
      inviteToken: 'test-bootstrap',
      profile: { handle: 'u1', display_name: 'U1' },
      password: 'pw',
    })
    const session = ctx.auth.validateSession(sessionToken)
    expect(session).not.toBeNull()
    expect(session.user.handle).toBe('u1')
  })

  test('validateSession returns null for expired token', async () => {
    const ttlMs = 1000
    const authRepo = new SqliteAuthRepository({ db: ctx.db })
    const auth = new (await import('../src/services/AuthService.js')).AuthService({
      authRepo,
      nowFn: ctx.nowFn,
      sessionTtlMs: ttlMs,
      bootstrapToken: 'boot2',
    })
    const result = await auth.redeemInvite({ inviteToken: 'boot2', profile: { handle: 'u2', display_name: 'U2' }, password: 'pw' })
    ctx.advanceTime(ttlMs + 1)
    expect(auth.validateSession(result.sessionToken)).toBeNull()
  })

  test('signInWithPassword succeeds for correct credentials', async () => {
    await ctx.insertUser({ handle: 'alice', password: 'correcthorse' })
    const result = await ctx.auth.signInWithPassword({ handle: 'alice', password: 'correcthorse' })
    expect(result.sessionToken).toBeTruthy()
    expect(result.user.handle).toBe('alice')
  })

  test('signInWithPassword fails for wrong password', async () => {
    await ctx.insertUser({ handle: 'bob', password: 'rightpass' })
    await expect(ctx.auth.signInWithPassword({ handle: 'bob', password: 'wrongpass' })).rejects.toThrow()
  })

  test('admin can create an invite token', async () => {
    const admin = await ctx.insertUser({ handle: 'admin2' })
    // insertUser uses bootstrap so admin has admin role
    const { inviteToken } = ctx.auth.createInvite({ createdByUserId: admin.user_id })
    expect(inviteToken).toBeTruthy()
  })
})
