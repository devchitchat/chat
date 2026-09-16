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
import { ThreadToggleView }      from './views/ThreadToggleView.js'
import { SessionBannerView }     from './views/SessionBannerView.js'
import { SearchSheetView }       from './views/SearchSheetView.js'
import { cancelActiveEdit }      from './views/shared/MessageInteractions.js'
import { closeEmojiPicker }      from './views/shared/EmojiPickerSingleton.js'
import { getSettings, syncFromServer, patchSettings } from './settings-sync.js'
import { initSwipeNav }          from './swipe-nav.js'
import { initRouter }            from './router.js'
import { attachResizeHandle }    from './resizable.js'
import { attachSheetSwipeDismiss } from './swipe-dismiss.js'

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
  const channelId    = chatPanelEl.dataset.id ?? null
  const seedFirstSeq = parseInt(chatPanelEl.dataset.seedFirstSeq ?? '0', 10)
  const seedSeq      = parseInt(chatPanelEl.dataset.seedSeq      ?? '0', 10)
  const seedHasMore  = chatPanelEl.dataset.seedHasMore === 'true'
  if (channelId) {
    model.selectChannel(channelId, {
      name:            chatPanelEl.dataset.name       ?? '',
      topic:           chatPanelEl.dataset.topic      ?? '',
      kind:            chatPanelEl.dataset.kind       ?? 'text',
      visibility:      chatPanelEl.dataset.visibility ?? 'public',
      isMember:        chatPanelEl.dataset.isMember !== 'false',
      isSessionEnded:  chatPanelEl.dataset.isSessionEnded === 'true',
      isSessionOwner:  chatPanelEl.dataset.isSessionOwner === 'true',
    })
    model.seedMessages(channelId, { oldestSeq: seedFirstSeq, newestSeq: seedSeq, hasMore: seedHasMore })
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

  // Seed pagination bookmarks for the new channel (newestSeq drives msg.list catch-up)
  if (channelId) {
    model.seedMessages(channelId, {
      oldestSeq: parseInt(seedFirstSeq ?? '0', 10),
      newestSeq: parseInt(e.detail.seedSeq ?? '0', 10),
      hasMore:   seedHasMore ?? false,
    })
  }

  // Navigate — fires 'channel-selected' → all views update
  model.selectChannel(channelId, {
    name, topic, kind,
    visibility:     panel?.dataset.visibility ?? 'public',
    isMember:       panel?.dataset.isMember !== 'false',
    isSessionEnded: panel?.dataset.isSessionEnded === 'true',
    isSessionOwner: panel?.dataset.isSessionOwner === 'true',
  })

  // Update join banner visibility
  _updateJoinBanner()

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

// ── 7b. Thread panel toggle button ───────────────────────────────────────────

{
  const btnThreadToggle = document.getElementById('btn-thread-toggle')
  const threadPanelEl   = document.getElementById('thread-panel')
  if (btnThreadToggle && threadPanelEl) {
    new ThreadToggleView(model, btnThreadToggle, threadPanelEl)
  }
}

// ── 7c. Session banner view ──────────────────────────────────────────────────

new SessionBannerView(model)

// ── 7d. Search sheet view ───────────────────────────────────────────────────

const searchSheetView = new SearchSheetView(model, ws)

// Sidebar search button (desktop only — footer icon, hidden on mobile via CSS)
const sidebarSearchTrigger = document.getElementById('sidebar-search-trigger')
if (sidebarSearchTrigger) {
  sidebarSearchTrigger.addEventListener('click', () => searchSheetView.open())
}

// ── 8. Bottom nav (mobile) + sidebar search (desktop) ────────────────────────

const btnNavChannels = document.getElementById('btn-nav-channels')
const btnNavActivity = document.getElementById('btn-nav-activity')
const btnNavSearch   = document.getElementById('btn-nav-search')
const btnNavYou      = document.getElementById('btn-nav-you')

// Channels tab → show sidebar (go back to channel list on mobile)
if (btnNavChannels) {
  btnNavChannels.addEventListener('click', () => {
    document.body.classList.add('sidebar-open')
    patchSettings({ mobile_chat_open: false })
  })
}

// Back button in chat header (mobile) — show sidebar
// Delegated on document so it survives SPA navigation DOM morphs.
document.addEventListener('click', e => {
  if (e.target.closest('.btn-back-mobile')) {
    document.body.classList.add('sidebar-open')
    patchSettings({ mobile_chat_open: false })
  }
})

if (btnNavActivity) {
  btnNavActivity.addEventListener('click', () => {
    openActivitySheet()
  })
}

if (btnNavSearch) {
  btnNavSearch.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('bottomnav:search'))
  })
}

// (Search sheet is now managed by SearchSheetView — see section 7d above)

if (btnNavYou) {
  btnNavYou.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('bottomnav:you'))
  })
}

// ── 8b-i. Activity sheet ──────────────────────────────────────────────────────

const activityBackdrop   = document.getElementById('activity-backdrop')
const activitySheet      = document.getElementById('activity-sheet')
const activityFeed       = document.getElementById('activity-feed')
const activityEmpty      = document.getElementById('activity-empty')
const activityCancel     = document.getElementById('activity-sheet-cancel')
const activityDot        = document.getElementById('activity-dot')
const sidebarActivityDot = document.getElementById('sidebar-activity-dot')

// Sidebar footer Activity button (desktop)
const sidebarBtnActivity = document.getElementById('sidebar-btn-activity')
if (sidebarBtnActivity) {
  sidebarBtnActivity.addEventListener('click', openActivitySheet)
}

// Sidebar footer You button (desktop)
const sidebarBtnYou = document.getElementById('sidebar-btn-you')
if (sidebarBtnYou) {
  sidebarBtnYou.addEventListener('click', openYouSheet)
}

function openActivitySheet() {
  if (!activitySheet || !activityBackdrop) return
  activityBackdrop.hidden = false
  activitySheet.hidden    = false
  requestAnimationFrame(() => {
    activityBackdrop.classList.add('visible')
    activitySheet.classList.add('visible')
  })
  btnNavActivity?.classList.add('active')
  sidebarBtnActivity?.classList.add('active')
  _renderActivityFeed()
  model.markActivityRead()
  if (activityDot) activityDot.hidden = true
  if (sidebarActivityDot) sidebarActivityDot.hidden = true
}

function closeActivitySheet() {
  if (!activitySheet || !activityBackdrop) return
  activityBackdrop.classList.remove('visible')
  activitySheet.classList.remove('visible')
  btnNavActivity?.classList.remove('active')
  sidebarBtnActivity?.classList.remove('active')
  const done = () => { activitySheet.hidden = true; activityBackdrop.hidden = true }
  let timer = setTimeout(done, 300)
  activitySheet.addEventListener('transitionend', () => { clearTimeout(timer); done() }, { once: true })
}

function _renderActivityFeed() {
  if (!activityFeed) return
  const items = model.activityItems
  if (!items.length) {
    activityFeed.innerHTML = ''
    activityFeed.appendChild(activityEmpty)
    activityEmpty.hidden = false
    return
  }
  activityFeed.innerHTML = items.map(item => `
    <div class="activity-item${item.unread ? ' unread' : ''}">
      <div class="activity-avatar">${_escHtml(item.initials ?? '?')}</div>
      <div class="activity-body">
        <div class="activity-text">${item.text ?? ''}</div>
        <div class="activity-sub">${_escHtml(item.sub ?? '')}</div>
      </div>
      <div class="activity-time">${_escHtml(item.time ?? '')}</div>
    </div>`).join('')
}

model.addEventListener('activity-item-added', () => {
  if (activityDot) activityDot.hidden = false
  if (sidebarActivityDot) sidebarActivityDot.hidden = false
})

if (activityCancel) activityCancel.addEventListener('click', closeActivitySheet)
if (activityBackdrop) activityBackdrop.addEventListener('click', closeActivitySheet)
if (activitySheet) attachSheetSwipeDismiss(activitySheet, closeActivitySheet)

// ── 8c. "You" sheet ───────────────────────────────────────────────────────────

const youBackdrop = document.getElementById('you-backdrop')
const youSheet    = document.getElementById('you-sheet')

function openYouSheet() {
  if (!youSheet || !youBackdrop) return
  youBackdrop.hidden = false
  youSheet.hidden    = false
  requestAnimationFrame(() => {
    youBackdrop.classList.add('visible')
    youSheet.classList.add('visible')
  })
  btnNavYou?.classList.add('active')
  _updateNotifUI()
}

function closeYouSheet() {
  if (!youSheet || !youBackdrop) return
  youBackdrop.classList.remove('visible')
  youSheet.classList.remove('visible')
  btnNavYou?.classList.remove('active')
  youSheet.addEventListener('transitionend', () => {
    youSheet.hidden    = true
    youBackdrop.hidden = true
  }, { once: true })
}

document.addEventListener('bottomnav:you', openYouSheet)
if (youBackdrop) youBackdrop.addEventListener('click', closeYouSheet)
document.getElementById('you-sheet-done')?.addEventListener('click', closeYouSheet)
if (youSheet) attachSheetSwipeDismiss(youSheet, closeYouSheet)

// ── 8c. Notification permission ───────────────────────────────────────────────

const youNotifStatus     = document.getElementById('you-notif-status')
const youNotifBtn        = document.getElementById('you-notif-btn')
const youNotifDisableBtn = document.getElementById('you-notif-disable-btn')

const _notifSupported  = () => 'Notification' in window
const _pushSupported   = () => _notifSupported() && 'serviceWorker' in navigator

// Track whether the user is currently subscribed to push (separate from permission state)
let _pushSubscribed = false

async function _getPushReg() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error('sw timeout')), 5000)),
  ])
}

// Check actual subscription state from the service worker
async function _refreshPushSubscribed() {
  if (!_pushSupported() || Notification.permission !== 'granted') { _pushSubscribed = false; return }
  try {
    const reg = await _getPushReg()
    _pushSubscribed = !!(await reg.pushManager.getSubscription())
  } catch { _pushSubscribed = false }
}

function _updateNotifUI() {
  if (!youNotifStatus) return
  if (!_notifSupported()) {
    const isIos = /iP(hone|ad|od)/.test(navigator.userAgent)
    youNotifStatus.textContent = isIos
      ? 'Add to Home Screen to enable push notifications'
      : 'Not supported in this browser'
    if (youNotifBtn)        youNotifBtn.hidden = true
    if (youNotifDisableBtn) youNotifDisableBtn.hidden = true
    return
  }
  const perm = Notification.permission
  if (perm === 'denied') {
    youNotifStatus.textContent = 'Blocked — allow in browser/device Settings'
    if (youNotifBtn)        youNotifBtn.hidden = true
    if (youNotifDisableBtn) youNotifDisableBtn.hidden = true
  } else if (perm === 'granted' && _pushSubscribed) {
    youNotifStatus.textContent = 'Enabled'
    if (youNotifBtn)        youNotifBtn.hidden = true
    if (youNotifDisableBtn) { youNotifDisableBtn.textContent = 'Disable'; youNotifDisableBtn.disabled = false; youNotifDisableBtn.hidden = false }
  } else {
    youNotifStatus.textContent = 'Off'
    if (youNotifBtn)        { youNotifBtn.textContent = 'Enable'; youNotifBtn.disabled = false; youNotifBtn.hidden = false }
    if (youNotifDisableBtn) youNotifDisableBtn.hidden = true
  }
}

if (youNotifBtn) {
  youNotifBtn.addEventListener('click', async () => {
    if (!_notifSupported()) return
    youNotifBtn.textContent = 'Enabling…'

    youNotifBtn.disabled = true

    // If permission not yet granted, request it first (must be first await — browser gesture requirement)
    if (Notification.permission === 'default') {
      let perm
      try { perm = await Notification.requestPermission() }
      catch { youNotifBtn.textContent = 'Enable'; youNotifBtn.disabled = false; return }
      if (perm !== 'granted') { _updateNotifUI(); return }
    }

    // Permission is granted — subscribe to push if supported
    if (_pushSupported()) {
      try {
        const sidebarEl = document.getElementById('sidebar')
        const vapidKey  = sidebarEl?.dataset?.vapidKey ?? ''
        if (vapidKey) {
          const reg     = await _getPushReg()
          const toUint8 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
          const sub     = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toUint8(vapidKey) })
          ws.send({ t: 'push.subscribe', body: { subscription: sub.toJSON() } })
        }
        _pushSubscribed = true
      } catch { /* push subscribe failed */ }
    } else {
      _pushSubscribed = true  // permission granted, no push available — still mark enabled
    }
    _updateNotifUI()
  })
}

if (youNotifDisableBtn) {
  youNotifDisableBtn.addEventListener('click', async () => {
    youNotifDisableBtn.textContent = 'Disabling…'
    youNotifDisableBtn.disabled = true
    try {
      const reg = await _getPushReg()
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await sub.unsubscribe()
        ws.send({ t: 'push.unsubscribe', body: { endpoint: sub.endpoint } })
      }
    } catch { /* ignore */ }
    _pushSubscribed = false
    _updateNotifUI()
  })
}

// Initialise: check real subscription state then render
_refreshPushSubscribed().then(_updateNotifUI)

// ── 8d. Join banner ───────────────────────────────────────────────────────────

const joinBanner    = document.getElementById('join-banner')
const btnJoinChannel = document.getElementById('btn-join-channel')

function _updateJoinBanner() {
  if (!joinBanner) return
  const panel   = document.querySelector('.chat-panel')
  const isMember = panel?.dataset.isMember !== 'false'
  joinBanner.hidden = isMember
}

if (btnJoinChannel) {
  btnJoinChannel.addEventListener('click', () => {
    const channelId = btnJoinChannel.dataset.channelId ?? model.currentChannelId
    if (!channelId) return
    document.dispatchEvent(new CustomEvent('join-channel', { detail: { channelId } }))
    if (joinBanner) joinBanner.hidden = true
  })
}

// When channel is joined server-side, also hide the banner
document.addEventListener('join-channel', () => {
  if (joinBanner) joinBanner.hidden = true
})

// ── 8e. Session End button ────────────────────────────────────────────────────
// (Session banner ended state is now managed by SessionBannerView — see section 7c)

const btnEndSession = document.getElementById('btn-end-session')
if (btnEndSession) {
  btnEndSession.addEventListener('click', () => {
    const channelId = btnEndSession.dataset.channelId ?? model.currentChannelId
    if (!channelId) return
    if (!confirm('End this session? Members will no longer be able to send messages.')) return
    document.dispatchEvent(new CustomEvent('session-end', { detail: { channelId } }))
  })
}

// ── 8f. Call toast (incoming call notification) ───────────────────────────────

const callToast        = document.getElementById('call-toast')
const callToastAvatar  = document.getElementById('call-toast-avatar')
const callToastCaller  = document.getElementById('call-toast-caller')
const callToastSub     = document.getElementById('call-toast-sub')
const callToastDecline = document.getElementById('call-toast-decline')
const callToastJoin    = document.getElementById('call-toast-join')
let _callToastTimer = null

function showCallToast({ callerName, channelName, channelId }) {
  if (!callToast) return
  const initials = callerName.split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
  if (callToastAvatar) callToastAvatar.textContent = initials
  if (callToastCaller) callToastCaller.textContent = callerName
  if (callToastSub)    callToastSub.textContent    = `started a call in #${channelName}`
  callToast.hidden = false
  if (callToastJoin) callToastJoin.dataset.channelId = channelId ?? ''
  requestAnimationFrame(() => callToast.classList.add('visible'))
  clearTimeout(_callToastTimer)
  _callToastTimer = setTimeout(hideCallToast, 8000)
}

function hideCallToast() {
  if (!callToast) return
  callToast.classList.remove('visible')
  callToast.addEventListener('transitionend', () => { callToast.hidden = true }, { once: true })
}

if (callToastDecline) callToastDecline.addEventListener('click', hideCallToast)
if (callToastJoin) {
  callToastJoin.addEventListener('click', () => {
    const channelId = callToastJoin.dataset.channelId
    if (channelId && channelId !== model.currentChannelId) {
      location.href = `${BASE_PATH}/channels/${channelId}`
    }
    hideCallToast()
  })
}

// Listen for incoming rtc.call events → show toast if not already in call
document.addEventListener('rtc:incoming-call', e => {
  const { callerName, channelName, channelId } = e.detail
  showCallToast({ callerName, channelName: channelName ?? channelId, channelId })
})

// ── 8g. Session create sheet ──────────────────────────────────────────────────

const sessionCreateBackdrop = document.getElementById('session-create-backdrop')
const sessionCreateSheet    = document.getElementById('session-create-sheet')
const sessionCreateCancel   = document.getElementById('session-create-cancel')
const sessionCreateSubmit   = document.getElementById('session-create-submit')
const sessionNameInput      = document.getElementById('session-name-input')
const sessionMembersInput   = document.getElementById('session-members-input')
const sessionMembersList    = document.getElementById('session-members-list')
const sessionSelectedList   = document.getElementById('session-selected-members')
const sessionAutoEnd        = document.getElementById('session-auto-end')
let _sessionSelectedIds     = []

function openSessionCreateSheet() {
  if (!sessionCreateSheet || !sessionCreateBackdrop) return
  _sessionSelectedIds = []
  if (sessionNameInput) sessionNameInput.value = ''
  if (sessionMembersInput) sessionMembersInput.value = ''
  if (sessionMembersList) sessionMembersList.innerHTML = ''
  if (sessionSelectedList) sessionSelectedList.innerHTML = ''
  sessionCreateBackdrop.hidden = false
  sessionCreateSheet.hidden    = false
  requestAnimationFrame(() => {
    sessionCreateBackdrop.classList.add('visible')
    sessionCreateSheet.classList.add('visible')
  })
  setTimeout(() => sessionNameInput?.focus(), 320)
}

function closeSessionCreateSheet() {
  if (!sessionCreateSheet || !sessionCreateBackdrop) return
  sessionCreateBackdrop.classList.remove('visible')
  sessionCreateSheet.classList.remove('visible')
  sessionCreateSheet.addEventListener('transitionend', () => {
    sessionCreateSheet.hidden    = true
    sessionCreateBackdrop.hidden = true
  }, { once: true })
}

if (sessionCreateCancel) sessionCreateCancel.addEventListener('click', closeSessionCreateSheet)
if (sessionCreateBackdrop) sessionCreateBackdrop.addEventListener('click', closeSessionCreateSheet)

// Member search in session create sheet
if (sessionMembersInput) {
  sessionMembersInput.addEventListener('input', () => {
    const q = sessionMembersInput.value.toLowerCase().trim()
    if (!sessionMembersList) return
    if (!q) { sessionMembersList.innerHTML = ''; return }
    const candidates = model.members.filter(m =>
      !_sessionSelectedIds.includes(m.user_id) &&
      (m.display_name?.toLowerCase().includes(q) || m.handle?.toLowerCase().includes(q))
    ).slice(0, 8)
    sessionMembersList.innerHTML = candidates.map(m => {
      const initials = (m.display_name ?? m.handle).split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
      return `<li class="session-member-option" data-user-id="${_escHtml(m.user_id)}" data-name="${_escHtml(m.display_name ?? m.handle)}">
        <div class="session-member-avatar">${_escHtml(initials)}</div>
        <span>${_escHtml(m.display_name ?? m.handle)}</span>
      </li>`
    }).join('')
  })
  sessionMembersList?.addEventListener('click', e => {
    const li = e.target.closest('.session-member-option')
    if (!li) return
    const userId = li.dataset.userId
    if (!userId || _sessionSelectedIds.includes(userId)) return
    _sessionSelectedIds.push(userId)
    if (sessionMembersInput) sessionMembersInput.value = ''
    if (sessionMembersList) sessionMembersList.innerHTML = ''
    _renderSelectedMembers()
  })
}

function _renderSelectedMembers() {
  if (!sessionSelectedList) return
  sessionSelectedList.innerHTML = _sessionSelectedIds.map(uid => {
    const m = model.members.find(x => x.user_id === uid)
    const name = m?.display_name ?? m?.handle ?? uid
    return `<li class="session-selected-chip" data-user-id="${_escHtml(uid)}">
      ${_escHtml(name)}
      <button class="session-chip-remove" type="button" data-user-id="${_escHtml(uid)}" aria-label="Remove">✕</button>
    </li>`
  }).join('')

  sessionSelectedList.querySelectorAll('.session-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      _sessionSelectedIds = _sessionSelectedIds.filter(id => id !== btn.dataset.userId)
      _renderSelectedMembers()
    })
  })
}

if (sessionCreateSubmit) {
  sessionCreateSubmit.addEventListener('click', () => {
    const sessionName = sessionNameInput?.value.trim().toLowerCase().replace(/\s+/g, '-')
    if (!sessionName) { sessionNameInput?.focus(); return }
    const autoEndDays = parseInt(sessionAutoEnd?.value ?? '30', 10)
    ws.send({
      t: 'channel.create',
      body: {
        kind: 'session',
        name: sessionName,
        visibility: 'private',
        auto_end_days: autoEndDays > 0 ? autoEndDays : 0,
        member_ids: _sessionSelectedIds,
      },
    })
    closeSessionCreateSheet()
  })
}

// SidebarView dispatches 'open-session-create' when the sessions + button is clicked
document.addEventListener('open-session-create', openSessionCreateSheet)

// ── 8h. Threads sheet ("view all threads") ────────────────────────────────────

const threadsSheetBackdrop = document.getElementById('threads-sheet-backdrop')
const threadsSheet         = document.getElementById('threads-sheet')
const threadsSheetBody     = document.getElementById('threads-sheet-body')
const threadsSheetEmpty    = document.getElementById('threads-sheet-empty')
const threadsSheetDone     = document.getElementById('threads-sheet-done')

function openThreadsSheet(channelId) {
  if (!threadsSheet || !threadsSheetBackdrop) return
  _renderThreadsSheet(channelId)
  threadsSheetBackdrop.hidden = false
  threadsSheet.hidden         = false
  requestAnimationFrame(() => {
    threadsSheetBackdrop.classList.add('visible')
    threadsSheet.classList.add('visible')
  })
}

function closeThreadsSheet() {
  if (!threadsSheet || !threadsSheetBackdrop) return
  threadsSheetBackdrop.classList.remove('visible')
  threadsSheet.classList.remove('visible')
  threadsSheet.addEventListener('transitionend', () => {
    threadsSheet.hidden         = true
    threadsSheetBackdrop.hidden = true
  }, { once: true })
}

function _renderThreadsSheet(channelId) {
  if (!threadsSheetBody) return
  const threads = model.channelThreadsFor(channelId)
  if (!threads.length) {
    threadsSheetBody.innerHTML = ''
    threadsSheetBody.appendChild(threadsSheetEmpty)
    threadsSheetEmpty.hidden = false
    return
  }
  threadsSheetBody.innerHTML = threads.map(t => {
    const excerpt = (t.text ?? '').replace(/\s+/g, ' ').slice(0, 80)
    const meta    = `${t.reply_count ?? 0} repl${(t.reply_count ?? 0) === 1 ? 'y' : 'ies'}`
    const ts      = t.last_reply_ts ? _fmtTime(t.last_reply_ts) : ''
    return `<div class="threads-sheet-item" data-thread-msg-id="${_escHtml(t.msg_id)}" data-thread-channel-id="${_escHtml(channelId)}" role="button" tabindex="0">
      <div class="threads-sheet-item-text">${_escHtml(excerpt)}</div>
      <div class="threads-sheet-item-meta">${_escHtml(meta)}${ts ? ' · ' + _escHtml(ts) : ''}</div>
    </div>`
  }).join('')

  threadsSheetBody.querySelectorAll('.threads-sheet-item').forEach(item => {
    item.addEventListener('click', () => {
      const msgId     = item.dataset.threadMsgId
      const chId      = item.dataset.threadChannelId
      closeThreadsSheet()
      if (msgId && chId) _openThreadFromSidebar(msgId, chId)
    })
  })
}

function _openThreadFromSidebar(msgId, channelId) {
  // Dispatch open-thread — MessageListView handles scroll/highlight, ChatController opens the thread
  document.dispatchEvent(new CustomEvent('open-thread', { detail: { msgId, channelId } }))
}

function _fmtTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000)    return 'just now'
  if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

if (threadsSheetDone)     threadsSheetDone.addEventListener('click', closeThreadsSheet)
if (threadsSheetBackdrop) threadsSheetBackdrop.addEventListener('click', closeThreadsSheet)

document.addEventListener('open-threads-sheet', e => {
  openThreadsSheet(e.detail.channelId)
})

document.addEventListener('open-thread-from-sidebar', e => {
  const { msgId, channelId } = e.detail
  _openThreadFromSidebar(msgId, channelId)
})

// ── 9. Global keyboard shortcuts ──────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    cancelActiveEdit()
    closeEmojiPicker()
    closeYouSheet()
    searchSheetView.close()
    closeActivitySheet()
    closeSessionCreateSheet()
    closeThreadsSheet()
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function _escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
