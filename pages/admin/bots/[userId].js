import { requireAdminSession } from '../../../src/adminAuth.js'
import { botService, channelService } from '../../../src/context.js'
import { randomToken } from '../../../src/util/crypto.js'
import { p } from '../../../src/config.js'
import { storeTokenFlash, consumeTokenFlash } from '../../../src/util/tokenFlash.js'

function getBotUserId(req) {
  return new URL(req.url).pathname.split('/').pop()
}

export function GET(req) {
  const session = requireAdminSession(req)
  if (session instanceof Response) return session

  const botUserId = getBotUserId(req)
  const bot = botService.getBot({ userId: botUserId, requestingUserId: session.user.user_id })

  const url = new URL(req.url)
  // Consume the flash token once — removes it from the map so it can't be replayed
  const flashId = url.searchParams.get('flash_id') ?? null
  const createdToken = consumeTokenFlash(flashId)
  const flash = url.searchParams.get('flash') ?? null

  const allChannels = channelService.listChannels(session.user.user_id, session.user.roles)
  const botChannelIds = new Set(bot.channels.map(c => c.channel_id))

  // Public channels are auto-granted to all bots — display-only
  const _entry = ch => ({
    ...ch,
    checked: botChannelIds.has(ch.channel_id),
    autoGranted: ch.visibility === 'public',
  })
  const channelSections = {
    public:   allChannels.filter(c => c.kind !== 'session' && c.visibility === 'public').map(_entry),
    private:  allChannels.filter(c => c.kind !== 'session' && c.visibility === 'private').map(_entry),
    sessions: allChannels.filter(c => c.kind === 'session').map(_entry),
  }

  return {
    user: session.user,
    pageTitle: `Admin — Bot: ${bot.handle}`,
    bot,
    createdToken,
    flash,
    tokens: bot.tokens.map(t => ({
      ...t,
      created_at_fmt:   new Date(t.created_at).toLocaleString(),
      expires_at_fmt:   t.expires_at ? new Date(t.expires_at).toLocaleString() : 'Never',
      last_used_at_fmt: t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'Never',
      revoked:  !!t.revoked_at,
      expired:  !t.revoked_at && t.expires_at != null && t.expires_at <= Date.now(),
    })),
    channelSections,
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
    const ttlDays = parseInt(form.get('ttl_days') || '', 10)
    const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : null
    const result = botService.createToken({ userId: botUserId, label, ttlMs, requestingUserId: session.user.user_id })
    // Store the token in the server-side flash map — never put it in the URL
    const flashId = randomToken(8)
    storeTokenFlash(flashId, result.token)
    return Response.redirect(p(`/admin/bots/${botUserId}?flash_id=${encodeURIComponent(flashId)}`), 303)
  }

  if (action === 'revoke_token') {
    const tokenId = form.get('token_id')
    botService.revokeToken({ tokenId, requestingUserId: session.user.user_id })
    return Response.redirect(p(`/admin/bots/${botUserId}?flash=token_revoked`), 303)
  }

  if (action === 'set_channels') {
    const channelIds = form.getAll('channel_ids')
    botService.setBotChannels({ userId: botUserId, channelIds, requestingUserId: session.user.user_id })
    return Response.redirect(p(`/admin/bots/${botUserId}?flash=channels_updated`), 303)
  }

  return new Response('Bad request', { status: 400 })
}
