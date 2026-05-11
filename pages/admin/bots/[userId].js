import { requireAdminSession } from '../../../src/adminAuth.js'
import { botService, channelService } from '../../../src/context.js'
import { randomToken } from '../../../src/util/crypto.js'

// In-memory flash store: flashId → plaintext token. Consumed once on GET.
// Lost on restart, which is fine — the token was already shown or is gone.
const tokenFlashes = new Map()

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
  const createdToken = flashId ? (tokenFlashes.get(flashId) ?? null) : null
  if (flashId) tokenFlashes.delete(flashId)
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
      expires_at_fmt: t.expires_at ? new Date(t.expires_at).toLocaleString() : 'Never',
      last_used_at_fmt: t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'Never',
      revoked: !!t.revoked_at,
      expired: !t.revoked_at && t.expires_at != null && t.expires_at <= Date.now(),
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
    const ttlDays = parseInt(form.get('ttl_days') || '', 10)
    const ttlMs = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : null
    const result = botService.createToken({ userId: botUserId, label, ttlMs, requestingUserId: session.user.user_id })
    // Store the token in the server-side flash map — never put it in the URL
    const flashId = randomToken(8)
    tokenFlashes.set(flashId, result.token)
    return Response.redirect(
      new URL(`/admin/bots/${botUserId}?flash_id=${encodeURIComponent(flashId)}`, req.url),
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
