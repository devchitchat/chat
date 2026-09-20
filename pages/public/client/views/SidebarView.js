/**
 * SidebarView.js — flat channel/DM sidebar (no hubs).
 *
 * Model events handled:
 *   channels-changed  → re-render all four channel sections
 *   channel-selected  → mark active channel, clear mention dots
 *   presence-updated  → update online dot for a specific user
 *
 * WS events handled directly (sidebar-local concerns):
 *   channel.list_result → populate flat channel buckets
 *   dm.list_result      → update DM list
 *   dm.opened         → prepend new DM conversation
 *   notification.*    → mention / urgent dots
 *   channel.reordered → reorder channels in model
 */

import * as Ev from '../model/events.js'
import { escHtml } from '../shared/messages.js'
import { showActionSheet, dismiss as dismissSheet, getItemsContainer } from '../action-sheet.js'
import { showModal, dismiss as dismissModal } from '../modal.js'
import { addLongPress } from '../long-press.js'

const BASE    = () => window.__BASE_PATH__ ?? ''
const isTouch = () => window.matchMedia('(pointer: coarse)').matches

export class SidebarView {
  #model
  #ws
  #root               // <aside>
  #canManage = false  // false for Guests

  /**
   * @param {AppModel}    model
   * @param {WsClient}    ws       — for CRUD operations
   * @param {HTMLElement} rootEl   — <aside>
   */
  constructor(model, ws, rootEl) {
    this.#model  = model
    this.#ws     = ws
    this.#root   = rootEl

    const roles = document.querySelector('.chat-panel')?.dataset.userRoles ?? ''
    this.#canManage = !roles.toLowerCase().includes('guest')

    // Seed model from SSR DOM on first load (DMs are always client-populated)
    const seeded = _channelsFromDom(rootEl)
    if (_hasAny(seeded)) model.setChannels(seeded)

    this.#bindModelEvents()
    this.#bindInteractions()
    this.#bindAdminHandlers()
    this.#bindPushSubscription()

    // ── WS handlers (sidebar-local transport concerns only) ───────────────
    // Note: channel.list_result, dm.list_result, dm.opened (model update),
    // notification.mention, notification.digest, channel.reordered, and
    // msg.event DM unread are all handled by WebSocketController now.

    ws.on('open', () => {
      ws.send({ t: 'channel.list', body: {} })
      ws.send({ t: 'dm.list',      body: {} })
    })

    // dm.opened navigation: WebSocketController updates the model, but the
    // hard-navigation for non-notify_only DMs is a sidebar-local concern.
    ws.on('dm.opened', ({ notify_only, channel_id }) => {
      if (!notify_only && channel_id) {
        window.location.href = `${BASE()}/channels/${channel_id}`
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model event bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    const m = this.#model
    m.addEventListener(Ev.CHANNELS_CHANGED,        e => this.#renderChannels(e.detail.channels))
    m.addEventListener(Ev.CHANNEL_SELECTED,        e => this.#onChannelSelected(e.detail))
    m.addEventListener(Ev.PRESENCE_UPDATED,        e => this.#onPresenceUpdated(e.detail))
    m.addEventListener(Ev.CHANNEL_THREADS_UPDATED, e => this.#onChannelThreadsUpdated(e.detail))
    m.addEventListener(Ev.THREAD_OPENED,  e => this.#onThreadOpened(e.detail))
    m.addEventListener(Ev.THREAD_CLOSED,  () => this.#onThreadClosed())
    m.addEventListener(Ev.MENTIONS_UPDATED, () => this.#updateMentionDots())
    m.addEventListener(Ev.DMS_UPDATED,      () => this.#renderChannels(m.channels))
  }

  #onThreadOpened({ parentMsgId }) {
    this.#root.querySelectorAll('.ch-thread-item').forEach(el => {
      el.classList.toggle('active', el.dataset.threadMsgId === parentMsgId)
    })
  }

  #onThreadClosed() {
    this.#root.querySelectorAll('.ch-thread-item.active').forEach(el => el.classList.remove('active'))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rendering
  // ─────────────────────────────────────────────────────────────────────────

  #renderChannels(channels) {
    const sectionEl = this.#root.querySelector('.channel-group') ?? this.#root.querySelector('section')
    if (!sectionEl) return

    const pub      = channels.public   ?? []
    const prv      = channels.private  ?? []
    const sessions = channels.sessions ?? []
    const dms      = channels.dms      ?? []

    sectionEl.innerHTML = [
      this.#renderSection('PUBLIC',          pub,      'public',   this.#canManage),
      this.#renderSection('PRIVATE',         prv,      'private',  this.#canManage && prv.length > 0),
      this.#renderSection('SESSIONS',        sessions, 'sessions', this.#canManage),
      this.#renderSection('DIRECT MESSAGES', dms,      'dms',      true),
    ].join('')

    this.#attachDragHandlers()
    this.#attachFileDropHandlers()
  }

  #renderSection(label, channels, section, showAdd) {
    if (channels.length === 0 && section === 'private') return ''

    const current = this.#model.currentChannelId

    const items = channels.map(ch => {
      const isActive   = ch.channel_id === current
      const hasMention = this.#model.mentionedChannels.has(ch.channel_id)
      const hasUrgent  = this.#model.urgentChannels.has(ch.channel_id)
      const dotAttr    = hasUrgent ? ' data-urgent=""' : hasMention ? ' data-mention=""' : ''
      const isDM       = section === 'dms'
      const isUnread   = isDM && this.#model.dmUnread.has(ch.channel_id)
      const name       = isDM
        ? (ch.with_user?.display_name ?? ch.name ?? ch.channel_id)
        : ch.name
      const prefix     = section === 'public'   ? '<span class="ch-prefix">#</span> '
                       : section === 'private'  ? '<span class="ch-prefix ch-prefix--private">🔒</span> '
                       : section === 'sessions' ? '<span class="ch-prefix ch-prefix--session">&#x25C8;</span> '
                       : ''

      // Session status badge
      const isEnded = ch.kind === 'session' && ch.session_ends_at != null && ch.session_ends_at <= Date.now()
      const statusBadge = section === 'sessions'
        ? `<span class="ch-status ${isEnded ? 'ch-status--ended' : 'ch-status--active'}">${isEnded ? 'Ended' : 'Active'}</span>`
        : ''

      // Join pill for unjoined public channels
      const isMember = ch.isMember !== false
      const joinPill = (section === 'public' && !isMember && !isActive)
        ? `<span class="ch-join-pill" data-join-channel-id="${escHtml(ch.channel_id)}">Join</span>`
        : ''

      return `
        <li class="channel-item${isActive ? ' active' : ''}${isUnread ? ' dm-unread' : ''}${isEnded ? ' session-ended' : ''}"
            data-channel-id="${escHtml(ch.channel_id)}"
            data-section="${section}"
            draggable="true"
            ${dotAttr}>
          <a class="channel-link"
             href="${escHtml(ch.url ?? `${BASE()}/channels/${ch.channel_id}`)}"
             data-channel-id="${escHtml(ch.channel_id)}"
             data-channel-name="${escHtml(name)}"
             data-channel-topic="${escHtml(ch.topic ?? '')}"
             data-channel-visibility="${escHtml(ch.visibility ?? 'public')}"
             data-is-member="${isMember}">
            ${prefix}${escHtml(name)}
          </a>
          ${statusBadge}${joinPill}
        </li>`
    }).join('')

    const addBtn = showAdd
      ? `<button class="btn-section-add btn-icon" type="button"
                 data-add-section="${section}"
                 title="New ${label === 'Channels' ? 'channel' : label === 'Direct Messages' ? 'message' : label.toLowerCase()}"
                 aria-label="Add">+</button>`
      : ''

    return `
      <div class="channel-section" data-section="${section}">
        <div class="channel-section-header">
          <span class="channel-section-label">${escHtml(label)}</span>
          ${addBtn}
        </div>
        <ul class="channel-list">${items}</ul>
      </div>`
  }

  #onChannelSelected({ channelId }) {
    this.#root.querySelectorAll('.channel-item').forEach(li => {
      const isActive = li.dataset.channelId === channelId
      li.classList.toggle('active', isActive)
      // Collapse thread subtrees for all channels except the newly selected one
      if (!isActive) li.querySelector('.ch-thread-subtree')?.remove()
    })
    if (channelId) {
      this.#model.clearChannelUnread(channelId)
    }
  }

  #onChannelThreadsUpdated({ channelId, threads }) {
    // Re-render the subtree for the channel item that just got thread data
    const li = this.#root.querySelector(`.channel-item[data-channel-id="${channelId}"]`)
    if (!li) return
    // Remove any existing subtree
    li.querySelector('.ch-thread-subtree')?.remove()
    if (!threads.length) return
    const subtreeEl = document.createElement('div')
    subtreeEl.innerHTML = this.#renderThreadSubtree(channelId, threads)
    const child = subtreeEl.firstElementChild
    if (child) li.appendChild(child)
  }

  #renderThreadSubtree(channelId, threads) {
    const MAX = 5
    const visible = threads.slice(0, MAX)
    const items = visible.map(t => {
      const excerpt = (t.text ?? '').replace(/\s+/g, ' ').slice(0, 30)
      const meta = `${t.reply_count}r · ${_relTime(t.last_reply_ts)}`
      return `<div class="ch-thread-item" data-thread-msg-id="${escHtml(t.msg_id)}" data-thread-channel-id="${escHtml(channelId)}" role="button" tabindex="0">
        <span class="ch-thread-connector">↳</span>
        <span class="ch-thread-preview">${escHtml(excerpt)}</span>
        <span class="ch-thread-meta">${escHtml(meta)}</span>
      </div>`
    }).join('')
    const viewAll = threads.length > MAX
      ? `<button class="ch-view-all-threads" data-threads-channel-id="${escHtml(channelId)}" type="button">view all ${threads.length} threads</button>`
      : ''
    return `<div class="ch-thread-subtree">${items}${viewAll}</div>`
  }

  #onPresenceUpdated({ userId, status, bulk }) {
    const entries = bulk ?? [{ user_id: userId, status }]
    for (const { user_id, status: st } of entries) {
      for (const el of this.#root.querySelectorAll(`[data-user-id="${user_id}"] .presence-dot`)) {
        el.dataset.status = st
      }
    }
  }

  #updateMentionDots() {
    const mentioned = this.#model.mentionedChannels
    const urgent    = this.#model.urgentChannels
    this.#root.querySelectorAll('.channel-item').forEach(li => {
      const channelId = li.dataset.channelId
      if (!channelId) return
      if (urgent.has(channelId)) {
        li.dataset.urgent = ''
        delete li.dataset.mention
      } else if (mentioned.has(channelId)) {
        li.dataset.mention = ''
        delete li.dataset.urgent
      } else {
        delete li.dataset.mention
        delete li.dataset.urgent
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Interaction (navigation)
  // ─────────────────────────────────────────────────────────────────────────

  #bindInteractions() {
    this.#root.addEventListener('click', e => {
      // Join pill — join a public channel without navigating
      const joinPill = e.target.closest('[data-join-channel-id]')
      if (joinPill) {
        e.preventDefault()
        e.stopPropagation()
        const channelId = joinPill.dataset.joinChannelId
        if (channelId) {
          document.dispatchEvent(new CustomEvent('join-channel', { detail: { channelId } }))
          joinPill.remove()
        }
        return
      }

      // Thread subtree item — open thread panel for that thread
      const threadItem = e.target.closest('.ch-thread-item')
      if (threadItem) {
        e.preventDefault()
        e.stopPropagation()
        const msgId     = threadItem.dataset.threadMsgId
        const channelId = threadItem.dataset.threadChannelId
        if (msgId && channelId) {
          document.dispatchEvent(new CustomEvent('open-thread-from-sidebar', { detail: { msgId, channelId } }))
        }
        return
      }

      // "View all threads" button — open threads sheet
      const viewAll = e.target.closest('.ch-view-all-threads')
      if (viewAll) {
        e.preventDefault()
        e.stopPropagation()
        const channelId = viewAll.dataset.threadsChannelId
        if (channelId) {
          document.dispatchEvent(new CustomEvent('open-threads-sheet', { detail: { channelId } }))
        }
        return
      }

      const link = e.target.closest('.channel-link')
      if (!link) return

      const channelId = link.dataset.channelId
      if (!channelId) return

      // DM channels: force full page navigation so messages always load correctly.
      // The SPA router's innerHTML swap doesn't reliably trigger msg.list catch-up for DMs.
      if (this.#model.dms?.some(d => d.channel_id === channelId)) {
        e.preventDefault()
        document.body.classList.remove('sidebar-open')
        window.location.href = link.href
        return
      }

      this.#model.clearChannelUnread(channelId)

      if (window.matchMedia('(max-width: 700px)').matches) {
        document.body.classList.remove('sidebar-open')
      }
    })

    document.addEventListener('chatpanel:navigated', e => {
      const { channelId } = e.detail
      this.#onChannelSelected({ channelId })
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Admin CRUD
  // ─────────────────────────────────────────────────────────────────────────

  #bindAdminHandlers() {
    const root  = this.#root
    const ws    = this.#ws
    const model = this.#model

    if (!this.#canManage) {
      // Even guests can open DMs
      root.addEventListener('click', e => {
        if (e.target.closest('[data-add-section="dms"]')) _openNewDmSheet(ws, model)
      })
      return
    }

    // Section + buttons (delegated)
    root.addEventListener('click', e => {
      const btn = e.target.closest('[data-add-section]')
      if (!btn) return
      e.stopPropagation()
      const section = btn.dataset.addSection
      if (section === 'public' || section === 'private') {
        isTouch()
          ? (() => { showActionSheet({ label: 'New channel', items: [] }); _buildCreateChannelForm(getItemsContainer(), { visibility: section, ws, dismiss: dismissSheet }) })()
          : _openCreateChannelModal(section, ws)
      } else if (section === 'sessions') {
        isTouch()
          ? document.dispatchEvent(new CustomEvent('open-session-create'))
          : _openCreateSessionModal(ws, model)
      } else if (section === 'dms') {
        _openNewDmSheet(ws, model)
      }
    })

    // Desktop: right-click context menu on channel items
    if (!isTouch()) {
      root.addEventListener('contextmenu', e => {
        const li = e.target.closest('.channel-item')
        if (!li) return
        e.preventDefault()
        const channelId = li.dataset.channelId
        if (!channelId) return
        const ch = _findChannel(model.channels, channelId)
        _showSidebarPopover(e, [
          { label: 'Edit channel', action: () => _openChannelModal(channelId, ch?.name ?? '', ch?.topic ?? null, ch?.visibility ?? 'public', ch?.kind ?? 'text', ws, model) },
          { label: 'Delete channel', danger: true, action: () => ws.send({ t: 'channel.delete', body: { channel_id: channelId } }) },
        ])
      })
    }

    // Mobile: long-press → action sheet
    if (isTouch()) {
      addLongPress(root, e => {
        const target = e.target ?? e.touches?.[0]?.target
        const link   = target?.closest?.('.channel-link')
        if (!link) return
        const channelId = link.dataset.channelId
        if (!channelId) return
        const ch = _findChannel(model.channels, channelId)
        _openChannelSheet(channelId, ch?.name ?? '', ch?.topic ?? null, ch?.visibility ?? 'public', ch?.kind ?? 'text', ws, model)
      })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Drag-and-drop reordering (within section)
  // ─────────────────────────────────────────────────────────────────────────

  #attachDragHandlers() {
    const root  = this.#root
    const ws    = this.#ws
    const model = this.#model

    let dragSrcChannelId = null
    let dragSrcSection   = null

    const clearIndicators = () => {
      root.querySelectorAll('.drop-before, .drop-after, .dragging').forEach(el => {
        el.classList.remove('drop-before', 'drop-after', 'dragging')
      })
    }

    const before = (e, el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2

    root.addEventListener('dragstart', e => {
      const li = e.target.closest('.channel-item')
      if (!li) return
      dragSrcChannelId = li.dataset.channelId
      dragSrcSection   = li.dataset.section
      if (!dragSrcChannelId) return
      li.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })

    root.addEventListener('dragend', () => {
      clearIndicators()
      dragSrcChannelId = null
      dragSrcSection   = null
    })

    root.addEventListener('dragover', e => {
      if (!dragSrcChannelId) return
      const targetLi = e.target.closest('.channel-item')
      if (!targetLi || targetLi.dataset.channelId === dragSrcChannelId) return
      if (targetLi.dataset.section !== dragSrcSection) return
      e.preventDefault()
      clearIndicators()
      targetLi.classList.add(before(e, targetLi) ? 'drop-before' : 'drop-after')
    })

    root.addEventListener('dragleave', e => {
      e.target.closest('.channel-item')?.classList.remove('drop-before', 'drop-after')
    })

    root.addEventListener('drop', e => {
      clearIndicators()
      if (!dragSrcChannelId) return
      const targetLi        = e.target.closest('.channel-item')
      const targetChannelId = targetLi?.dataset.channelId
      if (!targetChannelId || targetChannelId === dragSrcChannelId) return
      if (targetLi.dataset.section !== dragSrcSection) return
      e.preventDefault()
      const list    = (model.channels[dragSrcSection] ?? [])
      const ids     = list.map(c => c.channel_id)
      const fromIdx = ids.indexOf(dragSrcChannelId)
      const toIdx   = ids.indexOf(targetChannelId)
      if (fromIdx === -1 || toIdx === -1) return
      const isBefore = before(e, targetLi)
      ids.splice(fromIdx, 1)
      ids.splice(isBefore ? ids.indexOf(targetChannelId) : ids.indexOf(targetChannelId) + 1, 0, dragSrcChannelId)
      ws.send({ t: 'channel.reorder', body: { channel_ids: ids, section: dragSrcSection } })
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File-drop on channel links
  // ─────────────────────────────────────────────────────────────────────────

  #attachFileDropHandlers() {
    const root = this.#root
    const ws   = this.#ws
    let hoverTimer  = null
    let hoverTarget = null

    const clearHover = () => {
      clearTimeout(hoverTimer)
      hoverTimer = null
      if (hoverTarget) { hoverTarget.classList.remove('file-drop-hover'); hoverTarget = null }
    }

    const showToast = text => {
      const toast = document.createElement('div')
      toast.className = 'sidebar-toast'
      toast.textContent = text
      root.appendChild(toast)
      setTimeout(() => toast.remove(), 3000)
    }

    root.addEventListener('dragover', e => {
      const link = e.target.closest('.channel-link')
      if (!link) { clearHover(); return }
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (link !== hoverTarget) {
        clearHover()
        hoverTarget = link
        hoverTimer  = setTimeout(() => link.classList.add('file-drop-hover'), 600)
      }
    })

    root.addEventListener('dragleave', e => {
      if (hoverTarget && !hoverTarget.contains(e.relatedTarget)) clearHover()
    })

    root.addEventListener('drop', async e => {
      const link = e.target.closest('.channel-link')
      clearHover()
      if (!link) return
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()

      const targetChannelId   = link.dataset.channelId
      const targetChannelName = link.dataset.channelName ?? targetChannelId
      if (!targetChannelId) return

      const files = [...e.dataTransfer.files]
      if (files.length === 0) return

      ws.send({ t: 'channel.join', body: { channel_id: targetChannelId } })

      const uploaded = []
      for (const file of files) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('channel_id', targetChannelId)
        try {
          const res = await fetch(`${BASE()}/api/uploads`, { method: 'POST', body: formData })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            showToast(`Upload failed: ${body.error ?? res.statusText}`)
            continue
          }
          const a = await res.json()
          uploaded.push({ upload_id: a.upload_id, url: a.url, filename: a.original_name, mime_type: a.mime_type, size_bytes: a.size_bytes })
        } catch { showToast('Upload failed: network error') }
      }

      if (uploaded.length === 0) return

      ws.send({
        t: 'msg.send',
        body: { channel_id: targetChannelId, text: '', client_msg_id: `drop_${Date.now()}`, attachments: uploaded },
      })
      showToast(`Sent to #${targetChannelName}`)
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Web push subscription
  // ─────────────────────────────────────────────────────────────────────────

  #bindPushSubscription() {
    const root     = this.#root
    const ws       = this.#ws
    const vapidKey = root.dataset.vapidKey ?? ''
    if (!vapidKey || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return

    const toUint8 = b64url => {
      const padded = b64url + '==='.slice((b64url.length + 3) % 4)
      return Uint8Array.from(atob(padded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    }

    const subscribe = async swReg => {
      try {
        const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toUint8(vapidKey) })
        ws.send({ t: 'push.subscribe', body: { subscription: sub.toJSON() } })
      } catch { /* user blocked — ignore */ }
    }

    navigator.serviceWorker
      .register(`${BASE()}/sw.js`, { scope: `${BASE()}/` })
      .then(async reg => {
        try { await reg.pushManager.getSubscription() } catch { return }
        if (Notification.permission === 'granted') subscribe(reg)
        // No longer show an enable button — auto-subscribe if permission was already granted
      })
      .catch(() => {})
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM → model seed helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read SSR-rendered channel sections from the DOM.
 * Flat format: <div class="channel-section" data-section="...">
 */
function _channelsFromDom(root) {
  const buckets = { public: [], private: [], sessions: [], dms: [] }
  for (const sec of root.querySelectorAll('.channel-section[data-section]')) {
    const key = sec.dataset.section
    if (!(key in buckets)) continue
    buckets[key] = Array.from(sec.querySelectorAll('li.channel-item')).map(li => {
      const link = li.querySelector('a.channel-link, a[data-channel-id]')
      return {
        channel_id: li.dataset.channelId ?? link?.dataset.channelId,
        name:       (link?.textContent.trim() ?? '').replace(/^[#🔒⏱]\s*/, ''),
        url:        link?.href ?? '',
        topic:      link?.dataset.channelTopic ?? null,
        visibility: link?.dataset.channelVisibility ?? (key === 'private' ? 'private' : 'public'),
        kind:       key === 'sessions' ? 'session' : key === 'dms' ? 'dm' : 'text',
      }
    })
  }
  return buckets
}

function _hasAny(buckets) {
  return Object.values(buckets).some(arr => arr.length > 0)
}

/**
 * Search all channel buckets for a channel by id.
 */
function _findChannel(channels, channelId) {
  for (const list of Object.values(channels)) {
    const ch = list.find(c => c.channel_id === channelId)
    if (ch) return ch
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Member management (shared by channel forms)
// ─────────────────────────────────────────────────────────────────────────────

function _loadMembers(membersEl, { channelId, ws, model }) {
  membersEl.innerHTML = `
    <div class="member-list-wrap"></div>
    <div class="member-add-row">
      <input class="member-add-search" type="text" placeholder="Search by name or handle…" autocomplete="off">
      <button class="btn-primary btn-sm" type="button" data-add-member>Add</button>
    </div>`

  const listWrap    = membersEl.querySelector('.member-list-wrap')
  const addRow      = membersEl.querySelector('.member-add-row')
  const searchInput = addRow.querySelector('.member-add-search')

  let allUsers = null
  const allBots = model?.bots ?? []
  let members  = null
  let filtered       = []
  let selectedUserId = null
  let available      = []

  const updateDropdown = () => {
    addRow.querySelector('.member-search-dropdown')?.remove()
    if (!filtered.length) return
    const dropdown = document.createElement('ul')
    dropdown.className = 'member-search-dropdown'
    for (const u of filtered.slice(0, 8)) {
      const label = u.display_name ?? u.handle ?? u.user_id
      const li = document.createElement('li')
      li.className = 'member-search-option'
      li.dataset.userId = u.user_id
      li.textContent = label
      if (u.user_id === selectedUserId) li.classList.add('selected')
      li.addEventListener('mousedown', ev => {
        ev.preventDefault()
        selectedUserId = u.user_id
        searchInput.value = label
        filtered = []
        updateDropdown()
      })
      dropdown.appendChild(li)
    }
    addRow.appendChild(dropdown)
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase()
    selectedUserId = null
    filtered = q.length >= 1
      ? available.filter(u => {
          const name   = (u.display_name ?? '').toLowerCase()
          const handle = (u.handle ?? '').toLowerCase()
          return name.includes(q) || handle.includes(q)
        })
      : []
    updateDropdown()
  })

  searchInput.addEventListener('blur', () => {
    setTimeout(() => addRow.querySelector('.member-search-dropdown')?.remove(), 150)
  })

  addRow.querySelector('[data-add-member]').addEventListener('click', () => {
    if (!selectedUserId) {
      const q = searchInput.value.trim().toLowerCase()
      const match = available.find(u =>
        (u.display_name ?? '').toLowerCase() === q || (u.handle ?? '').toLowerCase() === q
      )
      if (match) selectedUserId = match.user_id
    }
    if (!selectedUserId) return
    ws.send({ t: 'channel.add_member', body: { channel_id: channelId, user_id: selectedUserId } })
    const user = [...allUsers, ...allBots].find(u => u.user_id === selectedUserId)
    if (user) members = [...members, { user_id: selectedUserId, display_name: user.display_name, handle: user.handle }]
    selectedUserId = null
    searchInput.value = ''
    filtered = []
    updateDropdown()
    render()
  })

  function render() {
    if (!allUsers || !members) return
    const everyone  = [...allUsers, ...allBots]
    const memberIds = new Set(members.map(m => m.user_id))
    available = everyone.filter(u => !memberIds.has(u.user_id))

    const myId = model?.userId
    listWrap.innerHTML = members.length
      ? `<ul class="member-list">${members.map(m => `
          <li class="member-item">
            <span class="member-name">${escHtml(m.display_name ?? m.handle ?? m.user_id)}</span>
            ${m.user_id !== myId ? `<button class="btn-ghost btn-sm" type="button" data-remove-user="${escHtml(m.user_id)}">Remove</button>` : '<span style="font-size:12px;color:var(--text-muted)">(you)</span>'}
          </li>`).join('')}</ul>`
      : `<p style="font-size:13px;color:var(--text-muted);margin:0 0 8px">No members yet.</p>`

    listWrap.querySelectorAll('[data-remove-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        const userId = btn.dataset.removeUser
        ws.send({ t: 'channel.remove_member', body: { channel_id: channelId, user_id: userId } })
        members = members.filter(m => m.user_id !== userId)
        render()
      })
    })

    const q = searchInput.value.trim().toLowerCase()
    if (q.length >= 1) {
      filtered = available.filter(u => {
        const name   = (u.display_name ?? '').toLowerCase()
        const handle = (u.handle ?? '').toLowerCase()
        return name.includes(q) || handle.includes(q)
      })
      updateDropdown()
    }
  }

  ws.once('user.list_result', ({ users }) => { allUsers = users; render() })
  ws.once('channel.list_members_result', body => { members = body.members ?? []; render() })

  ws.send({ t: 'user.list', body: {} })
  ws.send({ t: 'channel.list_members', body: { channel_id: channelId } })
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin form builders
// ─────────────────────────────────────────────────────────────────────────────

function _buildChannelForm(container, { channelId, channelName, channelTopic, channelVisibility, channelKind, ws, model, dismiss }) {
  const currentVisibility = channelVisibility ?? 'public'
  const isSession = channelKind === 'session'
  // Sessions always show the members section; regular channels show it only for private
  const showMembersInitially = isSession || currentVisibility === 'private'

  container.innerHTML = `
    <div class="field">
      <label for="ch-name-input">${isSession ? 'Session name' : 'Channel name'}</label>
      <input id="ch-name-input" type="text" value="${escHtml(channelName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="ch-topic-input">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="ch-topic-input" type="text" value="${escHtml(channelTopic ?? '')}" maxlength="240" autocomplete="off">
    </div>
    ${isSession ? '' : `
    <div class="field">
      <label for="ch-visibility-input">Visibility</label>
      <select id="ch-visibility-input">
        <option value="public"  ${currentVisibility === 'public'  ? 'selected' : ''}>Public</option>
        <option value="private" ${currentVisibility === 'private' ? 'selected' : ''}>Private</option>
      </select>
    </div>`}
    <div class="field" id="ch-members-field"${showMembersInitially ? '' : ' style="display:none"'}>
      <label>Members</label>
      <div id="ch-members-container" style="min-height:32px;font-size:13px;color:var(--text-muted)">Loading…</div>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="ch-cancel-btn" type="button">Cancel</button>
      <button class="btn-primary" id="ch-save-btn" type="button">Save</button>
    </div>
    <div class="modal-danger-zone">
      <p>Deleting this ${isSession ? 'session' : 'channel'} removes all its messages permanently.</p>
      <button class="btn-danger" id="ch-delete-btn" type="button">Delete ${isSession ? 'session' : 'channel'}</button>
    </div>`

  const chVisibilitySelect = container.querySelector('#ch-visibility-input')
  const chMembersField     = container.querySelector('#ch-members-field')
  let chMembersLoaded      = showMembersInitially

  if (chVisibilitySelect) {
    chVisibilitySelect.addEventListener('change', () => {
      const isPrivate = chVisibilitySelect.value === 'private'
      chMembersField.style.display = isPrivate ? '' : 'none'
      if (isPrivate && !chMembersLoaded) {
        chMembersLoaded = true
        _loadMembers(container.querySelector('#ch-members-container'), { channelId, ws, model })
      }
    })
  }

  container.querySelector('#ch-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#ch-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#ch-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'channel.update', body: {
      channel_id: channelId, name,
      topic:      container.querySelector('#ch-topic-input').value.trim() || null,
      visibility: chVisibilitySelect?.value ?? currentVisibility,
    } })
    dismiss()
  })
  container.querySelector('#ch-delete-btn').addEventListener('click', () => {
    ws.send({ t: 'channel.delete', body: { channel_id: channelId } })
    dismiss()
  })
  if (showMembersInitially) {
    _loadMembers(container.querySelector('#ch-members-container'), { channelId, ws, model })
  }
  requestAnimationFrame(() => container.querySelector('#ch-name-input')?.focus())
}

function _buildCreateChannelForm(container, { visibility, ws, dismiss }) {
  const currentVisibility = visibility ?? 'public'
  container.innerHTML = `
    <div class="field">
      <label for="new-ch-name">Channel name</label>
      <input id="new-ch-name" type="text" placeholder="e.g. general" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-ch-topic">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="new-ch-topic" type="text" maxlength="240" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-ch-visibility">Visibility</label>
      <select id="new-ch-visibility">
        <option value="public"  ${currentVisibility === 'public'  ? 'selected' : ''}>Public</option>
        <option value="private" ${currentVisibility === 'private' ? 'selected' : ''}>Private</option>
      </select>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="new-ch-cancel" type="button">Cancel</button>
      <button class="btn-primary" id="new-ch-save" type="button">Create</button>
    </div>`
  container.querySelector('#new-ch-cancel').addEventListener('click', dismiss)
  container.querySelector('#new-ch-save').addEventListener('click', () => {
    const name = container.querySelector('#new-ch-name').value.trim()
    if (!name) return
    ws.send({ t: 'channel.create', body: {
      kind:       'text',
      name,
      topic:      container.querySelector('#new-ch-topic').value.trim() || null,
      visibility: container.querySelector('#new-ch-visibility').value,
    } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#new-ch-name')?.focus())
}

function _buildCreateSessionForm(container, { ws, model, dismiss }) {
  let selectedIds = []

  container.innerHTML = `
    <div class="field">
      <label for="new-ses-name">Session name</label>
      <input id="new-ses-name" type="text" placeholder="e.g. incident-2026-09-14" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-ses-topic">Purpose <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="new-ses-topic" type="text" maxlength="240" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-ses-members">Members <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <div class="session-members-picker">
        <input id="new-ses-members" class="session-create-input" type="text" placeholder="Search people and bots…" autocomplete="off">
        <ul class="session-members-list" id="new-ses-members-list"></ul>
        <ul class="session-selected-members" id="new-ses-selected"></ul>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="new-ses-cancel" type="button">Cancel</button>
      <button class="btn-primary" id="new-ses-save" type="button">Start session</button>
    </div>`

  const membersInput = container.querySelector('#new-ses-members')
  const membersList  = container.querySelector('#new-ses-members-list')
  const selectedList = container.querySelector('#new-ses-selected')

  function renderCandidates() {
    const q        = membersInput.value.toLowerCase().trim()
    const myId     = model?.userId
    const everyone = [...(model?.members ?? []), ...(model?.bots ?? [])].filter(m => m.user_id !== myId)
    const candidates = q
      ? everyone.filter(m =>
          !selectedIds.includes(m.user_id) &&
          (m.display_name?.toLowerCase().includes(q) || m.handle?.toLowerCase().includes(q))
        ).slice(0, 8)
      : everyone.filter(m => !selectedIds.includes(m.user_id)).slice(0, 20)
    membersList.innerHTML = candidates.map(m => {
      const initials = (m.display_name ?? m.handle ?? '?').split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
      return `<li class="session-member-option" data-user-id="${escHtml(m.user_id)}" data-name="${escHtml(m.display_name ?? m.handle ?? '')}">
        <div class="session-member-avatar">${escHtml(initials)}</div>
        <span>${escHtml(m.display_name ?? m.handle ?? '')}</span>
      </li>`
    }).join('')
  }

  function renderSelected() {
    const everyone = [...(model?.members ?? []), ...(model?.bots ?? [])]
    selectedList.innerHTML = selectedIds.map(uid => {
      const m    = everyone.find(x => x.user_id === uid)
      const name = m?.display_name ?? m?.handle ?? uid
      return `<li class="session-selected-chip" data-user-id="${escHtml(uid)}">
        ${escHtml(name)}
        <button class="session-chip-remove" type="button" data-user-id="${escHtml(uid)}" aria-label="Remove">✕</button>
      </li>`
    }).join('')
    selectedList.querySelectorAll('.session-chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedIds = selectedIds.filter(id => id !== btn.dataset.userId)
        renderSelected()
        renderCandidates()
      })
    })
  }

  membersInput.addEventListener('focus', renderCandidates)
  membersInput.addEventListener('input', renderCandidates)
  membersList.addEventListener('click', e => {
    const li = e.target.closest('.session-member-option')
    if (!li) return
    const userId = li.dataset.userId
    if (!userId || selectedIds.includes(userId)) return
    selectedIds.push(userId)
    membersInput.value = ''
    membersList.innerHTML = ''
    renderSelected()
  })

  container.querySelector('#new-ses-cancel').addEventListener('click', dismiss)
  container.querySelector('#new-ses-save').addEventListener('click', () => {
    const name = container.querySelector('#new-ses-name').value.trim()
    if (!name) return
    ws.send({ t: 'channel.create', body: {
      kind:       'session',
      name,
      topic:      container.querySelector('#new-ses-topic').value.trim() || null,
      visibility: 'public',
      member_ids: selectedIds,
    } })
    dismiss()
  })
  requestAnimationFrame(() => { container.querySelector('#new-ses-name')?.focus(); renderCandidates() })
}

function _openNewDmSheet(ws, model) {
  const touch = isTouch()

  if (touch) {
    showActionSheet({ label: 'New Message', items: [] })
    _buildDmPicker(getItemsContainer(), { ws, model, dismiss: dismissSheet })
  } else {
    showModal({ title: 'New Message', build: body => _buildDmPicker(body, { ws, model, dismiss: dismissModal }) })
  }
}

function _buildDmPicker(container, { ws, model, dismiss }) {
  const myId   = model.userId
  const members = [...(model.members ?? []), ...(model.bots ?? [])].filter(m => m.user_id !== myId)

  container.innerHTML = `
    <div class="dm-picker-search-row">
      <input class="dm-picker-search" type="search" placeholder="Search people…"
             autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Search people">
    </div>
    <ul class="dm-picker-list" role="listbox" aria-label="People"></ul>
    <p class="dm-picker-empty" hidden>No people found.</p>`

  const input   = container.querySelector('.dm-picker-search')
  const list    = container.querySelector('.dm-picker-list')
  const emptyEl = container.querySelector('.dm-picker-empty')

  function renderList(q) {
    const ql = q.toLowerCase()
    const filtered = q
      ? members.filter(m =>
          m.display_name?.toLowerCase().includes(ql) ||
          m.handle?.toLowerCase().includes(ql))
      : members

    list.innerHTML = ''
    emptyEl.hidden = filtered.length > 0

    for (const m of filtered) {
      const li = document.createElement('li')
      li.className = 'dm-picker-person'
      li.setAttribute('role', 'option')
      li.innerHTML = `
        <span class="dm-picker-avatar">${escHtml((m.display_name ?? m.handle ?? '?')[0].toUpperCase())}</span>
        <span class="dm-picker-info">
          <span class="dm-picker-name">${escHtml(m.display_name ?? m.handle ?? '')}</span>
          <span class="dm-picker-handle">@${escHtml(m.handle ?? '')}</span>
        </span>`
      li.addEventListener('click', () => {
        ws.send({ t: 'dm.open', body: { target_user_id: m.user_id } })
        dismiss()
      })
      list.appendChild(li)
    }
  }

  renderList('')
  input.addEventListener('input', () => renderList(input.value.trim()))
  requestAnimationFrame(() => input.focus())
}

// ─── Desktop context-menu popover ────────────────────────────────────────────

let _popoverEl      = null
let _popoverCleanup = null

function _dismissSidebarPopover() {
  _popoverEl?.remove()
  _popoverEl = null
  _popoverCleanup?.()
  _popoverCleanup = null
}

function _showSidebarPopover(mouseEvent, items) {
  _dismissSidebarPopover()

  const el = document.createElement('div')
  el.className = 'msg-context-menu'
  el.setAttribute('role', 'menu')
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'msg-context-menu-item' + (item.danger ? ' msg-context-menu-item--danger' : '')
    btn.setAttribute('role', 'menuitem')
    btn.textContent = item.label
    btn.addEventListener('click', () => { _dismissSidebarPopover(); item.action() })
    el.appendChild(btn)
  }
  document.body.appendChild(el)
  _popoverEl = el

  const gap = 4
  el.style.left = `${mouseEvent.clientX + gap}px`
  el.style.top  = `${mouseEvent.clientY + gap}px`

  const rect = el.getBoundingClientRect()
  if (rect.right  > window.innerWidth  - 8) el.style.left = `${mouseEvent.clientX - rect.width  - gap}px`
  if (rect.bottom > window.innerHeight - 8) el.style.top  = `${mouseEvent.clientY - rect.height - gap}px`

  const onKey   = e => { if (e.key === 'Escape') _dismissSidebarPopover() }
  const onClick = e => { if (!el.contains(e.target)) _dismissSidebarPopover() }
  document.addEventListener('keydown', onKey,  { capture: true })
  document.addEventListener('click',   onClick, { capture: true })
  _popoverCleanup = () => {
    document.removeEventListener('keydown', onKey,  { capture: true })
    document.removeEventListener('click',   onClick, { capture: true })
  }
}

// ─── Modal / sheet openers ────────────────────────────────────────────────────

function _openCreateChannelModal(visibility, ws) {
  showModal({ title: 'New channel', build: body => _buildCreateChannelForm(body, { visibility, ws, dismiss: dismissModal }) })
}
function _openCreateSessionModal(ws, model) {
  showModal({ title: 'New session', build: body => _buildCreateSessionForm(body, { ws, model, dismiss: dismissModal }) })
}
function _openChannelModal(channelId, channelName, channelTopic, channelVisibility, channelKind, ws, model) {
  const title = channelKind === 'session' ? 'Session settings' : 'Channel settings'
  showModal({ title, build: body => _buildChannelForm(body, { channelId, channelName, channelTopic, channelVisibility, channelKind, ws, model, dismiss: dismissModal }) })
}
function _openChannelSheet(channelId, channelName, channelTopic, channelVisibility, channelKind, ws, model) {
  showActionSheet({ label: channelName, items: [
    { label: 'Edit channel', action: () => {
      showActionSheet({ label: 'Edit channel', items: [] })
      _buildChannelForm(getItemsContainer(), { channelId, channelName, channelTopic, channelVisibility, channelKind, ws, model, dismiss: dismissSheet })
    }},
    { label: 'Delete channel', danger: true, action: () => {
      showActionSheet({ label: `Delete "#${channelName}"?`, items: [
        { label: 'Cancel', action: () => {} },
        { label: 'Delete channel', danger: true, action: () => { ws.send({ t: 'channel.delete', body: { channel_id: channelId } }); dismissSheet() } },
      ]})
    }},
  ]})
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ─────────────────────────────────────────────────────────────────────────────

function _relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000)    return 'just now'
  if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}
