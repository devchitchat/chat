/**
 * events.js — AppModel event name constants.
 *
 * All CustomEvents dispatched by AppModel use these names.
 * Import this wherever you listen to or dispatch model events.
 *
 * Convention: "<noun>-<verb>" in lowercase with hyphens (browser DOM style).
 */

// ── Navigation ────────────────────────────────────────────────────────────────
export const CHANNEL_SELECTED      = 'channel-selected'       // { channelId, prev }

// ── Channel list (sidebar) ───────────────────────────────────────────────────
export const CHANNELS_CHANGED      = 'channels-changed'       // { channels: { public, private, sessions, dms } }
export const DMS_CHANGED           = 'dms-changed'            // { dms } — fired when a new DM conversation is opened
export const PRESENCE_UPDATED      = 'presence-updated'       // { userId, status }
export const MEMBERS_UPDATED       = 'members-updated'        // { channelId, members, bots }

// ── Messages ──────────────────────────────────────────────────────────────────
export const MESSAGE_ADDED         = 'message-added'          // { channelId, message }
export const MESSAGE_UPDATED       = 'message-updated'        // { channelId, message }
export const MESSAGE_DELETED       = 'message-deleted'        // { channelId, msgId }
export const MESSAGES_PREPENDED    = 'messages-prepended'     // { channelId, messages, hasMore }
export const REACTIONS_UPDATED     = 'reactions-updated'      // { msgId, channelId, reactions }

// ── Thread sidebar ────────────────────────────────────────────────────────────
export const CHANNEL_THREADS_UPDATED = 'channel-threads-updated' // { channelId, threads }

// ── Thread panel ──────────────────────────────────────────────────────────────
export const THREAD_OPENED         = 'thread-opened'          // { parentMsgId, parentMsg }
export const THREAD_CLOSED         = 'thread-closed'          // {}
export const THREAD_LOADED         = 'thread-loaded'          // { parentMsgId, replies }
export const THREAD_REPLY_ADDED    = 'thread-reply-added'     // { parentMsgId, reply }
export const THREAD_REPLY_UPDATED  = 'thread-reply-updated'   // { parentMsgId, reply }
export const THREAD_REPLY_DELETED  = 'thread-reply-deleted'   // { parentMsgId, msgId }

// ── Pagination ────────────────────────────────────────────────────────────────
export const LOADING_MORE_CHANGED  = 'loading-more-changed'   // { loading }

// ── Channel metadata ──────────────────────────────────────────────────────────
export const CHANNEL_META_UPDATED  = 'channel-meta-updated'   // { channelId, name, topic }

// ── Unread / mentions ─────────────────────────────────────────────────────────
export const MENTIONS_UPDATED      = 'mentions-updated'       // { mentionedChannels, urgentChannels }
export const DMS_UPDATED           = 'dms-updated'            // { dmUnread }

// ── Call ──────────────────────────────────────────────────────────────────────
export const CALL_CHANGED          = 'call-changed'           // { call }

// ── User profile ──────────────────────────────────────────────────────────────
export const PROFILE_UPDATED       = 'profile-updated'        // { userId, avatar_initials, avatar_color, avatar_url, display_name }
