import { sessionFromRequest, channelService, hubService, messageService } from '../../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) return Response.redirect(new URL('/login', req.url), 302)

  const url = new URL(req.url)
  const channelId = url.pathname.split('/').pop()
  const user = session.user
  const channel = channelService.getChannel(channelId)
  if (!channel || channel.deleted_at) {
    return new Response('Channel not found', { status: 404 })
  }

  // Auto-join public channels on first visit
  if (!channelService.isMember(channelId, user.user_id)) {
    if (channel.visibility === 'public') {
      channelService.joinChannel({ channelId, userId: user.user_id, userRoles: user.roles })
    } else {
      return new Response('Forbidden', { status: 403 })
    }
  }

  // SSR: last 50 messages baked into the page for instant render
  const { messages: seedMessages, next_after_seq: seedSeq } = messageService.listMessages({
    channelId,
    userId: user.user_id,
    afterSeq: 0,
    limit: 50,
  })

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

  return {
    user,
    channel,
    currentChannelId: channelId,
    seedMessages: seedMessages.map(m => ({
      ...m,
      ts_fmt: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    })),
    seedSeq,
    hubs: hubsWithChannels,
  }
}
