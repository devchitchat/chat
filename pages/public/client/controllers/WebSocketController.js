/**
 * WebSocketController.js — maps incoming WebSocket messages to AppModel mutations.
 *
 * This is the only place ws.on(...) calls appear for server→client events.
 * It owns the WsClient instance and hands it to ChatController for sends.
 *
 * Rules:
 *   - Never touches the DOM.
 *   - Never dispatches CustomEvents directly — calls model mutators instead.
 *   - Filters messages by channelId when the event is channel-scoped.
 */

import { WsClient }    from '../ws.js'
import { navigateTo } from '../router.js'

export class WebSocketController {
  #ws
  #model

  /**
   * @param {AppModel} model
   * @param {string} wsPath  e.g. '/ws' or '/base/ws'
   */
  constructor(model, wsPath = '/ws') {
    this.#model = model
    this.#ws    = new WsClient(wsPath)
    this.#wire()
  }

  /** Expose WsClient so ChatController can call ws.send() */
  get ws() { return this.#ws }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: wire all incoming WS events
  // ─────────────────────────────────────────────────────────────────────────

  #wire() {
    const ws    = this.#ws
    const model = this.#model

    // ── Session handshake ──────────────────────────────────────────────────
    ws.on('open', () => {
      ws.send({ t: 'hello', body: { client: 'devchitchat', resume: { session_token: null } } })
    })

    ws.on('hello_ack', () => {
      // Join the current channel if one is already selected (e.g. on reconnect)
      const channelId = model.currentChannelId
      if (channelId) ws.send({ t: 'channel.join', body: { channel_id: channelId } })
    })

    ws.on('error', ({ code, message }) => {
      console.warn('[ws error]', code, message)
    })

    ws.on('channel.joined', ({ channel_id }) => {
      // Request users/bots for mention picker if not yet loaded
      if (model.members.length === 0) {
        ws.send({ t: 'user.list', body: {} })
        ws.send({ t: 'bot.list',  body: {} })
      }

      // Catch up on messages missed during disconnect.
      // newestSeqFor returns the highest seq the client already has; request
      // everything after that so the model stays current without a full reload.
      const cid = channel_id ?? model.currentChannelId
      if (cid) {
        const afterSeq = model.newestSeqFor(cid)
        if (afterSeq > 0) {
          ws.send({ t: 'msg.list', body: { channel_id: cid, after_seq: afterSeq } })
        }
      }

      // Fetch thread list for the sidebar subtree whenever we join the current channel.
      if (cid === model.currentChannelId) {
        ws.send({ t: 'thread.channel_list', body: { channel_id: cid } })
      }

      // Hide the join banner whenever we receive channel.joined for the current channel.
      // This covers both explicit join (join button) and auto-join (first message sent).
      if (cid === model.currentChannelId) {
        document.dispatchEvent(new CustomEvent('channel:auto-joined', { detail: { channelId: cid } }))
      }
    })

    // ── Member lists ───────────────────────────────────────────────────────
    ws.on('user.list_result', ({ users }) => {
      model.setMembers((users ?? []).filter(u => u.handle))
      // Seed avatar map from initial user list
      for (const u of (users ?? [])) {
        if (u.avatar_initials || u.avatar_color || u.avatar_url) {
          model.updateMemberProfile(u)
        }
      }
    })

    ws.on('bot.list_result', ({ bots }) => {
      model.setBots((bots ?? []).filter(b => b.handle))
      // Seed avatar map for bots that have custom avatars
      for (const b of (bots ?? [])) {
        if (b.avatar_initials || b.avatar_color || b.avatar_url) {
          model.updateMemberProfile(b)
        }
      }
    })

    // ── Profile updates ────────────────────────────────────────────────────
    ws.on('user.profile_updated', (body) => {
      model.updateMemberProfile(body)
    })

    // ── Messages ───────────────────────────────────────────────────────────
    ws.on('msg.list_result', ({ messages, has_more, direction, channel_id }) => {
      const channelId = channel_id ?? model.currentChannelId
      if (!channelId) return

      if (direction === 'before') {
        model.prependMessages(channelId, messages ?? [], has_more ?? false)
        return
      }

      // after_seq catch-up: append each message
      for (const msg of (messages ?? [])) {
        model.addMessage(channelId, msg)
      }
    })

    ws.on('msg.event', (body) => {
      const channelId = body.channel_id
      if (!channelId) return
      // Thread replies come via thread.reply_event; skip them here
      if (body.parent_msg_id) return
      model.addMessage(channelId, body)

      // Show activity badge for incoming DM messages not from the current user
      // and not in the channel the user is currently looking at.
      const isDm = model.dms?.some(d => d.channel_id === channelId)
      if (isDm && body.user_id !== model.userId && channelId !== model.currentChannelId) {
        model.addDmUnread(channelId)
        model.addActivityItem({
          type:       'dm',
          text:       `<strong>${body.user_display_name ?? 'Someone'}</strong> sent you a message`,
          sub:        'Direct message',
          time:       _relTime(body.ts),
          unread:     true,
          initials:   _initials(body.user_display_name ?? '?'),
          channel_id: channelId,
          msg_id:     body.msg_id,
        })
      }
    })

    ws.on('msg.edited', ({ msg_id, channel_id, text, edited_at, rendered_text }) => {
      const channelId = channel_id ?? model.currentChannelId
      if (!channelId) return
      model.updateMessage(channelId, { msg_id, text, edited_at, rendered_text })

      // If this msg is a thread reply that's currently open
      if (model.threadParentId) {
        model.updateThreadReply(model.threadParentId, { msg_id, text, edited_at, rendered_text })
      }
    })

    ws.on('msg.deleted', ({ msg_id, channel_id }) => {
      const channelId = channel_id ?? model.currentChannelId
      if (channelId) model.deleteMessage(channelId, msg_id)
      // Also try thread replies
      if (model.threadParentId) {
        model.deleteThreadReply(model.threadParentId, msg_id)
      }
    })

    ws.on('reaction.event', ({ msg_id, channel_id, reactions }) => {
      const channelId = channel_id ?? model.currentChannelId
      if (!channelId) return
      model.setReactions(msg_id, channelId, reactions ?? [])
    })

    // ── Channel metadata ───────────────────────────────────────────────────
    ws.on('channel.updated', ({ channel }) => {
      if (!channel?.channel_id) return
      model.updateChannelMeta(channel.channel_id, {
        name:  channel.name,
        topic: channel.topic ?? '',
      })
      model.upsertChannel(channel)
    })

    ws.on('channel.created', ({ channel }) => {
      if (channel?.channel_id) model.upsertChannel(channel)
    })

    ws.on('channel.deleted', ({ channel_id }) => {
      const isActive = channel_id === model.currentChannelId
      const fallback = isActive ? model.fallbackForDeleted(channel_id) : null
      model.removeChannel(channel_id)
      if (isActive && fallback) {
        const base = window.__BASE_PATH__ ?? ''
        navigateTo(`${base}/channels/${fallback}`, false)
      }
    })

    // ── Thread ─────────────────────────────────────────────────────────────
    ws.on('thread.list_result', ({ parent_msg_id, replies }) => {
      model.loadThreadReplies(parent_msg_id, replies ?? [])
    })

    // ── Presence ───────────────────────────────────────────────────────────
    ws.on('presence.event', ({ user_id, status }) => {
      model.setPresence(user_id, status)
    })

    ws.on('presence.list_result', ({ entries }) => {
      model.setBulkPresence(entries ?? [])
    })

    // ── Sidebar channel/DM lists ─────────────────────────────────────────
    ws.on('channel.list_result', ({ channels }) => {
      model.setChannels(_bucketsFromServer(channels ?? []))
    })

    ws.on('dm.list_result', ({ dms: list }) => {
      model.setDms(list ?? [])
    })

    // ── DMs ────────────────────────────────────────────────────────────────
    ws.on('dm.opened', ({ channel, channel_id, with_user, notify_only }) => {
      // Handle both payload shapes (full channel object or inline fields)
      const ch = channel ?? (channel_id ? { channel_id, with_user } : null)
      if (!ch) return
      const dms = model.dms
      const already = dms.some(d => d.channel_id === ch.channel_id)
      if (!already) model.setDms([...dms, ch])

      // Mark DM as unread when notify_only, or navigate for active open
      if (notify_only) {
        model.addDmUnread(ch.channel_id)
      } else if (!channel) {
        // SidebarView handles navigation for non-notify_only dm.opened
      }
    })

    // ── Search ─────────────────────────────────────────────────────────────
    ws.on('search.global_result', ({ q, hits }) => {
      document.dispatchEvent(new CustomEvent('search:global_result', { detail: { q, hits: hits ?? [] } }))
    })

    // ── Channel membership ─────────────────────────────────────────────────
    ws.on('channel.member_added', (body) => {
      document.dispatchEvent(new CustomEvent('channel:member_added', { detail: body }))
    })

    ws.on('channel.member_removed', ({ channel_id, user_id }) => {
      document.dispatchEvent(new CustomEvent('channel:member_removed', { detail: { channelId: channel_id, userId: user_id } }))
    })

    // ── Session ────────────────────────────────────────────────────────────
    ws.on('session.ended', ({ channel_id, session_ends_at }) => {
      model.upsertChannel({ channel_id, session_ends_at })
      document.dispatchEvent(new CustomEvent('session:ended', { detail: { channelId: channel_id, sessionEndsAt: session_ends_at } }))
    })

    // ── Notifications → Activity feed ──────────────────────────────────────
    ws.on('notification.mention', ({ msg_id, channel_id, channel_name, from_user, ts, priority }) => {
      model.addActivityItem({
        type: 'mention',
        text: `<strong>${from_user?.display_name ?? from_user?.handle ?? 'Someone'}</strong> mentioned you`,
        sub: `#${channel_name ?? channel_id}`,
        time: _relTime(ts),
        unread: true,
        initials: _initials(from_user?.display_name ?? '?'),
        channel_id,
        msg_id,
      })
      // Update sidebar mention dots (only for channels not currently viewed)
      if (channel_id !== model.currentChannelId) {
        model.addMention(channel_id, priority === 'now')
      }
    })

    ws.on('notification.digest', ({ channels }) => {
      for (const c of (channels ?? [])) {
        if (c.urgent) model.addMention(c.channel_id, true)
        else if (c.mentions > 0) model.addMention(c.channel_id, false)
      }
    })

    ws.on('channel.reordered', ({ channels, section }) => {
      const BASE = () => window.__BASE_PATH__ ?? ''
      const buckets    = model.channels
      const targetKey  = section ?? 'public'
      const existing   = buckets[targetKey] ?? []
      const channelMap = new Map(existing.map(c => [c.channel_id, c]))
      const reordered  = (channels ?? []).map(c => ({
        ...channelMap.get(c.channel_id),
        ...c,
        url: `${BASE()}/channels/${c.channel_id}`,
      }))
      model.setChannels({ ...buckets, [targetKey]: reordered })
    })

    ws.on('thread.channel_list_result', ({ channel_id, threads }) => {
      model.setChannelThreads(channel_id, threads ?? [])
    })

    ws.on('thread.reply_event', ({ parent_msg_id, channel_id, reply }) => {
      // Update open thread panel if this reply belongs to it
      model.addThreadReply(parent_msg_id, reply)
      // Keep channel thread list fresh: update reply_count + last_reply_ts for this thread
      const existing = model.channelThreadsFor(channel_id)
      if (existing.length > 0) {
        const updated = existing.map(t =>
          t.msg_id === parent_msg_id
            ? { ...t, reply_count: (t.reply_count ?? 0) + 1, last_reply_ts: reply.ts }
            : t
        )
        // If the parent wasn't in the list yet (first reply), request a fresh list
        if (!updated.some(t => t.msg_id === parent_msg_id)) {
          ws.send({ t: 'thread.channel_list', body: { channel_id } })
        } else {
          model.setChannelThreads(channel_id, updated)
        }
      } else if (channel_id === model.currentChannelId) {
        // First thread in this channel — fetch it
        ws.send({ t: 'thread.channel_list', body: { channel_id } })
      }
      // If this is a reply to one of our messages, add to activity
      const parentMsg = model.messagesFor(channel_id ?? model.currentChannelId)?.find(m => m.msg_id === parent_msg_id)
      if (parentMsg && parentMsg.user_id === model.userId && reply?.user_id !== model.userId) {
        const channelEntry = [...Object.values(model.channels)].flat().find(c => c.channel_id === channel_id)
        model.addActivityItem({
          type: 'thread_reply',
          text: `<strong>${reply.user_display_name ?? 'Someone'}</strong> replied to your message`,
          sub: channelEntry ? `#${channelEntry.name}` : '',
          time: _relTime(reply.ts),
          unread: true,
          initials: _initials(reply.user_display_name ?? '?'),
          channel_id,
          msg_id: parent_msg_id,
        })
      }
    })

    // ── Call events are forwarded as-is to the current call state object ───
    // CallView registers its own ws.on() handlers; we don't touch call state
    // here to keep call logic isolated in CallView / ChatController.
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────────

/**
 * Convert a flat server channel array into the { public, private, sessions, dms } shape.
 */
function _bucketsFromServer(channels) {
  const BASE = () => window.__BASE_PATH__ ?? ''
  const buckets = { public: [], private: [], sessions: [], dms: [] }
  for (const ch of channels) {
    const key = ch.kind === 'dm'      ? 'dms'
              : ch.kind === 'session' ? 'sessions'
              : ch.visibility === 'private' ? 'private'
              : 'public'
    buckets[key].push({ ...ch, url: `${BASE()}/channels/${ch.channel_id}` })
  }
  return buckets
}

function _relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000)  return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

function _initials(name) {
  return name.split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
}
