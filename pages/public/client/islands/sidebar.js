/**
 * sidebar.js — rdbljs island for hub/channel navigation and online presence.
 *
 * Mounted on: <aside island="/client/islands/sidebar.js" ...>
 */
import { signal, getItemContext, effect, computed, Context } from '@devchitchat/rdbljs'
import { WsClient } from '../ws.js'
import { addLongPress } from '../long-press.js'
import { showActionSheet, dismiss as dismissSheet, getItemsContainer } from '../action-sheet.js'
import { showModal, dismiss as dismissModal } from '../modal.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c])
}

const isTouch = () => window.matchMedia('(pointer: coarse)').matches

function populateFromDom(root) {
  return Array.from(root.querySelectorAll('details')).map(el => {
    const hub_id = el.dataset.key
    return {
      hub_id,
      name: el.querySelector('.hub-name span').textContent.trim(),
      channels: Array.from(el.querySelectorAll('li')).map(li => {
        const link = li.querySelector('a')
        return {
          channel_id: li.dataset.key,
          hub_id,
          name: link.textContent.trim(),
          url: link.href,
          topic: link.dataset.channelTopic ?? null,
          selected: li.dataset.selected === 'true',
          className: li.className.trim()
        }
      })
    }
  })
}

// ── Form builders ─────────────────────────────────────────────────────────────

function buildHubForm(container, { hubId, hubName, hubDescription, ws, dismiss }) {
  container.innerHTML = `
    <div class="field">
      <label for="hub-name-input">Hub name</label>
      <input id="hub-name-input" type="text" value="${escHtml(hubName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="hub-desc-input">Description <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="hub-desc-input" type="text" value="${escHtml(hubDescription ?? '')}" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="hub-cancel-btn" type="button">Cancel</button>
      <button class="btn-primary" id="hub-save-btn" type="button">Save</button>
    </div>
    <div class="modal-danger-zone">
      <p>Deleting this hub removes it and all its channels permanently.</p>
      <button class="btn-danger" id="hub-delete-btn" type="button">Delete hub</button>
    </div>
  `
  container.querySelector('#hub-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#hub-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#hub-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'hub.update', body: {
      hub_id:      hubId,
      name,
      description: container.querySelector('#hub-desc-input').value.trim() || null
    } })
    dismiss()
  })
  container.querySelector('#hub-delete-btn').addEventListener('click', () => {
    ws.send({ t: 'hub.delete', body: { hub_id: hubId } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#hub-name-input')?.focus())
}

function buildChannelForm(container, { channelId, channelName, channelTopic, ws, dismiss }) {
  container.innerHTML = `
    <div class="field">
      <label for="ch-name-input">Channel name</label>
      <input id="ch-name-input" type="text" value="${escHtml(channelName)}" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="ch-topic-input">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="ch-topic-input" type="text" value="${escHtml(channelTopic ?? '')}" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="ch-cancel-btn" type="button">Cancel</button>
      <button class="btn-primary" id="ch-save-btn" type="button">Save</button>
    </div>
    <div class="modal-danger-zone">
      <p>Deleting this channel removes all its messages permanently.</p>
      <button class="btn-danger" id="ch-delete-btn" type="button">Delete channel</button>
    </div>
  `
  container.querySelector('#ch-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#ch-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#ch-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'channel.update', body: {
      channel_id: channelId,
      name,
      topic: container.querySelector('#ch-topic-input').value.trim() || null
    } })
    dismiss()
  })
  container.querySelector('#ch-delete-btn').addEventListener('click', () => {
    ws.send({ t: 'channel.delete', body: { channel_id: channelId } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#ch-name-input')?.focus())
}

function buildCreateHubForm(container, { ws, dismiss }) {
  container.innerHTML = `
    <div class="field">
      <label for="new-hub-name">Hub name</label>
      <input id="new-hub-name" type="text" placeholder="e.g. Engineering" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-hub-desc">Description <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="new-hub-desc" type="text" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="new-hub-cancel" type="button">Cancel</button>
      <button class="btn-primary" id="new-hub-save" type="button">Create</button>
    </div>
  `
  container.querySelector('#new-hub-cancel').addEventListener('click', dismiss)
  container.querySelector('#new-hub-save').addEventListener('click', () => {
    const name = container.querySelector('#new-hub-name').value.trim()
    if (!name) return
    ws.send({ t: 'hub.create', body: {
      name,
      description: container.querySelector('#new-hub-desc').value.trim() || null,
      visibility: 'public'
    } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#new-hub-name')?.focus())
}

function buildCreateChannelForm(container, { hubId, ws, dismiss }) {
  container.innerHTML = `
    <div class="field">
      <label for="new-ch-name">Channel name</label>
      <input id="new-ch-name" type="text" placeholder="e.g. general" maxlength="80" autocomplete="off">
    </div>
    <div class="field">
      <label for="new-ch-topic">Topic <span style="font-weight:400;color:var(--text-muted)">(optional)</span></label>
      <input id="new-ch-topic" type="text" maxlength="240" autocomplete="off">
    </div>
    <div class="modal-footer">
      <button class="btn-ghost" id="new-ch-cancel" type="button">Cancel</button>
      <button class="btn-primary" id="new-ch-save" type="button">Create</button>
    </div>
  `
  container.querySelector('#new-ch-cancel').addEventListener('click', dismiss)
  container.querySelector('#new-ch-save').addEventListener('click', () => {
    const name = container.querySelector('#new-ch-name').value.trim()
    if (!name) return
    ws.send({ t: 'channel.create', body: {
      hub_id:     hubId,
      kind:       'text',
      name,
      topic:      container.querySelector('#new-ch-topic').value.trim() || null,
      visibility: 'public'
    } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#new-ch-name')?.focus())
}

// ── Sheet/modal openers ───────────────────────────────────────────────────────

function openCreateHubModal(ws) {
  showModal({
    title: 'New hub',
    build: body => buildCreateHubForm(body, { ws, dismiss: dismissModal })
  })
}

function openCreateHubSheet(ws) {
  showActionSheet({ label: 'New hub', items: [] })
  buildCreateHubForm(getItemsContainer(), { ws, dismiss: dismissSheet })
}

function openHubSheet(hubId, hubName, ws) {
  showActionSheet({
    label: hubName,
    items: [
      { label: 'Edit name & description', action: () => {
          showActionSheet({ label: 'Edit hub', items: [] })
          buildHubForm(getItemsContainer(), { hubId, hubName, hubDescription: null, ws, dismiss: dismissSheet })
        }
      },
      { label: 'Create channel', action: () => {
          showActionSheet({ label: `New channel in ${hubName}`, items: [] })
          buildCreateChannelForm(getItemsContainer(), { hubId, ws, dismiss: dismissSheet })
        }
      },
      { label: 'Delete hub', danger: true, action: () => {
          showActionSheet({
            label: `Delete "${hubName}"?`,
            items: [
              { label: 'Cancel', action: () => {} },
              { label: 'Delete hub', danger: true, action: () => {
                  ws.send({ t: 'hub.delete', body: { hub_id: hubId } })
                  dismissSheet()
                }
              }
            ]
          })
        }
      }
    ]
  })
}

function openHubModal(hubId, hubName, ws) {
  showModal({
    title: 'Hub settings',
    build: body => buildHubForm(body, { hubId, hubName, hubDescription: null, ws, dismiss: dismissModal })
  })
}

function openCreateChannelModal(hubId, hubName, ws) {
  showModal({
    title: `New channel in ${hubName}`,
    build: body => buildCreateChannelForm(body, { hubId, ws, dismiss: dismissModal })
  })
}

function openChannelSheet(channelId, channelName, channelTopic, ws) {
  showActionSheet({
    label: channelName,
    items: [
      { label: 'Edit channel', action: () => {
          showActionSheet({ label: 'Edit channel', items: [] })
          buildChannelForm(getItemsContainer(), { channelId, channelName, channelTopic, ws, dismiss: dismissSheet })
        }
      },
      { label: 'Delete channel', danger: true, action: () => {
          showActionSheet({
            label: `Delete "#${channelName}"?`,
            items: [
              { label: 'Cancel', action: () => {} },
              { label: 'Delete channel', danger: true, action: () => {
                  ws.send({ t: 'channel.delete', body: { channel_id: channelId } })
                  dismissSheet()
                }
              }
            ]
          })
        }
      }
    ]
  })
}

function openChannelModal(channelId, channelName, channelTopic, ws) {
  showModal({
    title: 'Channel settings',
    build: body => buildChannelForm(body, { channelId, channelName, channelTopic, ws, dismiss: dismissModal })
  })
}

// ── Drag-and-drop channel reordering (desktop only) ──────────────────────────

function attachDragHandlers(sidebarEl, { ws, hubs }) {
  // data-key is stripped from template nodes by rdbljs (clearNodeForTemplate removes it),
  // so dataset.key is undefined on re-rendered items. Use getItemContext instead —
  // rdbljs stores { item, key } in a WeakMap on every entry node and it survives re-renders.
  let dragSrcId = null
  let dragHubId = null

  sidebarEl.addEventListener('dragstart', e => {
    const li = e.target.closest('.channel-item')
    if (!li) return
    const ctx = getItemContext(li)
    dragSrcId = ctx?.key ?? null
    dragHubId = ctx?.item?.hub_id ?? null
    if (!dragSrcId) return
    li.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
  })

  function clearDropIndicators() {
    sidebarEl.querySelectorAll('.drop-before, .drop-after').forEach(el => {
      el.classList.remove('drop-before', 'drop-after')
    })
  }

  function insertBefore(e, li) {
    return e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2
  }

  sidebarEl.addEventListener('dragend', e => {
    const li = e.target.closest('.channel-item')
    if (li) li.classList.remove('dragging')
    clearDropIndicators()
    dragSrcId = null
    dragHubId = null
  })

  sidebarEl.addEventListener('dragover', e => {
    const li = e.target.closest('.channel-item')
    if (!li || !dragSrcId) return
    const ctx = getItemContext(li)
    if (!ctx || ctx.key === dragSrcId || ctx.item?.hub_id !== dragHubId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    clearDropIndicators()
    li.classList.add(insertBefore(e, li) ? 'drop-before' : 'drop-after')
  })

  sidebarEl.addEventListener('dragleave', e => {
    const li = e.target.closest('.channel-item')
    if (li) { li.classList.remove('drop-before', 'drop-after') }
  })

  sidebarEl.addEventListener('drop', e => {
    const targetLi = e.target.closest('.channel-item')
    if (!targetLi || !dragSrcId || !dragHubId) return
    const targetCtx = getItemContext(targetLi)
    const targetChannelId = targetCtx?.key
    if (!targetChannelId || targetCtx.item?.hub_id !== dragHubId) return
    e.preventDefault()
    clearDropIndicators()

    const hub = hubs().find(h => h.hub_id === dragHubId)
    if (!hub) return

    const ids = (hub.channels ?? []).map(c => c.channel_id)
    const fromIdx = ids.indexOf(dragSrcId)
    const toIdx = ids.indexOf(targetChannelId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return

    const before = insertBefore(e, targetLi)
    ids.splice(fromIdx, 1)
    // After removing the source, find target's new index and insert accordingly
    const newToIdx = ids.indexOf(targetChannelId)
    ids.splice(before ? newToIdx : newToIdx + 1, 0, dragSrcId)

    ws.send({ t: 'channel.reorder', body: { hub_id: dragHubId, channel_ids: ids } })
  })
}

// ── Attach management handlers (event delegation — safe across re-renders) ───

function attachManagementHandlers(sidebarEl, { ws, hubs }) {
  // Gear buttons and add button: single delegated click listener
  sidebarEl.addEventListener('click', e => {
    // Hub gear
    if (e.target.closest('.btn-hub-gear')) {
      e.stopPropagation()
      const summary = e.target.closest('.hub-name')
      const hubId = summary?.dataset.hubId
      if (!hubId) return
      const hub = hubs().find(h => h.hub_id === hubId)
      openHubModal(hubId, hub?.name ?? '', ws)
      return
    }

    // Hub add-channel button
    if (e.target.closest('.btn-hub-add')) {
      e.stopPropagation()
      const summary = e.target.closest('.hub-name')
      const hubId = summary?.dataset.hubId
      if (!hubId) return
      const hub = hubs().find(h => h.hub_id === hubId)
      openCreateChannelModal(hubId, hub?.name ?? '', ws)
      return
    }

    // Channel gear
    if (e.target.closest('.btn-channel-gear')) {
      e.preventDefault()
      const li = e.target.closest('.channel-item')
      const link = li?.querySelector('.channel-link')
      const channelId = link?.dataset.channelId
      if (!channelId) return
      let ch = null
      for (const hub of hubs()) {
        ch = (hub.channels ?? []).find(c => c.channel_id === channelId)
        if (ch) break
      }
      openChannelModal(channelId, ch?.name ?? '', ch?.topic ?? null, ws)
      return
    }
  })

  // Touch: long-press delegation on the sidebar
  if (isTouch()) {
    addLongPress(sidebarEl, (e) => {
      const target = e.target ?? e.touches?.[0]?.target

      // Long-press on hub summary
      const summary = target?.closest?.('.hub-name')
      if (summary) {
        const hubId = summary.dataset.hubId
        if (!hubId) return
        const hub = hubs().find(h => h.hub_id === hubId)
        openHubSheet(hubId, hub?.name ?? '', ws)
        return
      }

      // Long-press on channel link
      const link = target?.closest?.('.channel-link')
      if (link) {
        const channelId = link.dataset.channelId
        if (!channelId) return
        let ch = null
        for (const hub of hubs()) {
          ch = (hub.channels ?? []).find(c => c.channel_id === channelId)
          if (ch) break
        }
        openChannelSheet(channelId, ch?.name ?? '', ch?.topic ?? null, ws)
      }
    })
  }
}

// ── Navigation after deletion ─────────────────────────────────────────────────

function navigateAfterDeletion(remainingHubs) {
  const first = remainingHubs.flatMap(h => h.channels ?? []).find(Boolean)
  window.location.href = first ? `/channels/${first.channel_id}` : '/'
}

// ── Island ────────────────────────────────────────────────────────────────────

export default function SidebarIsland(root) {
  const currentChannelId = root.dataset.currentchannel
  const hubs = signal(populateFromDom(root))
  const ws = new WsClient('/ws')

  ws.on('hub.created', ({ hub }) => {
    hubs.set([...hubs(), { ...hub, channels: [] }])
  })

  ws.on('hub.updated', ({ hub }) => {
    hubs.set(hubs().map(h => h.hub_id === hub.hub_id ? { ...h, ...hub } : h))
  })

  ws.on('hub.deleted', ({ hub_id }) => {
    const deletedHub = hubs().find(h => h.hub_id === hub_id)
    const affectsCurrentChannel = (deletedHub?.channels ?? []).some(c => c.channel_id === currentChannelId)
    hubs.set(hubs().filter(h => h.hub_id !== hub_id))
    if (affectsCurrentChannel) navigateAfterDeletion(hubs())
  })

  ws.on('channel.created', ({ channel }) => {
    hubs.set(hubs().map(h => {
      if (h.hub_id !== channel.hub_id) return h
      const channels = [...(h.channels ?? []), {
        ...channel,
        url: `/channels/${channel.channel_id}`,
        label: `# ${channel.name}`,
        className: 'channel-item'
      }]
      return { ...h, channels }
    }))
  })

  ws.on('channel.updated', ({ channel }) => {
    hubs.set(hubs().map(h => {
      if (h.hub_id !== channel.hub_id) return h
      return {
        ...h,
        channels: (h.channels ?? []).map(c =>
          c.channel_id === channel.channel_id
            ? { ...c, ...channel, label: `# ${channel.name}` }
            : c
        )
      }
    }))
  })

  ws.on('channel.reordered', ({ hub_id, channels }) => {
    hubs.set(hubs().map(h => {
      if (h.hub_id !== hub_id) return h
      const channelMap = new Map((h.channels ?? []).map(c => [c.channel_id, c]))
      const reordered = channels.map(c => ({ ...channelMap.get(c.channel_id), ...c, url: `/channels/${c.channel_id}` }))
      return { ...h, channels: reordered }
    }))
  })

  ws.on('channel.deleted', ({ channel_id }) => {
    const wasCurrentChannel = channel_id === currentChannelId
    hubs.set(hubs().map(h => ({
      ...h,
      channels: (h.channels ?? []).filter(c => c.channel_id !== channel_id)
    })))
    if (wasCurrentChannel) navigateAfterDeletion(hubs())
  })

  // Channel link clicks: dispatch channelnavigated + mobile sidebar hide
  root.addEventListener('click', e => {
    const link = e.target.closest('.channel-link')
    if (!link) return
    document.dispatchEvent(new CustomEvent('channelnavigated', {
      detail: { channelId: link.dataset.channelId }
    }))
    if (window.matchMedia('(max-width: 700px)').matches) {
      document.body.classList.remove('sidebar-open')
    }
  })

  // New hub button
  root.querySelector('#btn-new-hub')?.addEventListener('click', () => {
    isTouch() ? openCreateHubSheet(ws) : openCreateHubModal(ws)
  })

  // Wire management handlers (event delegation — attached once, survives re-renders)
  attachManagementHandlers(root, { ws, hubs })

  // Wire drag-and-drop reordering (desktop only — touch uses action sheet)
  attachDragHandlers(root, { ws, hubs })

  return { hubs }
}
