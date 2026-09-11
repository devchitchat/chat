/**
 * AppModel.js — single source of truth for all client-side state.
 *
 * Extends EventTarget so any object can call:
 *   model.addEventListener('message-added', handler)
 *
 * Rules:
 *   - No DOM imports. No ws.send(). Pure state + events.
 *   - Every mutator method ends by dispatching a CustomEvent.
 *   - Views read from the model only via events (or getters on initial render).
 *   - Controllers call mutators; they never dispatch events directly.
 */

import * as Ev from './events.js'

export class AppModel extends EventTarget {
  // ── Identity ────────────────────────────────────────────────────────────────
  #userId      = null
  #userHandle  = null

  // ── Sidebar state ───────────────────────────────────────────────────────────
  #hubs     = []   // [{ hub_id, name, visibility, channels:[] }]
  #dms      = []   // [{ channel_id, name, user_id, handle, online }]
  #presence = new Map()  // userId → 'online'|'away'|'offline'

  // ── Members (for @mention picker) ──────────────────────────────────────────
  #members = []  // [{ user_id, handle, display_name }] — all users + bots
  #bots    = []

  // ── Navigation ─────────────────────────────────────────────────────────────
  #currentChannelId = null
  #currentChannelMeta = {}  // { name, topic, kind, visibility }

  // ── Messages (cached per channel) ──────────────────────────────────────────
  //   channelId → Message[]  (chronological, oldest first)
  #messages   = new Map()
  #oldestSeq  = new Map()   // channelId → number (lowest seq seen)
  #hasMore    = new Map()   // channelId → bool
  #loadingMore = false

  // ── Thread panel ───────────────────────────────────────────────────────────
  #threadParentId  = null
  #threadParentMsg = null
  #threads         = new Map()  // parentMsgId → Reply[]

  // ── Call ────────────────────────────────────────────────────────────────────
  #call = null  // null = no active call; otherwise opaque object from WebSocketController

  // ─────────────────────────────────────────────────────────────────────────
  // Identity
  // ─────────────────────────────────────────────────────────────────────────

  get userId()     { return this.#userId }
  get userHandle() { return this.#userHandle }

  setIdentity({ userId, userHandle }) {
    this.#userId     = userId
    this.#userHandle = userHandle
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hubs & DMs
  // ─────────────────────────────────────────────────────────────────────────

  get hubs() { return this.#hubs }
  get dms()  { return this.#dms }

  setHubs(hubs) {
    this.#hubs = hubs
    this.#dispatch(Ev.HUBS_CHANGED, { hubs })
  }

  setDms(dms) {
    this.#dms = dms
    this.#dispatch(Ev.DMS_CHANGED, { dms })
  }

  /** Add or update a single hub */
  upsertHub(hub) {
    const idx = this.#hubs.findIndex(h => h.hub_id === hub.hub_id)
    if (idx === -1) {
      this.#hubs = [...this.#hubs, { ...hub, channels: hub.channels ?? [] }]
    } else {
      const existing = this.#hubs[idx]
      this.#hubs = [
        ...this.#hubs.slice(0, idx),
        { ...existing, ...hub, channels: hub.channels ?? existing.channels },
        ...this.#hubs.slice(idx + 1),
      ]
    }
    this.#dispatch(Ev.HUBS_CHANGED, { hubs: this.#hubs })
  }

  removeHub(hubId) {
    this.#hubs = this.#hubs.filter(h => h.hub_id !== hubId)
    this.#dispatch(Ev.HUBS_CHANGED, { hubs: this.#hubs })
  }

  /** Add or update a channel inside its hub */
  upsertChannel(channel) {
    const hubIdx = this.#hubs.findIndex(h => h.hub_id === channel.hub_id)
    if (hubIdx === -1) return
    const hub = this.#hubs[hubIdx]
    const chIdx = hub.channels.findIndex(c => c.channel_id === channel.channel_id)
    const channels = chIdx === -1
      ? [...hub.channels, channel]
      : hub.channels.map((c, i) => i === chIdx ? { ...c, ...channel } : c)
    this.#hubs = this.#hubs.map((h, i) => i === hubIdx ? { ...h, channels } : h)
    this.#dispatch(Ev.HUBS_CHANGED, { hubs: this.#hubs })
  }

  removeChannel(channelId) {
    this.#hubs = this.#hubs.map(h => ({
      ...h,
      channels: h.channels.filter(c => c.channel_id !== channelId),
    }))
    this.#dispatch(Ev.HUBS_CHANGED, { hubs: this.#hubs })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Presence
  // ─────────────────────────────────────────────────────────────────────────

  get presence() { return this.#presence }

  setPresence(userId, status) {
    this.#presence.set(userId, status)
    this.#dispatch(Ev.PRESENCE_UPDATED, { userId, status })
  }

  setBulkPresence(entries) {
    for (const { user_id, status } of entries) {
      this.#presence.set(user_id, status)
    }
    this.#dispatch(Ev.PRESENCE_UPDATED, { bulk: entries })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Members (mention picker)
  // ─────────────────────────────────────────────────────────────────────────

  get members() { return this.#members }
  get bots()    { return this.#bots }

  /** Set of all known @handles (users + bots), lowercased, for mention validation. */
  get knownHandles() {
    return new Set([
      ...this.#members.map(m => m.handle.toLowerCase()),
      ...this.#bots.map(b => b.handle.toLowerCase()),
    ])
  }

  setMembers(members) {
    this.#members = members
    this.#dispatch(Ev.MEMBERS_UPDATED, { members, bots: this.#bots })
  }

  setBots(bots) {
    this.#bots = bots
    this.#dispatch(Ev.MEMBERS_UPDATED, { members: this.#members, bots })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Navigation
  // ─────────────────────────────────────────────────────────────────────────

  get currentChannelId()   { return this.#currentChannelId }
  get currentChannelMeta() { return this.#currentChannelMeta }

  selectChannel(channelId, meta = {}) {
    const prev = this.#currentChannelId
    this.#currentChannelId   = channelId
    this.#currentChannelMeta = meta
    this.#dispatch(Ev.CHANNEL_SELECTED, { channelId, prev, meta })
  }

  updateChannelMeta(channelId, patch) {
    if (channelId === this.#currentChannelId) {
      this.#currentChannelMeta = { ...this.#currentChannelMeta, ...patch }
    }
    this.#dispatch(Ev.CHANNEL_META_UPDATED, { channelId, ...patch })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Messages
  // ─────────────────────────────────────────────────────────────────────────

  messagesFor(channelId) {
    return this.#messages.get(channelId) ?? []
  }

  oldestSeqFor(channelId) {
    return this.#oldestSeq.get(channelId) ?? 0
  }

  newestSeqFor(channelId) {
    const msgs = this.#messages.get(channelId) ?? []
    if (msgs.length === 0) return 0
    return Math.max(...msgs.map(m => m.seq ?? 0))
  }

  hasMoreFor(channelId) {
    return this.#hasMore.get(channelId) ?? false
  }

  get loadingMore() { return this.#loadingMore }

  /**
   * Called on first load: seed messages from SSR are already in the DOM.
   * We just record the sequence bookmarks; the view does not re-render them.
   */
  seedMessages(channelId, { oldestSeq, hasMore }) {
    if (!this.#messages.has(channelId)) this.#messages.set(channelId, [])
    this.#oldestSeq.set(channelId, oldestSeq)
    this.#hasMore.set(channelId, hasMore)
  }

  addMessage(channelId, message) {
    const msgs = this.#messages.get(channelId) ?? []
    // Deduplicate by msg_id
    if (msgs.some(m => m.msg_id === message.msg_id)) return
    this.#messages.set(channelId, [...msgs, message])
    this.#dispatch(Ev.MESSAGE_ADDED, { channelId, message })
  }

  updateMessage(channelId, message) {
    const msgs = this.#messages.get(channelId) ?? []
    this.#messages.set(channelId, msgs.map(m => m.msg_id === message.msg_id ? { ...m, ...message } : m))
    this.#dispatch(Ev.MESSAGE_UPDATED, { channelId, message })
  }

  deleteMessage(channelId, msgId) {
    const msgs = this.#messages.get(channelId) ?? []
    this.#messages.set(channelId, msgs.filter(m => m.msg_id !== msgId))
    this.#dispatch(Ev.MESSAGE_DELETED, { channelId, msgId })
  }

  setReactions(msgId, channelId, reactions) {
    const msgs = this.#messages.get(channelId) ?? []
    this.#messages.set(channelId, msgs.map(m =>
      m.msg_id === msgId ? { ...m, reactions } : m
    ))
    this.#dispatch(Ev.REACTIONS_UPDATED, { msgId, channelId, reactions })
  }

  /**
   * Older messages loaded by pagination (prepend direction).
   * msgs: oldest-first array.
   */
  prependMessages(channelId, msgs, hasMore) {
    const existing = this.#messages.get(channelId) ?? []
    // Avoid duplicates that may have arrived via msg.event while loading
    const existingIds = new Set(existing.map(m => m.msg_id))
    const unique = msgs.filter(m => !existingIds.has(m.msg_id))
    this.#messages.set(channelId, [...unique, ...existing])
    if (msgs.length > 0) {
      const minSeq = Math.min(...msgs.map(m => m.seq ?? Infinity))
      const prev = this.#oldestSeq.get(channelId) ?? Infinity
      if (minSeq < prev) this.#oldestSeq.set(channelId, minSeq)
    }
    this.#hasMore.set(channelId, hasMore)
    this.setLoadingMore(false)
    this.#dispatch(Ev.MESSAGES_PREPENDED, { channelId, messages: unique, hasMore })
  }

  setLoadingMore(loading) {
    this.#loadingMore = loading
    this.#dispatch(Ev.LOADING_MORE_CHANGED, { loading })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Thread panel
  // ─────────────────────────────────────────────────────────────────────────

  get threadParentId()  { return this.#threadParentId }
  get threadParentMsg() { return this.#threadParentMsg }

  threadRepliesFor(parentMsgId) {
    return this.#threads.get(parentMsgId) ?? []
  }

  openThread(parentMsgId, parentMsg) {
    this.#threadParentId  = parentMsgId
    this.#threadParentMsg = parentMsg
    this.#dispatch(Ev.THREAD_OPENED, { parentMsgId, parentMsg })
  }

  closeThread() {
    this.#threadParentId  = null
    this.#threadParentMsg = null
    this.#dispatch(Ev.THREAD_CLOSED, {})
  }

  loadThreadReplies(parentMsgId, replies) {
    this.#threads.set(parentMsgId, replies)
    this.#dispatch(Ev.THREAD_LOADED, { parentMsgId, replies })
  }

  addThreadReply(parentMsgId, reply) {
    const existing = this.#threads.get(parentMsgId) ?? []
    if (existing.some(r => r.msg_id === reply.msg_id)) return
    this.#threads.set(parentMsgId, [...existing, reply])

    // Also update reply count on the parent message in every channel cache
    for (const [channelId, msgs] of this.#messages) {
      const parent = msgs.find(m => m.msg_id === parentMsgId)
      if (parent) {
        this.updateMessage(channelId, {
          ...parent,
          reply_count: (parent.reply_count ?? 0) + 1,
        })
        break
      }
    }

    this.#dispatch(Ev.THREAD_REPLY_ADDED, { parentMsgId, reply })
  }

  updateThreadReply(parentMsgId, reply) {
    const existing = this.#threads.get(parentMsgId) ?? []
    this.#threads.set(parentMsgId, existing.map(r =>
      r.msg_id === reply.msg_id ? { ...r, ...reply } : r
    ))
    this.#dispatch(Ev.THREAD_REPLY_UPDATED, { parentMsgId, reply })
  }

  deleteThreadReply(parentMsgId, msgId) {
    const existing = this.#threads.get(parentMsgId) ?? []
    this.#threads.set(parentMsgId, existing.filter(r => r.msg_id !== msgId))
    this.#dispatch(Ev.THREAD_REPLY_DELETED, { parentMsgId, msgId })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Call
  // ─────────────────────────────────────────────────────────────────────────

  get call() { return this.#call }

  setCall(call) {
    this.#call = call
    this.#dispatch(Ev.CALL_CHANGED, { call })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #dispatch(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: false }))
  }
}
