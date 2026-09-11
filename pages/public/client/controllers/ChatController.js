/**
 * ChatController.js — translates user actions into WS sends and model mutations.
 *
 * Views dispatch CustomEvents on themselves; ChatController listens to those
 * events and calls ws.send(). This keeps ws.send() out of views entirely.
 *
 * Wired events (views → controller):
 *   'send-message'       { channelId, text, attachments, priority }
 *   'send-thread-reply'  { channelId, parentMsgId, text, attachments }
 *   'react'              { msgId, channelId, emoji }
 *   'unreact'            { msgId, channelId, emoji }
 *   'edit-message'       { msgId, channelId, text }
 *   'delete-message'     { msgId, channelId }
 *   'open-thread'        { msgId, channelId }
 *   'close-thread'       {}
 *   'load-more'          { channelId, beforeSeq }
 *   'open-dm'            { targetUserId }
 *   'task-toggle'        { msgId, channelId, checkboxIndex, checked }
 *
 * Each of these is dispatched on `document` so any view can trigger them
 * without needing a direct reference to the controller.
 */

import * as Ev from '../model/events.js'

export class ChatController {
  #ws
  #model

  /**
   * @param {AppModel}  model
   * @param {WsClient}  ws    — from WebSocketController.ws
   */
  constructor(model, ws) {
    this.#model = model
    this.#ws    = ws
    this.#wire()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wire view → controller events
  // ─────────────────────────────────────────────────────────────────────────

  #wire() {
    const listen = (name, fn) =>
      document.addEventListener(name, e => fn(e.detail))

    listen('send-message',      d => this.#sendMessage(d))
    listen('send-thread-reply', d => this.#sendThreadReply(d))
    listen('react',             d => this.#react(d))
    listen('unreact',           d => this.#unreact(d))
    listen('edit-message',      d => this.#editMessage(d))
    listen('delete-message',    d => this.#deleteMessage(d))
    listen('open-thread',       d => this.#openThread(d))
    listen('close-thread',      ()  => this.#closeThread())
    listen('load-more',         d => this.#loadMore(d))
    listen('open-dm',           d => this.#openDm(d))
    listen('select-channel',    d => this.#selectChannel(d))
    listen('task-toggle',       d => this.#taskToggle(d))
    listen('preview-text',      d => this.#previewText(d))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Handlers
  // ─────────────────────────────────────────────────────────────────────────

  #sendMessage({ channelId, text, attachments = [], priority = 'normal' }) {
    if (!text?.trim() && attachments.length === 0) return
    this.#ws.send({
      t: 'msg.send',
      body: {
        channel_id: channelId,
        text: text?.trim() ?? '',
        client_msg_id: `local_${Date.now()}`,
        priority,
        attachments: attachments.map(a => ({
          upload_id:  a.upload_id,
          url:        a.url,
          filename:   a.original_name,
          mime_type:  a.mime_type,
          size_bytes: a.size_bytes,
        })),
      },
    })
  }

  #sendThreadReply({ channelId, parentMsgId, text, attachments = [] }) {
    if (!text?.trim()) return
    this.#ws.send({
      t: 'msg.send',
      body: {
        channel_id:    channelId,
        text:          text.trim(),
        parent_msg_id: parentMsgId,
        attachments:   attachments.map(a => ({
          upload_id:  a.upload_id,
          url:        a.url,
          filename:   a.original_name,
          mime_type:  a.mime_type,
          size_bytes: a.size_bytes,
        })),
      },
    })
  }

  #react({ msgId, channelId, emoji }) {
    this.#ws.send({ t: 'reaction.add', body: { msg_id: msgId, emoji, channel_id: channelId } })
  }

  #unreact({ msgId, channelId, emoji }) {
    this.#ws.send({ t: 'reaction.remove', body: { msg_id: msgId, emoji, channel_id: channelId } })
  }

  #editMessage({ msgId, channelId, text }) {
    this.#ws.send({ t: 'msg.edit', body: { msg_id: msgId, channel_id: channelId, text } })
  }

  #deleteMessage({ msgId, channelId }) {
    this.#ws.send({ t: 'msg.delete', body: { msg_id: msgId, channel_id: channelId } })
  }

  #openThread({ msgId }) {
    const model = this.#model
    // Find the parent message in the model cache
    const channelId = model.currentChannelId
    const msgs      = model.messagesFor(channelId)
    const parentMsg = msgs.find(m => m.msg_id === msgId) ?? null
    model.openThread(msgId, parentMsg)
    // Fetch replies
    this.#ws.send({ t: 'thread.list', body: { parent_msg_id: msgId, channel_id: channelId } })
  }

  #closeThread() {
    this.#model.closeThread()
  }

  #loadMore({ channelId, beforeSeq }) {
    if (this.#model.loadingMore) return
    this.#model.setLoadingMore(true)
    this.#ws.send({ t: 'msg.list', body: { channel_id: channelId, before_seq: beforeSeq } })
  }

  #openDm({ targetUserId }) {
    this.#ws.send({ t: 'dm.open', body: { target_user_id: targetUserId } })
  }

  #selectChannel({ channelId, meta }) {
    const model = this.#model
    const prev  = model.currentChannelId

    model.selectChannel(channelId, meta ?? {})

    if (prev && prev !== channelId) {
      this.#ws.send({ t: 'channel.leave', body: { channel_id: prev } })
    }

    this.#ws.send({ t: 'channel.join', body: { channel_id: channelId } })

    // Request messages since seed (0 = fetch latest 50)
    // We only fetch if we don't already have a cache for this channel
    if (model.messagesFor(channelId).length === 0) {
      this.#ws.send({ t: 'msg.list', body: { channel_id: channelId, after_seq: 0 } })
    }

    if (model.members.length === 0) {
      this.#ws.send({ t: 'user.list', body: {} })
      this.#ws.send({ t: 'bot.list',  body: {} })
    }
  }

  #taskToggle({ msgId, channelId, text }) {
    // Task checkboxes: send the full updated text with checkbox toggled
    this.#ws.send({ t: 'msg.edit', body: { msg_id: msgId, channel_id: channelId, text } })
  }

  async #previewText({ text, resolve }) {
    try {
      const base = window.__BASE_PATH__ ?? ''
      const res  = await fetch(`${base}/api/preview`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
      })
      if (res.ok) {
        const { html } = await res.json()
        resolve?.(html)
      } else {
        resolve?.(null)
      }
    } catch {
      resolve?.(null)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: dispatch a controller event from anywhere in the view layer.
// Views call e.g. dispatch('open-thread', { msgId }) instead of importing
// ChatController directly.
// ─────────────────────────────────────────────────────────────────────────────

export function dispatch(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(name, { detail, bubbles: false }))
}
