/**
 * AppModel.js — single source of truth for all client-side state.
 *
 * Extends EventTarget so any object can call:
 *   model.addEventListener('channel-selected', handler)
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
  //   Flat channel buckets — each entry is a channel object:
  //     public/private/sessions: { channel_id, name, kind, visibility, unread, threadCount }
  //     dms: { channel_id, name, handle, user_id, online, unread }
  #channels = { public: [], private: [], sessions: [], dms: [] }

  #presence = new Map()  // userId → 'online'|'away'|'offline'

  // ── Members (for @mention picker) ──────────────────────────────────────────
  #members = []  // [{ user_id, handle, display_name }]
  #bots    = []

  // ── Navigation ─────────────────────────────────────────────────────────────
  #currentChannelId   = null
  #currentChannelMeta = {}  // { name, topic, kind, visibility }

  // ── Messages (cached per channel) ──────────────────────────────────────────
  //   channelId → Message[]  (chronological, oldest first)
  #messages    = new Map()
  #oldestSeq   = new Map()   // channelId → number (lowest seq seen)
  #newestSeq   = new Map()   // channelId → number (highest seq from SSR seed; overridden by cache)
  #hasMore     = new Map()   // channelId → bool
  #loadingMore = false

  // ── Thread panel ───────────────────────────────────────────────────────────
  #threadParentId  = null
  #threadParentMsg = null
  #threads         = new Map()  // parentMsgId → Reply[]

  // ── Call ────────────────────────────────────────────────────────────────────
  #call = null  // null = no active call; otherwise opaque object from WebSocketController

  // ── Inline reply ─────────────────────────────────────────────────────────────
  #replyTo = null  // null | { msgId, handle, text }

  // ── Channel thread lists (sidebar) ────────────────────────────────────────────
  #channelThreads = new Map()  // channelId → Thread[]

  // ── Activity feed ────────────────────────────────────────────────────────────
  #activityItems = []  // [{ type, text, sub, time, unread, initials }]

  // ── Avatars ───────────────────────────────────────────────────────────────────
  #avatars = new Map()  // userId → { avatar_initials, avatar_color, avatar_url }

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
  // Channels & DMs
  // ─────────────────────────────────────────────────────────────────────────

  get channels() { return this.#channels }

  /** Backwards-compat getter — DMs are stored in channels.dms */
  get dms() { return this.#channels.dms }

  /**
   * Replace the full channel set. `channels` must be shaped as:
   *   { public: [], private: [], sessions: [], dms: [] }
   */
  setChannels(channels) {
    this.#channels = {
      public:   channels.public   ?? [],
      private:  channels.private  ?? [],
      sessions: channels.sessions ?? [],
      dms:      channels.dms      ?? [],
    }
    this.#dispatch(Ev.CHANNELS_CHANGED, { channels: this.#channels })
  }

  /**
   * Replace only the DMs list.
   * Fires CHANNELS_CHANGED (sidebar re-renders) and DMS_CHANGED (for focused DM listeners).
   */
  setDms(dms) {
    this.#channels = { ...this.#channels, dms }
    this.#dispatch(Ev.CHANNELS_CHANGED, { channels: this.#channels })
    this.#dispatch(Ev.DMS_CHANGED, { dms })
  }

  /**
   * Add or update a single channel in the correct section.
   * Section is derived from kind + visibility:
   *   kind='dm'      → dms
   *   kind='session' → sessions
   *   visibility='private' → private
   *   default        → public
   */
  upsertChannel(channel) {
    // Find the existing entry across all sections so partial updates (e.g. only
    // channel_id + session_ends_at) still route to the correct section.
    let existingSection = null
    let existingChannel = null
    for (const [sec, list] of Object.entries(this.#channels)) {
      const found = list.find(c => c.channel_id === channel.channel_id)
      if (found) { existingSection = sec; existingChannel = found; break }
    }

    const merged  = existingChannel ? { ...existingChannel, ...channel } : channel
    const section = existingSection ?? this.#sectionFor(merged)
    const list    = this.#channels[section] ?? []
    const idx     = list.findIndex(c => c.channel_id === channel.channel_id)
    const updated = idx === -1
      ? [...list, merged]
      : list.map((c, i) => i === idx ? merged : c)
    this.#channels = { ...this.#channels, [section]: updated }
    this.#dispatch(Ev.CHANNELS_CHANGED, { channels: this.#channels })
  }

  removeChannel(channelId) {
    const updated = {}
    for (const [key, list] of Object.entries(this.#channels)) {
      updated[key] = list.filter(c => c.channel_id !== channelId)
    }
    this.#channels = updated
    this.#dispatch(Ev.CHANNELS_CHANGED, { channels: this.#channels })
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
    return this.#newestSeq.get(channelId) ?? 0
  }

  hasMoreFor(channelId) {
    return this.#hasMore.get(channelId) ?? false
  }

  get loadingMore() { return this.#loadingMore }

  /**
   * Called on first load: seed messages from SSR are already in the DOM.
   * We just record the sequence bookmarks; the view does not re-render them.
   */
  seedMessages(channelId, { oldestSeq, newestSeq, hasMore }) {
    if (!this.#messages.has(channelId)) this.#messages.set(channelId, [])
    this.#oldestSeq.set(channelId, oldestSeq)
    if (newestSeq) this.#newestSeq.set(channelId, newestSeq)
    this.#hasMore.set(channelId, hasMore)
  }

  addMessage(channelId, message) {
    const msgs = this.#messages.get(channelId) ?? []
    // Deduplicate by msg_id
    if (msgs.some(m => m.msg_id === message.msg_id)) return
    this.#messages.set(channelId, [...msgs, message])
    // Keep #newestSeq authoritative
    this.#newestSeq.set(channelId, Math.max(this.#newestSeq.get(channelId) ?? 0, message.seq ?? 0))
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
      // Keep #newestSeq authoritative
      const maxSeq = Math.max(...msgs.map(m => m.seq ?? 0))
      this.#newestSeq.set(channelId, Math.max(this.#newestSeq.get(channelId) ?? 0, maxSeq))
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
  // Channel thread lists (sidebar)
  // ─────────────────────────────────────────────────────────────────────────

  channelThreadsFor(channelId) {
    return this.#channelThreads.get(channelId) ?? []
  }

  setChannelThreads(channelId, threads) {
    this.#channelThreads.set(channelId, threads)
    this.#dispatch(Ev.CHANNEL_THREADS_UPDATED, { channelId, threads })
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
  // Inline reply
  // ─────────────────────────────────────────────────────────────────────────

  get replyTo() { return this.#replyTo }

  setReplyTo({ msgId, handle, text }) {
    this.#replyTo = { msgId, handle, text }
    this.#dispatch('reply-changed', { replyTo: this.#replyTo })
  }

  clearReply() {
    this.#replyTo = null
    this.#dispatch('reply-changed', { replyTo: null })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Activity feed
  // ─────────────────────────────────────────────────────────────────────────

  get activityItems() { return this.#activityItems }

  addActivityItem(item) {
    this.#activityItems = [item, ...this.#activityItems].slice(0, 100)
    this.#dispatch('activity-item-added', { item, items: this.#activityItems })
  }

  markActivityRead() {
    this.#activityItems = this.#activityItems.map(i => ({ ...i, unread: false }))
    this.#dispatch('activity-read', {})
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mention / DM unread indicators (sidebar dots)
  // ─────────────────────────────────────────────────────────────────────────

  #mentionedChannels = new Set()  // channel_ids with @mention
  #urgentChannels    = new Set()  // channel_ids with urgent mention
  #dmUnread          = new Set()  // channel_ids with unread DM

  get mentionedChannels() { return this.#mentionedChannels }
  get urgentChannels()    { return this.#urgentChannels }
  get dmUnread()          { return this.#dmUnread }

  addMention(channelId, urgent = false) {
    if (urgent) this.#urgentChannels.add(channelId)
    else this.#mentionedChannels.add(channelId)
    this.#dispatch(Ev.MENTIONS_UPDATED, { mentionedChannels: this.#mentionedChannels, urgentChannels: this.#urgentChannels })
  }

  addDmUnread(channelId) {
    this.#dmUnread.add(channelId)
    this.#dispatch(Ev.DMS_UPDATED, { dmUnread: this.#dmUnread })
  }

  clearChannelUnread(channelId) {
    this.#mentionedChannels.delete(channelId)
    this.#urgentChannels.delete(channelId)
    this.#dmUnread.delete(channelId)
    this.#dispatch(Ev.MENTIONS_UPDATED, { mentionedChannels: this.#mentionedChannels, urgentChannels: this.#urgentChannels })
    this.#dispatch(Ev.DMS_UPDATED, { dmUnread: this.#dmUnread })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Determine which section of #channels a channel belongs to.
   *   kind='dm'            → 'dms'
   *   kind='session'       → 'sessions'
   *   visibility='private' → 'private'
   *   default              → 'public'
   */
  #sectionFor(channel) {
    if (channel.kind === 'dm')           return 'dms'
    if (channel.kind === 'session')      return 'sessions'
    if (channel.visibility === 'private') return 'private'
    return 'public'
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Avatars
  // ─────────────────────────────────────────────────────────────────────────

  getMemberAvatar(userId) {
    return this.#avatars.get(userId) ?? null
  }

  updateMemberProfile({ user_id, avatar_initials, avatar_color, avatar_url, display_name }) {
    this.#avatars.set(user_id, { avatar_initials: avatar_initials ?? null, avatar_color: avatar_color ?? null, avatar_url: avatar_url ?? null })
    this.#dispatch(Ev.PROFILE_UPDATED, { userId: user_id, avatar_initials, avatar_color, avatar_url, display_name })
  }

  #dispatch(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: false }))
  }
}
