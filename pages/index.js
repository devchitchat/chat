import { sessionFromRequest, channelService, hubService, userSettingsService } from '../src/context.js'

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) {
    return Response.redirect(new URL('/login', req.url), 302)
  }

  const user = session.user

  // Fresh-device fallback: redirect to last visited channel if recorded
  const { settings } = userSettingsService.getSettings(user.user_id)
  if (settings.last_channel_id) {
    return Response.redirect(new URL(`/channels/${settings.last_channel_id}`, req.url), 302)
  }

  const channels = channelService.listChannels(user.user_id, user.roles)
  if (channels.length > 0) {
    return Response.redirect(new URL(`/channels/${channels[0].channel_id}`, req.url), 302)
  }

  // No channels yet — bootstrap defaults and redirect
  const hub = hubService.ensureDefaultHub(user.user_id)
  const channel = channelService.ensureDefaultChannel(hub.hub_id, user.user_id)
  channelService.joinChannel({ channelId: channel.channel_id, userId: user.user_id, userRoles: user.roles })
  return Response.redirect(new URL(`/channels/${channel.channel_id}`, req.url), 302)
}
