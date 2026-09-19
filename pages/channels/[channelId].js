import { sessionFromRequest, channelService, messageService, reactionService, auth, logger } from '../../src/context.js'
import { renderMarkdown } from '@devchitchat/index97/markdown'
import { p, BASE_PATH } from '../../src/config.js'

function sanitizeForFrontEnd(html) {
  let output = html.toString()
  output = output.replaceAll('<script>', '')
  output = output.replaceAll('</script>', '')
  return output
}

export async function GET(req) {
  const session = sessionFromRequest(req)
  if (!session) return Response.redirect(p('/login'), 302)

  const url = new URL(req.url)
  const channelId = url.pathname.split('/').pop()
  const user = session.user
  let channel = channelService.getChannel(channelId)
  if (!channel || channel.deleted_at) {
    logger?.warn('channel.not_found', { channelId, userId: user.user_id })
    return new Response('Channel not found', { status: 404 })
  }

  const isMember = channelService.isMember(channelId, user.user_id)

  // Public channels: allow browsing without joining (join banner shown client-side)
  // Private/session channels: must be a member already
  if (!isMember) {
    if (channel.visibility !== 'public') {
      logger?.warn('channel.access_denied', { channelId, userId: user.user_id, visibility: channel.visibility })
      return new Response('Forbidden', { status: 403 })
    }
  }

  // SSR: last 50 messages baked into the page for instant render
  const { messages: rawSeedMessages } = messageService.listLatestMessages({
    channelId,
    userId: user.user_id,
    limit: 50,
  })
  const seedMessages = reactionService
    ? reactionService.enrichWithReactions({ messages: rawSeedMessages, requestingUserId: user.user_id })
    : rawSeedMessages

  const seedMsgIds = rawSeedMessages.map(m => m.msg_id)
  const replyCounts = messageService.getReplyCountsForMessages({ msgIds: seedMsgIds })
  const seedSeq = seedMessages.length ? seedMessages[seedMessages.length - 1].seq : 0
  const seedFirstSeq = seedMessages.length ? seedMessages[0].seq : 0
  const seedHasMore = seedFirstSeq > 1

  // Sidebar data: flat channel buckets for nav
  const allChannels = channelService.listChannels(user.user_id, user.roles)
  const _mapChannel = c => ({
    ...c,
    active: channelId === c.channel_id,
    url: p(`/channels/${c.channel_id}`),
    isMember: channelService.isMember(c.channel_id, user.user_id),
    isEnded: c.kind === 'session' && c.session_ends_at != null && c.session_ends_at <= Date.now(),
  })
  const channels = {
    public:   allChannels.filter(c => c.kind === 'text'    && c.visibility === 'public').map(_mapChannel),
    private:  allChannels.filter(c => c.kind === 'text'    && c.visibility === 'private').map(_mapChannel),
    sessions: allChannels.filter(c => c.kind === 'session').map(_mapChannel),
    // DMs are fetched client-side via dm.list_result; no SSR needed
  }

  // For DM channels, replace the internal name with the other person's display name
  if (channel.kind === 'dm') {
    const otherUserId = channel.name.split(':').slice(1).find(id => id !== user.user_id)
    const otherUser = otherUserId ? auth.getUser(otherUserId) : null
    channel = { ...channel, name: otherUser?.display_name ?? 'Direct Message', topic: null }
  }

  // Session channel extras: members for the session banner
  let sessionMembers = []
  let sessionOwner = null
  const isSessionEnded = channel.kind === 'session' && channel.session_ends_at != null && channel.session_ends_at <= Date.now()
  if (channel.kind === 'session') {
    const rawMembers = channelService.listChannelMembers(channelId)
    sessionMembers = rawMembers.map(m => {
      const u = auth.getUser(m.user_id)
      return {
        user_id: m.user_id,
        display_name: u?.display_name ?? m.user_id,
        handle: u?.handle ?? '',
        role: m.role,
        initials: (u?.display_name ?? m.user_id).split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
      }
    })
    const ownerMember = rawMembers.find(m => m.role === 'owner')
    sessionOwner = ownerMember ? auth.getUser(ownerMember.user_id) : null
  }

  const isSession = channel.kind === 'session'
  const isSessionOwner = isSession && (
    channelService.getMembership(channelId, user.user_id)?.role === 'owner' ||
    user.roles?.includes('admin')
  )

  const user_initials = user.avatar_initials
    || (user.display_name ?? user.handle ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()

  return {
    user,
    user_initials,
    isAdmin: user.roles?.includes('admin') ?? false,
    channel,
    isMember,
    isSession,
    isSessionEnded,
    isSessionOwner,
    sessionMembers,
    sessionOwner,
    currentChannelId: channelId,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    base: BASE_PATH,
    seedFirstSeq,
    seedHasMore,
    seedMessages: seedMessages.map(m => {
      const replyCount = replyCounts[m.msg_id] ?? 0
      return {
        ...m,
        raw_text: m.text,
        text: sanitizeForFrontEnd(renderMarkdown(m.text).html),
        ts_fmt: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        attachments_json: m.attachments?.length ? JSON.stringify(m.attachments) : '',
        reactions_json: m.reactions?.length ? JSON.stringify(m.reactions) : '',
        edited_at: m.edited_at ?? '',
        reply_count: replyCount,
        reply_count_label: replyCount > 0 ? `View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : '',
      }
    }),
    seedSeq,
    channels,
  }
}
