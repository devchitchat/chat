import { test, expect, describe, beforeEach } from 'bun:test'
import { createTestContext } from './helpers.js'

describe('MessageService', () => {
  let ctx, user, hub, channel

  beforeEach(async () => {
    ctx = createTestContext()
    user = await ctx.insertUser({ handle: 'alice' })
    hub = ctx.hubService.createHub({ name: 'Test Hub', createdByUserId: user.user_id })
    channel = ctx.channelService.createChannel({
      hubId: hub.hub_id, kind: 'text', name: 'general',
      createdByUserId: user.user_id, userRoles: user.roles,
    })
  })

  test('sendMessage assigns monotonic seq', () => {
    const r1 = ctx.messageService.sendMessage({ channelId: channel.channel_id, userId: user.user_id, text: 'hello' })
    const r2 = ctx.messageService.sendMessage({ channelId: channel.channel_id, userId: user.user_id, text: 'world' })
    expect(r1.seq).toBe(1)
    expect(r2.seq).toBe(2)
  })

  test('listMessages returns messages after a given seq', () => {
    ctx.messageService.sendMessage({ channelId: channel.channel_id, userId: user.user_id, text: 'first' })
    ctx.messageService.sendMessage({ channelId: channel.channel_id, userId: user.user_id, text: 'second' })
    ctx.messageService.sendMessage({ channelId: channel.channel_id, userId: user.user_id, text: 'third' })

    const { messages } = ctx.messageService.listMessages({ channelId: channel.channel_id, userId: user.user_id, afterSeq: 1 })
    expect(messages).toHaveLength(2)
    expect(messages[0].text).toBe('second')
  })

  test('sendMessage rejects non-members', async () => {
    const other = await ctx.auth.redeemInvite({
      inviteToken: ctx.auth.createInvite({ createdByUserId: user.user_id }).inviteToken,
      profile: { handle: 'bob', display_name: 'Bob' },
      password: 'pw',
    })
    expect(() =>
      ctx.messageService.sendMessage({ channelId: channel.channel_id, userId: other.user.user_id, text: 'hi' })
    ).toThrow()
  })

  test('listMessages rejects non-members', async () => {
    const other = await ctx.auth.redeemInvite({
      inviteToken: ctx.auth.createInvite({ createdByUserId: user.user_id }).inviteToken,
      profile: { handle: 'carol', display_name: 'Carol' },
      password: 'pw',
    })
    expect(() =>
      ctx.messageService.listMessages({ channelId: channel.channel_id, userId: other.user.user_id })
    ).toThrow()
  })
})
