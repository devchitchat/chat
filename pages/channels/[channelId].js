import { sessionFromRequest, channelService, hubService, messageService, auth, logger } from '../../src/context.js'
import { renderMarkdown } from '@devchitchat/index97/markdown'

/// TODO: Come up with a better strategy to allow for styled messages. Maybe you build a custom markdown parser
// that drops everything else but the styled text?
function sanitizeForFrontEnd(html) {
  let output = html.toString()
  output = output.replaceAll('<script>', '')
  output = output.replaceAll('</script>', '')

  return output
}

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) return Response.redirect(new URL('/login', req.url), 302)

  const url = new URL(req.url)
  const channelId = url.pathname.split('/').pop()
  const user = session.user
  let channel = channelService.getChannel(channelId)
  if (!channel || channel.deleted_at) {
    logger?.warn('channel.not_found', { channelId, userId: user.user_id })
    return new Response('Channel not found', { status: 404 })
  }

  // Auto-join public channels on first visit
  if (!channelService.isMember(channelId, user.user_id)) {
    if (channel.visibility === 'public') {
      try {
        channelService.joinChannel({ channelId, userId: user.user_id, userRoles: user.roles })
      } catch (err) {
        logger?.error('channel.join_failed', { channelId, userId: user.user_id, error: err.message })
        return new Response('Forbidden', { status: 403 })
      }
    } else {
      logger?.warn('channel.access_denied', { channelId, userId: user.user_id, visibility: channel.visibility })
      return new Response('Forbidden', { status: 403 })
    }
  }

  // SSR: last 50 messages baked into the page for instant render
  const { messages: seedMessages } = messageService.listLatestMessages({
    channelId,
    userId: user.user_id,
    limit: 50,
  })
  const seedSeq = seedMessages.length ? seedMessages[seedMessages.length - 1].seq : 0
  const seedFirstSeq = seedMessages.length ? seedMessages[0].seq : 0
  const seedHasMore = seedFirstSeq > 1

  // Sidebar data: hubs + channels for nav
  const hubs = hubService.listHubs(user.user_id, user.roles)
  const allChannels = channelService.listChannels(user.user_id, user.roles)
  const hubsWithChannels = hubs.map(hub => ({
    ...hub,
    channels: allChannels
      .filter(c => c.hub_id === hub.hub_id)
      .map(c => ({
        ...c,
        className: channelId === c.channel_id ? 'channel-item active' : 'channel-item',
        url: `/channels/${c.channel_id}`,
        label: `# ${c.name}`
      }))
  }))

  // For DM channels, replace the internal name with the other person's display name
  if (channel.kind === 'dm') {
    const otherUserId = channel.name.split(':').slice(1).find(id => id !== user.user_id)
    const otherUser = otherUserId ? auth.getUser(otherUserId) : null
    channel = { ...channel, name: otherUser?.display_name ?? 'Direct Message', topic: null }
  }

  return {
    user,
    isAdmin: user.roles?.includes('admin') ?? false,
    channel,
    currentChannelId: channelId,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    seedFirstSeq,
    seedHasMore,
    seedMessages: seedMessages.map(m => ({
      ...m,
      raw_text: m.text,
      text: sanitizeForFrontEnd(renderMarkdown(m.text).html),
      ts_fmt: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      attachments_json: m.attachments?.length ? JSON.stringify(m.attachments) : '',
      edited_at: m.edited_at ?? '',
    })),
    seedSeq,
    hubs: hubsWithChannels,
  }
}
