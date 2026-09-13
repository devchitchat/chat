/**
 * app.js — MVC bootstrap.
 *
 * Wiring order (inside-out):
 *   1. AppModel            — single source of truth (EventTarget hub)
 *   2. WebSocketController — maps WS events to model mutations
 *   3. ChatController      — maps document CustomEvents to ws.send / model
 *   4. Views               — listen to model, render DOM, dispatch controller events
 *   5. Router + swipe nav  — SPA navigation; notifies model on channel change
 *
 * No rdbljs. No islands. Plain browser APIs throughout.
 */

import { AppModel }              from './model/AppModel.js'
import { WebSocketController }   from './controllers/WebSocketController.js'
import { ChatController }        from './controllers/ChatController.js'
import { MessageListView }       from './views/MessageListView.js'
import { ThreadPanelView }       from './views/ThreadPanelView.js'
import { ComposerView }          from './views/ComposerView.js'
import { SidebarView }           from './views/SidebarView.js'
import { CallView }              from './views/CallView.js'
import { ChatHeaderView }        from './views/ChatHeaderView.js'
import { cancelActiveEdit }      from './views/shared/MessageInteractions.js'
import { closeEmojiPicker }      from './views/shared/EmojiPickerSingleton.js'
import { getSettings, syncFromServer, patchSettings } from './settings-sync.js'
import { initSwipeNav }          from './swipe-nav.js'
import { initRouter }            from './router.js'
import { attachResizeHandle }    from './resizable.js'

const BASE_PATH = window.__BASE_PATH__ ?? ''

// ── 1. Pre-mount: apply settings to prevent layout flash ─────────────────────

if (location.pathname.startsWith(`${BASE_PATH}/channels/`)) {
  const channelId = location.pathname.split('/').pop()
  if (channelId) patchSettings({ last_channel_id: channelId, mobile_chat_open: true })
}

const settings = getSettings()
if (window.matchMedia('(max-width: 1024px)').matches && settings.mobile_chat_open === false) {
  document.body.classList.add('sidebar-open')
}

// ── 2. Model ──────────────────────────────────────────────────────────────────

const model = new AppModel()

// Seed identity from the chat panel's data attributes (written by SSR)
const chatPanelEl = document.querySelector('.chat-panel')
if (chatPanelEl) {
  model.setIdentity({
    userId:     chatPanelEl.dataset.userId ?? null,
    userHandle: chatPanelEl.dataset.userHandle ?? null,
  })
  // Seed the current channel
  const channelId   = chatPanelEl.dataset.id ?? null
  const seedFirstSeq = parseInt(chatPanelEl.dataset.seedFirstSeq ?? '0', 10)
  const seedHasMore  = chatPanelEl.dataset.seedHasMore === 'true'
  if (channelId) {
    model.selectChannel(channelId, {
      name:       chatPanelEl.dataset.name  ?? '',
      topic:      chatPanelEl.dataset.topic ?? '',
      kind:       chatPanelEl.dataset.kind  ?? 'text',
    })
    model.seedMessages(channelId, { oldestSeq: seedFirstSeq, hasMore: seedHasMore })
  }
}

// ── 3. Controllers ────────────────────────────────────────────────────────────

const wsController   = new WebSocketController(model, `${BASE_PATH}/ws`)
const ws             = wsController.ws
new ChatController(model, ws)

// ── 4. Views ──────────────────────────────────────────────────────────────────

// Sidebar
const sidebarEl = document.querySelector('aside[data-sidebar], aside.sidebar, aside')
if (sidebarEl) {
  new SidebarView(model, ws, sidebarEl)
}

// Chat panel views (only mount if the chat panel exists on this page)
if (chatPanelEl) {
  const messagesEl   = document.getElementById('messages')
  const sentinelEl   = document.getElementById('load-more-sentinel')
  const composerEl   = chatPanelEl.querySelector('.composer')
  const threadPanelEl = document.getElementById('thread-panel')

  const headerEl = chatPanelEl.querySelector('.chat-header')
  if (headerEl) {
    new ChatHeaderView(model, headerEl)
  }

  if (messagesEl) {
    new MessageListView(model, messagesEl, sentinelEl)
  }

  if (threadPanelEl) {
    new ThreadPanelView(model, threadPanelEl)
    attachResizeHandle(threadPanelEl, {
      edge:       'left',
      cssVar:     '--thread-panel-width',
      min:        260,
      max:        640,
      prefKey: 'thread_panel_width',
    })
  }

  if (composerEl) {
    new ComposerView(model, composerEl)
  }

  // CallView (WebRTC) — only if call UI elements are present
  const tilePanelEl = document.getElementById('tile-panel')
  if (tilePanelEl || document.getElementById('btn-start-call')) {
    new CallView(model, ws)
  }
  if (tilePanelEl) {
    attachResizeHandle(tilePanelEl, {
      edge:       'left',
      cssVar:     '--tile-panel-width',
      min:        200,
      max:        640,
      prefKey: 'tile_panel_width',
    })
  }
}

// Sidebar resize — desktop only (mobile sidebar is full-screen overlay)
if (sidebarEl && window.matchMedia('(min-width: 769px)').matches) {
  attachResizeHandle(sidebarEl, {
    edge:       'right',
    cssVar:     '--sidebar-width',
    min:        180,
    max:        480,
    prefKey: 'sidebar_width',
  })
}

// ── 5. SPA navigation ─────────────────────────────────────────────────────────

// router.js morphs the DOM and dispatches 'chatpanel:navigated'.
// We update the model here so views react automatically.
document.addEventListener('chatpanel:navigated', e => {
  const { channelId, name, topic, kind, seedFirstSeq, seedHasMore } = e.detail

  // Close transient UI on navigation
  cancelActiveEdit()
  closeEmojiPicker()
  if (model.threadParentId) model.closeThread()

  // Update identity if it changed (shouldn't, but guard anyway)
  const panel = document.querySelector('.chat-panel')
  if (panel?.dataset.userId) {
    model.setIdentity({ userId: panel.dataset.userId, userHandle: panel.dataset.userHandle ?? null })
  }

  // Seed pagination bookmarks for the new channel
  if (channelId) {
    model.seedMessages(channelId, {
      oldestSeq: parseInt(seedFirstSeq ?? '0', 10),
      hasMore:   seedHasMore ?? false,
    })
  }

  // Navigate — fires 'channel-selected' → all views update
  model.selectChannel(channelId, { name, topic, kind })

  // Join the new channel on the server (WebSocketController handles the response)
  ws.send({ t: 'channel.join', body: { channel_id: channelId } })

  // Persist for PWA restore
  if (channelId) patchSettings({ last_channel_id: channelId, mobile_chat_open: true })
})

// ── 6. Router + swipe nav ────────────────────────────────────────────────────

initRouter()
initSwipeNav()

// ── 7. Post-mount: reconcile settings with server ─────────────────────────────

syncFromServer().then(remoteSettings => {
  if (!remoteSettings || !window.matchMedia('(max-width: 1024px)').matches) return
  document.body.classList.toggle('sidebar-open', remoteSettings.mobile_chat_open === false)
})

// ── 8. Global keyboard shortcuts ──────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    cancelActiveEdit()
    closeEmojiPicker()
  }
})
