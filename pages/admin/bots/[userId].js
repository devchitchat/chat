import { requireAdminSession } from '../../../src/adminAuth.js'
import { botService, channelService } from '../../../src/context.js'

function getBotUserId(req) {
  return new URL(req.url).pathname.split('/').pop()
}

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const botUserId = getBotUserId(req)
  const bot = botService.getBot({ userId: botUserId, requestingUserId: session.user.user_id })

  const url = new URL(req.url)
  const createdToken = url.searchParams.get('created_token') ?? null
  const flash = url.searchParams.get('flash') ?? null

  // All channels for channel assignment checkboxes
  const allChannels = channelService.listChannels(session.user.user_id, session.user.roles)
  const botChannelIds = new Set(bot.channels.map(c => c.channel_id))

  return {
    user: session.user,
    pageTitle: `Admin — Bot: ${bot.handle}`,
    bot,
    createdToken,
    flash,
    tokens: bot.tokens.map(t => ({
      ...t,
      created_at_fmt: new Date(t.created_at).toLocaleString(),
      last_used_at_fmt: t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'Never',
      revoked: !!t.revoked_at,
    })),
    allChannels: allChannels.map(c => ({
      ...c,
      checked: botChannelIds.has(c.channel_id),
    })),
  }
}

export async function POST(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const botUserId = getBotUserId(req)
  const form = await req.formData()
  const action = form.get('action')

  if (action === 'create_token') {
    const label = form.get('label')?.trim() || null
    const result = botService.createToken({ userId: botUserId, label, requestingUserId: session.user.user_id })
    return Response.redirect(
      new URL(`/admin/bots/${botUserId}?created_token=${encodeURIComponent(result.token)}`, req.url),
      303
    )
  }

  if (action === 'revoke_token') {
    const tokenId = form.get('token_id')
    botService.revokeToken({ tokenId, requestingUserId: session.user.user_id })
    return Response.redirect(new URL(`/admin/bots/${botUserId}?flash=token_revoked`, req.url), 303)
  }

  if (action === 'set_channels') {
    const channelIds = form.getAll('channel_ids')
    botService.setBotChannels({ userId: botUserId, channelIds, requestingUserId: session.user.user_id })
    return Response.redirect(new URL(`/admin/bots/${botUserId}?flash=channels_updated`, req.url), 303)
  }

  return new Response('Bad request', { status: 400 })
}
