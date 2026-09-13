/**
 * SidebarView.js — hub/channel/DM sidebar.
 *
 * Replaces islands/sidebar.js. No rdbljs; pure EventTarget + CustomEvent.
 *
 * Model events handled:
 *   hubs-changed     → re-render hub/channel list (preserve <details> open state)
 *   dms-changed      → re-render DM list
 *   channel-selected → mark active channel, clear mention dots
 *   presence-updated → update online dot for a specific user
 *
 * User actions dispatched as document CustomEvents → ChatController:
 *   'select-channel'  { channelId, meta }
 *
 * Admin actions (hub/channel CRUD, drag-reorder, file-drop) call ws.send()
 * directly because they are one-off form interactions that don't need to go
 * through the model — the server response events keep the model in sync.
 */

import * as Ev from '../model/events.js'
import { escHtml } from '../shared/messages.js'
import { showActionSheet, dismiss as dismissSheet, getItemsContainer } from '../action-sheet.js'
import { showModal, dismiss as dismissModal } from '../modal.js'
import { addLongPress } from '../long-press.js'

const BASE = () => window.__BASE_PATH__ ?? ''
const isTouch = () => window.matchMedia('(pointer: coarse)').matches

export class SidebarView {
  #model
  #ws
  #root               // <aside>
  #dmListEl           // #dm-list
  #canManage = false  // false for Guests
  #mentionedChannels  = new Set()  // channelId → mentioned
  #urgentChannels     = new Set()  // channelId → urgent
  #dmUnread           = new Set()  // channelId → unread DM

  /**
   * @param {AppModel}  model
   * @param {WsClient}  ws       — for admin CRUD operations
   * @param {HTMLElement} rootEl — <aside>
   */
  constructor(model, ws, rootEl) {
    this.#model  = model
    this.#ws     = ws
    this.#root   = rootEl
    this.#dmListEl = rootEl.querySelector('#dm-list')

    const roles = document.querySelector('.chat-panel')?.dataset.userRoles ?? ''
    this.#canManage = !roles.toLowerCase().includes('guest')

    // Stamp data-channel-id / data-hub-id onto SSR-rendered <li> elements
    // so drag-and-drop and context-menu handlers can read them before #renderHubs runs.
    for (const li of rootEl.querySelectorAll('li.channel-item')) {
      if (!li.dataset.channelId) {
        const link = li.querySelector('[data-channel-id]')
        if (link?.dataset.channelId) li.dataset.channelId = link.dataset.channelId
      }
      if (!li.dataset.hubId) {
        const details = li.closest('details[data-hub-id]')
        if (details?.dataset.hubId) li.dataset.hubId = details.dataset.hubId
      }
    }

    // Seed model from DOM on first load
    const hubs = _populateHubsFromDom(rootEl)
    const dms  = _populateDmsFromDom(rootEl)
    if (hubs.length > 0) model.setHubs(hubs)
    if (dms.length > 0)  model.setDms(dms)

    this.#bindModelEvents()
    this.#bindInteractions()
    this.#bindAdminHandlers()
    this.#bindPushSubscription()

    // Fetch DM list on open — session cookie already authenticates the socket
    ws.on('open', () => ws.send({ t: 'dm.list', body: {} }))

    ws.on('dm.list_result', ({ dms: list }) => {
      model.setDms(list ?? [])
    })

    ws.on('dm.opened', ({ channel_id, with_user, notify_only }) => {
      const dms = model.dms
      if (!dms.some(d => d.channel_id === channel_id)) {
        model.setDms([{ channel_id, with_user }, ...dms])
      }
      if (notify_only) {
        this.#dmUnread.add(channel_id)
        this.#renderDms()
      } else {
        window.location.href = `${BASE()}/channels/${channel_id}`
      }
    })

    ws.on('msg.event', ({ channel_id }) => {
      if (channel_id === model.currentChannelId) return
      if (!model.dms.some(d => d.channel_id === channel_id)) return
      this.#dmUnread.add(channel_id)
      this.#renderDms()
    })

    ws.on('notification.mention', ({ channel_id, priority }) => {
      if (channel_id === model.currentChannelId) return
      if (priority === 'now') {
        this.#urgentChannels.add(channel_id)
      } else {
        this.#mentionedChannels.add(channel_id)
      }
      this.#updateMentionDots()
    })

    ws.on('notification.digest', ({ channels }) => {
      for (const c of channels ?? []) {
        if (c.urgent) this.#urgentChannels.add(c.channel_id)
        else if (c.mentions > 0) this.#mentionedChannels.add(c.channel_id)
      }
      this.#updateMentionDots()
    })

    ws.on('hub.member_added', ({ hub_id, user_id }) => {
      if (user_id !== model.userId) return
      ws.once('hub.list_result', ({ hubs: serverHubs }) => {
        const existing = new Set(model.hubs.map(h => h.hub_id))
        const newHubs  = (serverHubs ?? []).filter(h => !existing.has(h.hub_id))
        if (newHubs.length > 0) {
          model.setHubs([...model.hubs, ...newHubs.map(h => ({ ...h, channels: [] }))])
        }
      })
      ws.send({ t: 'hub.list', body: {} })
    })

    ws.on('hub.member_removed', ({ hub_id, user_id }) => {
      if (user_id !== model.userId) return
      const removedHub = model.hubs.find(h => h.hub_id === hub_id)
      const affectsCurrent = (removedHub?.channels ?? []).some(c => c.channel_id === model.currentChannelId)
      model.removeHub(hub_id)
      if (affectsCurrent) _navigateAfterDeletion(model.hubs)
    })

    ws.on('hub.reordered', ({ hubs: updated }) => {
      const channelMap = new Map(model.hubs.map(h => [h.hub_id, h.channels]))
      model.setHubs((updated ?? []).map(h => ({ ...h, channels: channelMap.get(h.hub_id) ?? [] })))
    })

    ws.on('channel.reordered', ({ hub_id, channels }) => {
      const hub = model.hubs.find(h => h.hub_id === hub_id)
      if (!hub) return
      const channelMap = new Map((hub.channels ?? []).map(c => [c.channel_id, c]))
      const reordered = (channels ?? []).map(c => ({
        ...channelMap.get(c.channel_id),
        ...c,
        url: `${BASE()}/channels/${c.channel_id}`,
      }))
      model.setHubs(model.hubs.map(h =>
        h.hub_id === hub_id ? { ...h, channels: reordered } : h
      ))
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model event bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    const m = this.#model

    m.addEventListener(Ev.HUBS_CHANGED,    e => this.#renderHubs(e.detail.hubs))
    m.addEventListener(Ev.DMS_CHANGED,     () => this.#renderDms())
    m.addEventListener(Ev.CHANNEL_SELECTED, e => this.#onChannelSelected(e.detail))
    m.addEventListener(Ev.PRESENCE_UPDATED, e => this.#onPresenceUpdated(e.detail))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rendering
  // ─────────────────────────────────────────────────────────────────────────

  #renderHubs(hubs) {
    // Preserve open/closed state of each <details> by hub_id.
    // Initial DOM uses data-key on <details>; re-renders use data-hub-id.
    const openHubIds = new Set(
      [...this.#root.querySelectorAll('details.hub-header[open]')]
        .map(d => d.dataset.hubId ?? d.querySelector('summary[data-hub-id]')?.dataset.hubId ?? d.dataset.key)
        .filter(Boolean)
    )

    // Replace hub list HTML — hub details live inside .hub-group section
    const hubListEl = this.#root.querySelector('.hub-group') ?? this.#root.querySelector('section')
    if (!hubListEl) return

    const currentChannelId = this.#model.currentChannelId
    hubListEl.innerHTML = hubs.map(hub => {
      const open = openHubIds.has(hub.hub_id) || openHubIds.size === 0 ? 'open' : ''
      const channels = (hub.channels ?? []).map(ch => {
        const isActive = ch.channel_id === currentChannelId
        const hasMention = this.#mentionedChannels.has(ch.channel_id)
        const hasUrgent  = this.#urgentChannels.has(ch.channel_id)
        const mentionAttr = hasUrgent ? ' data-urgent=""' : hasMention ? ' data-mention=""' : ''
        return `
          <li class="channel-item${isActive ? ' active' : ''}"
              data-channel-id="${escHtml(ch.channel_id)}"
              data-hub-id="${escHtml(hub.hub_id)}"
              draggable="true"
              ${mentionAttr}>
            <a class="channel-link"
               href="${escHtml(ch.url ?? `${BASE()}/channels/${ch.channel_id}`)}"
               data-channel-id="${escHtml(ch.channel_id)}"
               data-channel-name="${escHtml(ch.name)}"
               data-channel-topic="${escHtml(ch.topic ?? '')}"
               data-channel-visibility="${escHtml(ch.visibility ?? 'public')}"
               data-hub-id="${escHtml(hub.hub_id)}">
              ${escHtml(ch.name)}
            </a>
          </li>`
      }).join('')
      const addBtn = this.#canManage
        ? `<button class="btn-hub-add btn-icon" type="button" title="Add channel" aria-label="Add channel">+</button>`
        : ''
      return `
        <details class="hub-header" data-hub-id="${escHtml(hub.hub_id)}" ${open}>
          <summary class="hub-name" data-hub-id="${escHtml(hub.hub_id)}">
            <span>${escHtml(hub.name)}</span>
            ${addBtn}
          </summary>
          <ul class="channel-list">${channels}</ul>
        </details>`
    }).join('')

    this.#attachDragHandlers()
    this.#attachFileDropHandlers()
  }

  #renderDms() {
    const dmListEl = this.#dmListEl
    if (!dmListEl) return
    const list    = this.#model.dms
    const current = this.#model.currentChannelId

    if (list.length === 0) {
      dmListEl.innerHTML = '<li class="dm-empty">No messages yet.</li>'
      return
    }
    dmListEl.innerHTML = list.map(d => {
      const name     = escHtml(d.with_user?.display_name ?? d.channel_id)
      const selected = d.channel_id === current ? ' dm-selected' : ''
      const unread   = this.#dmUnread.has(d.channel_id) ? ' data-mention=""' : ''
      return `
        <li class="dm-item${selected}" data-channel-id="${escHtml(d.channel_id)}"${unread}>
          <a class="dm-link channel-link"
             href="${BASE()}/channels/${escHtml(d.channel_id)}"
             data-channel-id="${escHtml(d.channel_id)}">
            <span class="dm-name">${name}</span>
          </a>
        </li>`
    }).join('')
  }

  #onChannelSelected({ channelId, prev }) {
    // Update active channel in hub list
    this.#root.querySelectorAll('.channel-item').forEach(li => {
      li.classList.toggle('active', li.dataset.channelId === channelId)
    })
    // Update active DM
    this.#root.querySelectorAll('.dm-item').forEach(li => {
      li.classList.toggle('dm-selected', li.dataset.channelId === channelId)
    })
    // Clear mention/urgent dots for newly selected channel
    if (channelId) {
      this.#mentionedChannels.delete(channelId)
      this.#urgentChannels.delete(channelId)
      this.#dmUnread.delete(channelId)
      this.#updateMentionDots()
    }
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
    this.#root.querySelectorAll('.channel-item').forEach(li => {
      const channelId = li.dataset.channelId
      if (!channelId) return
      if (this.#urgentChannels.has(channelId)) {
        li.dataset.urgent = ''
        delete li.dataset.mention
      } else if (this.#mentionedChannels.has(channelId)) {
        li.dataset.mention = ''
        delete li.dataset.urgent
      } else {
        delete li.dataset.mention
        delete li.dataset.urgent
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Interaction (navigation + DM)
  // ─────────────────────────────────────────────────────────────────────────

  #bindInteractions() {
    this.#root.addEventListener('click', e => {
      // Channel or DM link
      const link = e.target.closest('.channel-link')
      if (!link) return

      const channelId = link.dataset.channelId
      if (!channelId) return

      // Clear dots
      this.#mentionedChannels.delete(channelId)
      this.#urgentChannels.delete(channelId)
      this.#dmUnread.delete(channelId)
      this.#updateMentionDots()

      // Mobile: close sidebar
      if (window.matchMedia('(max-width: 700px)').matches) {
        document.body.classList.remove('sidebar-open')
      }
    })

    // Handle navigation event fired by router.js (SPA navigation)
    document.addEventListener('chatpanel:navigated', e => {
      const { channelId } = e.detail
      this.#onChannelSelected({ channelId })
      if (this.#dmUnread.has(channelId)) {
        this.#dmUnread.delete(channelId)
        this.#renderDms()
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Admin CRUD (delegated, wired once)
  // ─────────────────────────────────────────────────────────────────────────

  #bindAdminHandlers() {
    const root  = this.#root
    const ws    = this.#ws
    const model = this.#model

    // New hub button (always visible — creating a hub is not a management action)
    root.querySelector('#btn-new-hub')?.addEventListener('click', () => {
      isTouch() ? _openCreateHubSheet(ws) : _openCreateHubModal(ws)
    })

    if (!this.#canManage) return

    // Add-channel button (delegated — rendered only for non-guests)
    root.addEventListener('click', e => {
      const btn = e.target.closest('.btn-hub-add')
      if (!btn) return
      e.stopPropagation()
      const hubId = btn.closest('.hub-name')?.dataset.hubId
      if (!hubId) return
      const hub = model.hubs.find(h => h.hub_id === hubId)
      isTouch()
        ? (() => { showActionSheet({ label: `New channel in ${hub?.name ?? ''}`, items: [] }); _buildCreateChannelForm(getItemsContainer(), { hubId, ws, dismiss: dismissSheet }) })()
        : _openCreateChannelModal(hubId, hub?.name ?? '', ws)
    })

    // Desktop: right-click context menus
    if (!isTouch()) {
      root.addEventListener('contextmenu', e => {
        const summary = e.target.closest('.hub-name')
        if (summary) {
          e.preventDefault()
          const hubId = summary.dataset.hubId
          if (!hubId) return
          const hub = model.hubs.find(h => h.hub_id === hubId)
          _showSidebarPopover(e, [
            { label: 'Edit hub', action: () => _openHubModal(hubId, hub?.name ?? '', hub?.description ?? null, hub?.visibility ?? 'public', ws) },
            { label: 'New channel', action: () => _openCreateChannelModal(hubId, hub?.name ?? '', ws) },
            { label: 'Delete hub', danger: true, action: () => { ws.send({ t: 'hub.delete', body: { hub_id: hubId } }) } },
          ])
          return
        }
        const li = e.target.closest('.channel-item')
        if (li) {
          e.preventDefault()
          const channelId = li.dataset.channelId
          if (!channelId) return
          let ch = null
          for (const hub of model.hubs) {
            ch = (hub.channels ?? []).find(c => c.channel_id === channelId)
            if (ch) break
          }
          _showSidebarPopover(e, [
            { label: 'Edit channel', action: () => _openChannelModal(channelId, ch?.name ?? '', ch?.topic ?? null, ch?.visibility ?? 'public', ws) },
            { label: 'Delete channel', danger: true, action: () => { ws.send({ t: 'channel.delete', body: { channel_id: channelId } }) } },
          ])
        }
      })
    }

    // Mobile: long-press → action sheet
    if (isTouch()) {
      addLongPress(root, e => {
        const target  = e.target ?? e.touches?.[0]?.target
        const summary = target?.closest?.('.hub-name')
        if (summary) {
          const hubId = summary.dataset.hubId
          if (!hubId) return
          const hub = model.hubs.find(h => h.hub_id === hubId)
          _openHubSheet(hubId, hub?.name ?? '', hub?.description ?? null, hub?.visibility ?? 'public', ws)
          return
        }
        const link = target?.closest?.('.channel-link')
        if (link) {
          const channelId = link.dataset.channelId
          if (!channelId) return
          let ch = null
          for (const hub of model.hubs) {
            ch = (hub.channels ?? []).find(c => c.channel_id === channelId)
            if (ch) break
          }
          _openChannelSheet(channelId, ch?.name ?? '', ch?.topic ?? null, ch?.visibility ?? 'public', ws)
        }
      })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Drag-and-drop reordering
  // ─────────────────────────────────────────────────────────────────────────

  #attachDragHandlers() {
    const root  = this.#root
    const ws    = this.#ws
    const model = this.#model

    let dragSrcChannelId = null
    let dragSrcHubId     = null
    let dragSrcHubHub    = null  // hub-level drag

    const clearIndicators = () => {
      root.querySelectorAll('.drop-before, .drop-after, .dragging').forEach(el => {
        el.classList.remove('drop-before', 'drop-after', 'dragging')
      })
    }

    const before = (e, el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2

    root.addEventListener('dragstart', e => {
      // Hub drag (from summary)
      const hubSummary = e.target.closest('.hub-header > summary')
      if (hubSummary && !e.target.closest('.channel-item')) {
        const details = hubSummary.closest('.hub-header')
        dragSrcHubHub = details?.dataset.hubId ?? null
        dragSrcChannelId = null
        if (!dragSrcHubHub) return
        details.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
        e.stopPropagation()
        return
      }
      // Channel drag
      const li = e.target.closest('.channel-item')
      if (!li) return
      dragSrcChannelId = li.dataset.channelId
      dragSrcHubId     = li.dataset.hubId
      dragSrcHubHub    = null
      if (!dragSrcChannelId) return
      li.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })

    root.addEventListener('dragend', () => {
      clearIndicators()
      dragSrcChannelId = null
      dragSrcHubId     = null
      dragSrcHubHub    = null
    })

    root.addEventListener('dragover', e => {
      if (dragSrcHubHub) {
        // Hub-level drag
        if (e.target.closest('.channel-item')) return
        const targetDetails = e.target.closest('.hub-header')
        if (!targetDetails) return
        const targetHubId = targetDetails.dataset.hubId
        if (!targetHubId || targetHubId === dragSrcHubHub) return
        e.preventDefault()
        clearIndicators()
        targetDetails.querySelector('summary')?.classList.add(before(e, targetDetails) ? 'drop-before' : 'drop-after')
        return
      }
      if (dragSrcChannelId) {
        const targetLi = e.target.closest('.channel-item')
        if (!targetLi || targetLi.dataset.channelId === dragSrcChannelId) return
        if (targetLi.dataset.hubId !== dragSrcHubId) return
        e.preventDefault()
        clearIndicators()
        targetLi.classList.add(before(e, targetLi) ? 'drop-before' : 'drop-after')
      }
    })

    root.addEventListener('dragleave', e => {
      const li = e.target.closest('.channel-item')
      if (li) li.classList.remove('drop-before', 'drop-after')
      const summary = e.target.closest('.hub-header > summary')
      if (summary) summary.classList.remove('drop-before', 'drop-after')
    })

    root.addEventListener('drop', e => {
      clearIndicators()

      if (dragSrcHubHub) {
        if (e.target.closest('.channel-item')) return
        const targetDetails = e.target.closest('.hub-header')
        const targetHubId   = targetDetails?.dataset.hubId
        if (!targetHubId || targetHubId === dragSrcHubHub) return
        e.preventDefault()
        const ids = model.hubs.map(h => h.hub_id)
        const fromIdx = ids.indexOf(dragSrcHubHub)
        const toIdx   = ids.indexOf(targetHubId)
        if (fromIdx === -1 || toIdx === -1) return
        const isBefore = before(e, targetDetails)
        ids.splice(fromIdx, 1)
        ids.splice(isBefore ? ids.indexOf(targetHubId) : ids.indexOf(targetHubId) + 1, 0, dragSrcHubHub)
        ws.send({ t: 'hub.reorder', body: { hub_ids: ids } })
        return
      }

      if (dragSrcChannelId) {
        const targetLi       = e.target.closest('.channel-item')
        const targetChannelId = targetLi?.dataset.channelId
        if (!targetChannelId || targetChannelId === dragSrcChannelId) return
        if (targetLi.dataset.hubId !== dragSrcHubId) return
        e.preventDefault()
        const hub = model.hubs.find(h => h.hub_id === dragSrcHubId)
        if (!hub) return
        const ids     = (hub.channels ?? []).map(c => c.channel_id)
        const fromIdx = ids.indexOf(dragSrcChannelId)
        const toIdx   = ids.indexOf(targetChannelId)
        if (fromIdx === -1 || toIdx === -1) return
        const isBefore = before(e, targetLi)
        ids.splice(fromIdx, 1)
        ids.splice(isBefore ? ids.indexOf(targetChannelId) : ids.indexOf(targetChannelId) + 1, 0, dragSrcChannelId)
        ws.send({ t: 'channel.reorder', body: { hub_id: dragSrcHubId, channel_ids: ids } })
      }
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
    const root    = this.#root
    const ws      = this.#ws
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

    let swReg = null
    let enableBtn = null

    const showEnableButton = () => {
      if (enableBtn || Notification.permission === 'granted') return
      const footer = root.querySelector('.sidebar-footer') ?? root
      enableBtn = document.createElement('button')
      enableBtn.className = 'btn-enable-notifications'
      enableBtn.textContent = '🔔 Enable notifications'
      footer.appendChild(enableBtn)
      enableBtn.addEventListener('click', async () => {
        const perm = await Notification.requestPermission()
        if (perm === 'granted' && swReg) {
          await subscribe(swReg)
          enableBtn?.remove()
          enableBtn = null
        } else if (perm === 'denied') {
          if (enableBtn) enableBtn.textContent = '🔕 Notifications blocked in browser settings'
        }
      })
    }

    navigator.serviceWorker
      .register(`${BASE()}/sw.js`, { scope: `${BASE()}/` })
      .then(async reg => {
        swReg = reg
        try { await reg.pushManager.getSubscription() } catch { return }
        if (Notification.permission === 'granted') subscribe(reg)
        else showEnableButton()
      })
      .catch(() => {})
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM → model seed helpers
// ─────────────────────────────────────────────────────────────────────────────

function _populateHubsFromDom(root) {
  return Array.from(root.querySelectorAll('details.hub-header')).map(el => {
    // Initial SSR uses data-key; re-renders use data-hub-id; summary has data-hub-id
    const hub_id = el.dataset.hubId
      ?? el.querySelector('summary[data-hub-id]')?.dataset.hubId
      ?? el.dataset.key
    return {
      hub_id,
      name:        el.querySelector('.hub-name span')?.textContent.trim() ?? '',
      visibility:  el.dataset.visibility ?? 'public',
      description: el.dataset.description ?? null,
      channels: Array.from(el.querySelectorAll('li.channel-item, li[data-key]')).map(li => {
        const link = li.querySelector('a.channel-link, a[data-channel-id], a')
        return {
          channel_id: li.dataset.channelId ?? link?.dataset.channelId ?? li.dataset.key,
          hub_id,
          name:       (link?.textContent.trim() ?? '').replace(/^#\s*/, ''),
          url:        link?.href ?? '',
          topic:      link?.dataset.channelTopic ?? null,
          visibility: link?.dataset.channelVisibility ?? 'public',
          selected:   li.dataset.selected === 'true' || li.classList.contains('active'),
        }
      }),
    }
  })
}

function _populateDmsFromDom(root) {
  return Array.from(root.querySelectorAll('.dm-item')).map(li => ({
    channel_id: li.dataset.channelId,
    with_user:  { display_name: li.querySelector('.dm-name')?.textContent.trim() ?? '' },
  }))
}

function _navigateAfterDeletion(remainingHubs) {
  const first = remainingHubs.flatMap(h => h.channels ?? []).find(Boolean)
  window.location.href = first ? `${BASE()}/channels/${first.channel_id}` : `${BASE()}/`
}

// ─────────────────────────────────────────────────────────────────────────────
// Member management (shared by hub and channel forms)
// ─────────────────────────────────────────────────────────────────────────────

function _loadMembers(membersEl, { kind, id, ws }) {
  const listType   = kind === 'hub' ? 'hub.list_members'        : 'channel.list_members'
  const resultType = kind === 'hub' ? 'hub.list_members_result' : 'channel.list_members_result'
  const addType    = kind === 'hub' ? 'hub.add_member'          : 'channel.add_member'
  const removeType = kind === 'hub' ? 'hub.remove_member'       : 'channel.remove_member'
  const idKey      = kind === 'hub' ? 'hub_id'                  : 'channel_id'

  let allUsers = null
  let members  = null

  // Build fixed DOM structure once — member list and search row are separate nodes
  // so search input is never destroyed by list re-renders.
  membersEl.innerHTML = `
    <div class="member-list-wrap"></div>
    <div class="member-add-row">
      <input class="member-add-search" type="text" placeholder="Search by name or handle…" autocomplete="off">
      <button class="btn-primary btn-sm" type="button" data-add-member>Add</button>
    </div>`

  const listWrap    = membersEl.querySelector('.member-list-wrap')
  const addRow      = membersEl.querySelector('.member-add-row')
  const searchInput = addRow.querySelector('.member-add-search')

  let filtered       = []
  let selectedUserId = null
  // available is a live reference updated by render() and read by event handlers
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
    ws.send({ t: addType, body: { [idKey]: id, user_id: selectedUserId } })
    const user = allUsers.find(u => u.user_id === selectedUserId)
    if (user) members = [...members, { user_id: selectedUserId, display_name: user.display_name, handle: user.handle }]
    selectedUserId = null
    searchInput.value = ''
    filtered = []
    updateDropdown()
    render()
  })

  function render() {
    if (!allUsers || !members) return

    const humanIds  = new Set(allUsers.map(u => u.user_id))
    const humans    = members.filter(m => humanIds.has(m.user_id))
    const memberIds = new Set(humans.map(m => m.user_id))
    available = allUsers.filter(u => !memberIds.has(u.user_id))

    // Update only the member list — search row is untouched
    listWrap.innerHTML = humans.length
      ? `<ul class="member-list">${humans.map(m => `
          <li class="member-item">
            <span class="member-name">${escHtml(m.display_name ?? m.handle ?? m.user_id)}</span>
            <button class="btn-ghost btn-sm" type="button" data-remove-user="${escHtml(m.user_id)}">Remove</button>
          </li>`).join('')}</ul>`
      : `<p style="font-size:13px;color:var(--text-muted);margin:0 0 8px">No members yet.</p>`

    listWrap.querySelectorAll('[data-remove-user]').forEach(btn => {
      btn.addEventListener('click', () => {
        const userId = btn.dataset.removeUser
        ws.send({ t: removeType, body: { [idKey]: id, user_id: userId } })
        members = members.filter(m => m.user_id !== userId)
        render()
      })
    })

    // Re-run the search filter against the updated available list so the
    // dropdown stays accurate after a member is added or removed.
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
  ws.once(resultType, body => { members = body.members ?? []; render() })

  ws.send({ t: 'user.list', body: {} })
  ws.send({ t: listType, body: { [idKey]: id } })
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin form builders (module-private, called by button handlers)
// ─────────────────────────────────────────────────────────────────────────────

function _buildHubForm(container, { hubId, hubName, hubDescription, hubVisibility, ws, dismiss }) {
  const currentVisibility = hubVisibility ?? 'public'
  container.innerHTML = `
    <div class="field">
      <label for="hub-name-input">Hub name</label>
      <input id="hub-name-input" type="text" value="${escHtml(hubName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="hub-desc-input">Description <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="hub-desc-input" type="text" value="${escHtml(hubDescription ?? '')}" maxlength="240" autocomplete="off">
    </div>
    <div class="field">
      <label for="hub-visibility-input">Visibility</label>
      <select id="hub-visibility-input">
        <option value="public" ${currentVisibility === 'public' ? 'selected' : ''}>Public</option>
        <option value="private" ${currentVisibility === 'private' ? 'selected' : ''}>Private</option>
      </select>
    </div>
    <div class="field" id="hub-members-field" style="${currentVisibility === 'public' ? 'display:none' : ''}">
      <label>Members</label>
      <div id="hub-members-container" style="min-height:32px;font-size:13px;color:var(--text-muted)">Loading…</div>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="hub-cancel-btn" type="button">Cancel</button>
      <button class="btn-primary" id="hub-save-btn" type="button">Save</button>
    </div>
    <div class="modal-danger-zone">
      <p>Deleting this hub removes it and all its channels permanently.</p>
      <button class="btn-danger" id="hub-delete-btn" type="button">Delete hub</button>
    </div>`

  const visibilitySelect  = container.querySelector('#hub-visibility-input')
  const membersField      = container.querySelector('#hub-members-field')
  let membersLoaded       = currentVisibility === 'private'

  visibilitySelect.addEventListener('change', () => {
    const isPrivate = visibilitySelect.value === 'private'
    membersField.style.display = isPrivate ? '' : 'none'
    if (isPrivate && !membersLoaded) {
      membersLoaded = true
      _loadMembers(container.querySelector('#hub-members-container'), { kind: 'hub', id: hubId, ws })
    }
  })

  container.querySelector('#hub-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#hub-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#hub-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'hub.update', body: {
      hub_id: hubId, name,
      description: container.querySelector('#hub-desc-input').value.trim() || null,
      visibility:  visibilitySelect.value,
    } })
    dismiss()
  })
  container.querySelector('#hub-delete-btn').addEventListener('click', () => {
    ws.send({ t: 'hub.delete', body: { hub_id: hubId } })
    dismiss()
  })
  if (currentVisibility === 'private') {
    _loadMembers(container.querySelector('#hub-members-container'), { kind: 'hub', id: hubId, ws })
  }
  requestAnimationFrame(() => container.querySelector('#hub-name-input')?.focus())
}

function _buildChannelForm(container, { channelId, channelName, channelTopic, channelVisibility, ws, dismiss }) {
  const currentVisibility = channelVisibility ?? 'public'
  container.innerHTML = `
    <div class="field">
      <label for="ch-name-input">Channel name</label>
      <input id="ch-name-input" type="text" value="${escHtml(channelName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="ch-topic-input">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="ch-topic-input" type="text" value="${escHtml(channelTopic ?? '')}" maxlength="240" autocomplete="off">
    </div>
    <div class="field">
      <label for="ch-visibility-input">Visibility</label>
      <select id="ch-visibility-input">
        <option value="public"  ${currentVisibility === 'public'  ? 'selected' : ''}>Public</option>
        <option value="private" ${currentVisibility === 'private' ? 'selected' : ''}>Private</option>
      </select>
    </div>
    <div class="field" id="ch-members-field" style="${currentVisibility === 'public' ? 'display:none' : ''}">
      <label>Members</label>
      <div id="ch-members-container" style="min-height:32px;font-size:13px;color:var(--text-muted)">Loading…</div>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="ch-cancel-btn" type="button">Cancel</button>
      <button class="btn-primary" id="ch-save-btn" type="button">Save</button>
    </div>
    <div class="modal-danger-zone">
      <p>Deleting this channel removes all its messages permanently.</p>
      <button class="btn-danger" id="ch-delete-btn" type="button">Delete channel</button>
    </div>`

  const chVisibilitySelect = container.querySelector('#ch-visibility-input')
  const chMembersField     = container.querySelector('#ch-members-field')
  let chMembersLoaded      = currentVisibility === 'private'

  chVisibilitySelect.addEventListener('change', () => {
    const isPrivate = chVisibilitySelect.value === 'private'
    chMembersField.style.display = isPrivate ? '' : 'none'
    if (isPrivate && !chMembersLoaded) {
      chMembersLoaded = true
      _loadMembers(container.querySelector('#ch-members-container'), { kind: 'channel', id: channelId, ws })
    }
  })

  container.querySelector('#ch-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#ch-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#ch-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'channel.update', body: {
      channel_id: channelId, name,
      topic:      container.querySelector('#ch-topic-input').value.trim() || null,
      visibility: chVisibilitySelect.value,
    } })
    dismiss()
  })
  container.querySelector('#ch-delete-btn').addEventListener('click', () => {
    ws.send({ t: 'channel.delete', body: { channel_id: channelId } })
    dismiss()
  })
  if (currentVisibility === 'private') {
    _loadMembers(container.querySelector('#ch-members-container'), { kind: 'channel', id: channelId, ws })
  }
  requestAnimationFrame(() => container.querySelector('#ch-name-input')?.focus())
}

function _buildCreateHubForm(container, { ws, dismiss }) {
  container.innerHTML = `
    <div class="field">
      <label for="new-hub-name">Hub name</label>
      <input id="new-hub-name" type="text" placeholder="e.g. Engineering" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-hub-desc">Description <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="new-hub-desc" type="text" maxlength="240" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-hub-visibility">Visibility</label>
      <select id="new-hub-visibility">
        <option value="public">Public</option>
        <option value="private">Private</option>
      </select>
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="new-hub-cancel" type="button">Cancel</button>
      <button class="btn-primary" id="new-hub-save" type="button">Create</button>
    </div>`
  container.querySelector('#new-hub-cancel').addEventListener('click', dismiss)
  container.querySelector('#new-hub-save').addEventListener('click', () => {
    const name = container.querySelector('#new-hub-name').value.trim()
    if (!name) return
    ws.send({ t: 'hub.create', body: {
      name,
      description: container.querySelector('#new-hub-desc').value.trim() || null,
      visibility:  container.querySelector('#new-hub-visibility').value,
    } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#new-hub-name')?.focus())
}

function _buildCreateChannelForm(container, { hubId, ws, dismiss }) {
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
        <option value="public">Public</option>
        <option value="private">Private</option>
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
      hub_id: hubId, kind: 'text', name,
      topic:      container.querySelector('#new-ch-topic').value.trim() || null,
      visibility: container.querySelector('#new-ch-visibility').value,
    } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#new-ch-name')?.focus())
}

// ─── Desktop context-menu popover ────────────────────────────────────────────

let _popoverEl       = null
let _popoverCleanup  = null

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

  // Position at cursor, flip if needed
  const gap = 4
  let top  = mouseEvent.clientY + gap
  let left = mouseEvent.clientX + gap
  el.style.left = `${left}px`
  el.style.top  = `${top}px`

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

function _openCreateHubModal(ws) {
  showModal({ title: 'New hub', build: body => _buildCreateHubForm(body, { ws, dismiss: dismissModal }) })
}
function _openCreateHubSheet(ws) {
  showActionSheet({ label: 'New hub', items: [] })
  _buildCreateHubForm(getItemsContainer(), { ws, dismiss: dismissSheet })
}
function _openHubModal(hubId, hubName, hubDescription, hubVisibility, ws) {
  showModal({ title: 'Hub settings', build: body => _buildHubForm(body, { hubId, hubName, hubDescription, hubVisibility, ws, dismiss: dismissModal }) })
}
function _openHubSheet(hubId, hubName, hubDescription, hubVisibility, ws) {
  showActionSheet({ label: hubName, items: [
    { label: 'Edit hub', action: () => {
      showActionSheet({ label: 'Edit hub', items: [] })
      _buildHubForm(getItemsContainer(), { hubId, hubName, hubDescription, hubVisibility, ws, dismiss: dismissSheet })
    }},
    { label: 'Create channel', action: () => {
      showActionSheet({ label: `New channel in ${hubName}`, items: [] })
      _buildCreateChannelForm(getItemsContainer(), { hubId, ws, dismiss: dismissSheet })
    }},
    { label: 'Delete hub', danger: true, action: () => {
      showActionSheet({ label: `Delete "${hubName}"?`, items: [
        { label: 'Cancel', action: () => {} },
        { label: 'Delete hub', danger: true, action: () => { ws.send({ t: 'hub.delete', body: { hub_id: hubId } }); dismissSheet() } },
      ]})
    }},
  ]})
}
function _openCreateChannelModal(hubId, hubName, ws) {
  showModal({ title: `New channel in ${hubName}`, build: body => _buildCreateChannelForm(body, { hubId, ws, dismiss: dismissModal }) })
}
function _openChannelModal(channelId, channelName, channelTopic, channelVisibility, ws) {
  showModal({ title: 'Channel settings', build: body => _buildChannelForm(body, { channelId, channelName, channelTopic, channelVisibility, ws, dismiss: dismissModal }) })
}
function _openChannelSheet(channelId, channelName, channelTopic, channelVisibility, ws) {
  showActionSheet({ label: channelName, items: [
    { label: 'Edit channel', action: () => {
      showActionSheet({ label: 'Edit channel', items: [] })
      _buildChannelForm(getItemsContainer(), { channelId, channelName, channelTopic, channelVisibility, ws, dismiss: dismissSheet })
    }},
    { label: 'Delete channel', danger: true, action: () => {
      showActionSheet({ label: `Delete "#${channelName}"?`, items: [
        { label: 'Cancel', action: () => {} },
        { label: 'Delete channel', danger: true, action: () => { ws.send({ t: 'channel.delete', body: { channel_id: channelId } }); dismissSheet() } },
      ]})
    }},
  ]})
}
