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

import { WsClient } from '../ws.js'

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
    })

    // ── Member lists ───────────────────────────────────────────────────────
    ws.on('user.list_result', ({ users }) => {
      model.setMembers((users ?? []).filter(u => u.handle))
    })

    ws.on('bot.list_result', ({ bots }) => {
      model.setBots((bots ?? []).filter(b => b.handle))
    })

    // ── Messages ───────────────────────────────────────────────────────────
    ws.on('msg.list_result', ({ messages, next_after_seq, has_more, direction, channel_id }) => {
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
      // Keep sidebar channel list in sync
      if (channel.hub_id) model.upsertChannel(channel)
    })

    ws.on('channel.created', ({ channel }) => {
      if (channel?.hub_id) model.upsertChannel(channel)
    })

    ws.on('channel.deleted', ({ channel_id }) => {
      model.removeChannel(channel_id)
    })

    // ── Hub events ─────────────────────────────────────────────────────────
    ws.on('hub.created', ({ hub }) => {
      model.upsertHub(hub)
    })

    ws.on('hub.updated', ({ hub }) => {
      model.upsertHub(hub)
    })

    ws.on('hub.deleted', ({ hub_id }) => {
      model.removeHub(hub_id)
    })

    // ── Thread ─────────────────────────────────────────────────────────────
    ws.on('thread.list_result', ({ parent_msg_id, replies }) => {
      model.loadThreadReplies(parent_msg_id, replies ?? [])
    })

    ws.on('thread.reply_event', ({ parent_msg_id, channel_id, reply }) => {
      model.addThreadReply(parent_msg_id, reply)
    })

    // ── Presence ───────────────────────────────────────────────────────────
    ws.on('presence.event', ({ user_id, status }) => {
      model.setPresence(user_id, status)
    })

    ws.on('presence.list_result', ({ entries }) => {
      model.setBulkPresence(entries ?? [])
    })

    // ── DMs ────────────────────────────────────────────────────────────────
    ws.on('dm.opened', ({ channel }) => {
      if (!channel) return
      const dms = model.dms
      const already = dms.some(d => d.channel_id === channel.channel_id)
      if (!already) model.setDms([...dms, channel])
    })

    // ── Call events are forwarded as-is to the current call state object ───
    // CallView registers its own ws.on() handlers; we don't touch call state
    // here to keep call logic isolated in CallView / ChatController.
  }
}
