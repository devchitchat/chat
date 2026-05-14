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
      visibility:   el.dataset.visibility ?? 'public',
      description:  el.dataset.description ?? null,
      channels: Array.from(el.querySelectorAll('li')).map(li => {
        const link = li.querySelector('a')
        return {
          channel_id:  li.dataset.key,
          hub_id,
          name:        link.textContent.trim(),
          url:         link.href,
          topic:       link.dataset.channelTopic ?? null,
          visibility:  link.dataset.channelVisibility ?? 'public',
          selected:    li.dataset.selected === 'true',
          className:   li.className.trim()
        }
      })
    }
  })
}

// ── Form builders ─────────────────────────────────────────────────────────────

function buildHubForm(container, { hubId, hubName, hubDescription, hubVisibility, ws, dismiss }) {
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
        <option value="public" ${currentVisibility === 'public' ? 'selected' : ''}>Public — visible to everyone on this instance</option>
        <option value="restricted" ${currentVisibility === 'restricted' ? 'selected' : ''}>Restricted — only added members can see it</option>
      </select>
    </div>
    <div id="hub-members-section" style="display:${currentVisibility === 'restricted' ? 'block' : 'none'}">
      <div class="field">
        <label>Members</label>
        <div id="hub-members-list" class="members-list"><em style="color:var(--text-muted);font-size:13px">Loading…</em></div>
      </div>
      <div class="field">
        <label for="hub-add-member-select">Add member</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="hub-add-member-select" style="flex:1"><option value="">— select a user —</option></select>
          <button id="hub-add-member-btn" type="button" class="btn-primary" style="white-space:nowrap">Add</button>
        </div>
      </div>
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

  const visibilitySelect = container.querySelector('#hub-visibility-input')
  const membersSection = container.querySelector('#hub-members-section')

  // Show/hide members section when visibility changes
  visibilitySelect.addEventListener('change', () => {
    const isRestricted = visibilitySelect.value === 'restricted'
    membersSection.style.display = isRestricted ? 'block' : 'none'
    if (isRestricted) loadMembers()
  })

  let membersLoaded = false
  function loadMembers() {
    if (membersLoaded) return
    membersLoaded = true

    let members = []
    let allUsers = []

    function render() {
      const memberIds = new Set(members.map(m => m.user_id))

      const listEl = container.querySelector('#hub-members-list')
      if (members.length === 0) {
        listEl.innerHTML = '<em style="color:var(--text-muted);font-size:13px">No members yet.</em>'
      } else {
        listEl.innerHTML = members.map(m => `
          <div class="member-row" data-user-id="${escHtml(m.user_id)}" style="display:flex;align-items:center;justify-content:space-between;padding:4px 0">
            <span>${escHtml(m.display_name ?? m.handle ?? m.user_id)}</span>
            <button type="button" class="btn-ghost btn-sm hub-remove-member" data-user-id="${escHtml(m.user_id)}" style="font-size:12px">Remove</button>
          </div>
        `).join('')
        listEl.querySelectorAll('.hub-remove-member').forEach(btn => {
          btn.addEventListener('click', () => {
            const uid = btn.dataset.userId
            ws.send({ t: 'hub.remove_member', body: { hub_id: hubId, user_id: uid } })
            members = members.filter(m => m.user_id !== uid)
            render()
          })
        })
      }

      const sel = container.querySelector('#hub-add-member-select')
      const available = allUsers.filter(u => !memberIds.has(u.user_id))
      sel.innerHTML = '<option value="">— select a user —</option>' +
        available.map(u => `<option value="${escHtml(u.user_id)}">${escHtml(u.display_name ?? u.handle)}</option>`).join('')
    }

    ws.once('hub.list_members_result', ({ hub_id, members: m }) => {
      if (hub_id !== hubId) return
      members = m
      render()
    })
    ws.once('user.list_result', ({ users }) => {
      allUsers = users
      render()
    })

    ws.send({ t: 'hub.list_members', body: { hub_id: hubId } })
    ws.send({ t: 'user.list', body: {} })
  }

  // Load immediately if already restricted
  if (currentVisibility === 'restricted') loadMembers()

  container.querySelector('#hub-add-member-btn').addEventListener('click', () => {
    const sel = container.querySelector('#hub-add-member-select')
    const userId = sel.value
    if (!userId) return
    ws.send({ t: 'hub.add_member', body: { hub_id: hubId, user_id: userId } })
    membersLoaded = false
    loadMembers()
  })

  container.querySelector('#hub-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#hub-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#hub-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'hub.update', body: {
      hub_id:      hubId,
      name,
      description: container.querySelector('#hub-desc-input').value.trim() || null,
      visibility:  visibilitySelect.value,
    } })
    dismiss()
  })
  container.querySelector('#hub-delete-btn').addEventListener('click', () => {
    ws.send({ t: 'hub.delete', body: { hub_id: hubId } })
    dismiss()
  })
  requestAnimationFrame(() => container.querySelector('#hub-name-input')?.focus())
}

function buildChannelForm(container, { channelId, channelName, channelTopic, channelVisibility, ws, dismiss }) {
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
        <option value="public" ${currentVisibility === 'public' ? 'selected' : ''}>Public — visible to everyone in this hub</option>
        <option value="private" ${currentVisibility === 'private' ? 'selected' : ''}>Private — only added members can see it</option>
      </select>
    </div>
    <div id="ch-members-section" style="display:${currentVisibility === 'private' ? 'block' : 'none'}">
      <div class="field">
        <label>Members</label>
        <div id="ch-members-list" class="members-list"><em style="color:var(--text-muted);font-size:13px">Loading…</em></div>
      </div>
      <div class="field">
        <label for="ch-add-member-select">Add member</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="ch-add-member-select" style="flex:1"><option value="">— select a user —</option></select>
          <button id="ch-add-member-btn" type="button" class="btn-primary" style="white-space:nowrap">Add</button>
        </div>
      </div>
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

  const visibilitySelect = container.querySelector('#ch-visibility-input')
  const membersSection = container.querySelector('#ch-members-section')

  // Show/hide members section when visibility changes
  visibilitySelect.addEventListener('change', () => {
    const isPrivate = visibilitySelect.value === 'private'
    membersSection.style.display = isPrivate ? 'block' : 'none'
    if (isPrivate) loadMembers()
  })

  // Load members and user list for the picker
  let membersLoaded = false
  function loadMembers() {
    if (membersLoaded) return
    membersLoaded = true

    let members = []
    let allUsers = []

    function render() {
      const memberIds = new Set(members.map(m => m.user_id))

      // Render current members list
      const listEl = container.querySelector('#ch-members-list')
      if (members.length === 0) {
        listEl.innerHTML = '<em style="color:var(--text-muted);font-size:13px">No members yet.</em>'
      } else {
        listEl.innerHTML = members.map(m => `
          <div class="member-row" data-user-id="${escHtml(m.user_id)}" style="display:flex;align-items:center;justify-content:space-between;padding:4px 0">
            <span>${escHtml(m.display_name ?? m.handle)} <span style="color:var(--text-muted);font-size:12px">${escHtml(m.role)}</span></span>
            ${m.role !== 'owner' ? `<button type="button" class="btn-ghost btn-sm ch-remove-member" data-user-id="${escHtml(m.user_id)}" style="font-size:12px">Remove</button>` : ''}
          </div>
        `).join('')
        listEl.querySelectorAll('.ch-remove-member').forEach(btn => {
          btn.addEventListener('click', () => {
            const uid = btn.dataset.userId
            ws.send({ t: 'channel.leave', body: { channel_id: channelId, user_id: uid } })
            members = members.filter(m => m.user_id !== uid)
            render()
          })
        })
      }

      // Render add-member picker (exclude existing members)
      const sel = container.querySelector('#ch-add-member-select')
      const available = allUsers.filter(u => !memberIds.has(u.user_id))
      sel.innerHTML = '<option value="">— select a user —</option>' +
        available.map(u => `<option value="${escHtml(u.user_id)}">${escHtml(u.display_name ?? u.handle)}</option>`).join('')
    }

    ws.once('channel.list_members_result', ({ channel_id, members: m }) => {
      if (channel_id !== channelId) return
      members = m
      render()
    })
    ws.once('user.list_result', ({ users }) => {
      allUsers = users
      render()
    })

    ws.send({ t: 'channel.list_members', body: { channel_id: channelId } })
    ws.send({ t: 'user.list', body: {} })
  }

  // Load immediately if already private
  if (currentVisibility === 'private') loadMembers()

  container.querySelector('#ch-add-member-btn').addEventListener('click', () => {
    const sel = container.querySelector('#ch-add-member-select')
    const userId = sel.value
    if (!userId) return
    ws.send({ t: 'channel.add_member', body: { channel_id: channelId, user_id: userId } })
    // Optimistically reload
    membersLoaded = false
    loadMembers()
  })

  container.querySelector('#ch-cancel-btn').addEventListener('click', dismiss)
  container.querySelector('#ch-save-btn').addEventListener('click', () => {
    const name = container.querySelector('#ch-name-input').value.trim()
    if (!name) return
    ws.send({ t: 'channel.update', body: {
      channel_id: channelId,
      name,
      topic:      container.querySelector('#ch-topic-input').value.trim() || null,
      visibility: visibilitySelect.value,
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
    <div class="field">
      <label for="new-hub-visibility">Visibility</label>
      <select id="new-hub-visibility">
        <option value="public">Public — visible to everyone on this instance</option>
        <option value="restricted">Restricted — only added members can see it</option>
      </select>
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
      visibility:  container.querySelector('#new-hub-visibility').value,
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
    <div class="field">
      <label for="new-ch-visibility">Visibility</label>
      <select id="new-ch-visibility">
        <option value="public">Public — visible to everyone in this hub</option>
        <option value="private">Private — only added members can see it</option>
      </select>
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
      visibility: container.querySelector('#new-ch-visibility').value,
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

function openHubSheet(hubId, hubName, hubDescription, hubVisibility, ws) {
  showActionSheet({
    label: hubName,
    items: [
      { label: 'Edit hub', action: () => {
          showActionSheet({ label: 'Edit hub', items: [] })
          buildHubForm(getItemsContainer(), { hubId, hubName, hubDescription, hubVisibility, ws, dismiss: dismissSheet })
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

function openHubModal(hubId, hubName, hubDescription, hubVisibility, ws) {
  showModal({
    title: 'Hub settings',
    build: body => buildHubForm(body, { hubId, hubName, hubDescription, hubVisibility, ws, dismiss: dismissModal })
  })
}

function openCreateChannelModal(hubId, hubName, ws) {
  showModal({
    title: `New channel in ${hubName}`,
    build: body => buildCreateChannelForm(body, { hubId, ws, dismiss: dismissModal })
  })
}

function openChannelSheet(channelId, channelName, channelTopic, channelVisibility, ws) {
  showActionSheet({
    label: channelName,
    items: [
      { label: 'Edit channel', action: () => {
          showActionSheet({ label: 'Edit channel', items: [] })
          buildChannelForm(getItemsContainer(), { channelId, channelName, channelTopic, channelVisibility, ws, dismiss: dismissSheet })
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

function openChannelModal(channelId, channelName, channelTopic, channelVisibility, ws) {
  showModal({
    title: 'Channel settings',
    build: body => buildChannelForm(body, { channelId, channelName, channelTopic, channelVisibility, ws, dismiss: dismissModal })
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

// ── Drag-and-drop hub reordering (desktop only) ───────────────────────────────

function attachHubDragHandlers(sidebarEl, { ws, hubs }) {
  // Uses the same WeakMap-based getItemContext pattern as channel drag handlers.
  // Hub drag targets are details.hub-header elements; draggable="true" is set in the template.
  let dragSrcHubId = null

  function clearDropIndicators() {
    sidebarEl.querySelectorAll('.hub-header.drop-before, .hub-header.drop-after').forEach(el => {
      el.classList.remove('drop-before', 'drop-after')
    })
  }

  function insertBefore(e, details) {
    return e.clientY < details.getBoundingClientRect().top + details.offsetHeight / 2
  }

  sidebarEl.addEventListener('dragstart', e => {
    const details = e.target.closest('.hub-header')
    if (!details) return
    // Ignore if the drag actually started on a channel item inside the hub
    if (e.target.closest('.channel-item')) return
    const ctx = getItemContext(details)
    dragSrcHubId = ctx?.key ?? null
    if (!dragSrcHubId) return
    details.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
  })

  sidebarEl.addEventListener('dragend', e => {
    const details = e.target.closest('.hub-header')
    if (details) details.classList.remove('dragging')
    clearDropIndicators()
    dragSrcHubId = null
  })

  sidebarEl.addEventListener('dragover', e => {
    if (!dragSrcHubId) return
    // Ignore drags over channel items — those belong to the channel drag handler
    if (e.target.closest('.channel-item')) return
    const details = e.target.closest('.hub-header')
    if (!details) return
    const ctx = getItemContext(details)
    if (!ctx || ctx.key === dragSrcHubId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    clearDropIndicators()
    details.classList.add(insertBefore(e, details) ? 'drop-before' : 'drop-after')
  })

  sidebarEl.addEventListener('dragleave', e => {
    if (e.target.closest('.channel-item')) return
    const details = e.target.closest('.hub-header')
    if (details) details.classList.remove('drop-before', 'drop-after')
  })

  sidebarEl.addEventListener('drop', e => {
    if (!dragSrcHubId) return
    if (e.target.closest('.channel-item')) return
    const targetDetails = e.target.closest('.hub-header')
    if (!targetDetails) return
    const targetCtx = getItemContext(targetDetails)
    const targetHubId = targetCtx?.key
    if (!targetHubId || targetHubId === dragSrcHubId) return
    e.preventDefault()
    clearDropIndicators()

    const ids = hubs().map(h => h.hub_id)
    const fromIdx = ids.indexOf(dragSrcHubId)
    const toIdx = ids.indexOf(targetHubId)
    if (fromIdx === -1 || toIdx === -1) return

    const before = insertBefore(e, targetDetails)
    ids.splice(fromIdx, 1)
    const newToIdx = ids.indexOf(targetHubId)
    ids.splice(before ? newToIdx : newToIdx + 1, 0, dragSrcHubId)

    ws.send({ t: 'hub.reorder', body: { hub_ids: ids } })
  })
}

// ── File-drop onto channel links ─────────────────────────────────────────────

function attachFileDropHandlers(sidebarEl, { ws }) {
  let hoverTimer  = null
  let hoverTarget = null

  function clearHover() {
    clearTimeout(hoverTimer)
    hoverTimer = null
    if (hoverTarget) {
      hoverTarget.classList.remove('file-drop-hover')
      hoverTarget = null
    }
  }

  function showToast(text) {
    const toast = document.createElement('div')
    toast.className = 'sidebar-toast'
    toast.textContent = text
    sidebarEl.appendChild(toast)
    setTimeout(() => toast.remove(), 3000)
  }

  sidebarEl.addEventListener('dragover', e => {
    const link = e.target.closest('.channel-link')
    if (!link) { clearHover(); return }
    // Only act on file drags (not channel-reordering drags)
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'

    if (link !== hoverTarget) {
      clearHover()
      hoverTarget = link
      hoverTimer = setTimeout(() => link.classList.add('file-drop-hover'), 600)
    }
  })

  sidebarEl.addEventListener('dragleave', e => {
    if (hoverTarget && !hoverTarget.contains(e.relatedTarget)) clearHover()
  })

  sidebarEl.addEventListener('drop', async e => {
    const link = e.target.closest('.channel-link')
    clearHover()
    if (!link) return
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()

    const targetChannelId = link.dataset.channelId
    const targetChannelName = link.dataset.channelName ?? targetChannelId
    if (!targetChannelId) return

    const files = [...e.dataTransfer.files]
    if (files.length === 0) return

    // Join the channel first (needed for delivery cursor)
    ws.send({ t: 'channel.join', body: { channel_id: targetChannelId } })

    const uploaded = []
    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('channel_id', targetChannelId)
      try {
        const res = await fetch('/api/uploads', { method: 'POST', body: formData })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          showToast(`Upload failed: ${body.error ?? res.statusText}`)
          continue
        }
        const a = await res.json()
        uploaded.push({
          upload_id: a.upload_id,
          url: a.url,
          filename: a.original_name,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
        })
      } catch {
        showToast('Upload failed: network error')
      }
    }

    if (uploaded.length === 0) return

    ws.send({
      t: 'msg.send',
      body: {
        channel_id: targetChannelId,
        text: '',
        client_msg_id: `drop_${Date.now()}`,
        attachments: uploaded,
      }
    })

    showToast(`Sent to #${targetChannelName}`)
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
      openHubModal(hubId, hub?.name ?? '', hub?.description ?? null, hub?.visibility ?? 'public', ws)
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
      openChannelModal(channelId, ch?.name ?? '', ch?.topic ?? null, ch?.visibility ?? 'public', ws)
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
        openHubSheet(hubId, hub?.name ?? '', hub?.description ?? null, hub?.visibility ?? 'public', ws)
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
        openChannelSheet(channelId, ch?.name ?? '', ch?.topic ?? null, ch?.visibility ?? 'public', ws)
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

function populateDmsFromDom(root) {
  return Array.from(root.querySelectorAll('.dm-item')).map(li => ({
    channel_id: li.dataset.channelId,
    with_user: { display_name: li.querySelector('.dm-name')?.textContent.trim() ?? '' }
  }))
}

export default function SidebarIsland(root) {
  let currentChannelId = root.dataset.currentchannel
  const currentUserId = root.dataset.userid ?? null
  const hubs = signal(populateFromDom(root))
  const dms = signal(populateDmsFromDom(root))
  // channelId → true if this channel has an unread @mention
  const mentionedChannels = signal(new Set())
  // channelId → true if this channel has an unread urgent (@mention + now priority)
  const urgentChannels = signal(new Set())
  const ws = new WsClient('/ws')

  ws.on('hub.created', ({ hub }) => {
    hubs.set([...hubs(), { ...hub, channels: [] }])
  })

  ws.on('hub.updated', ({ hub }) => {
    hubs.set(hubs().map(h => h.hub_id === hub.hub_id ? { ...h, ...hub } : h))
  })

  ws.on('notification.mention', ({ channel_id, priority }) => {
    if (channel_id === currentChannelId) return // already viewing — no dot needed
    if (priority === 'now') {
      const next = new Set(urgentChannels())
      next.add(channel_id)
      urgentChannels.set(next)
    } else {
      const next = new Set(mentionedChannels())
      next.add(channel_id)
      mentionedChannels.set(next)
    }
    updateMentionDots()
  })

  ws.on('notification.digest', ({ channels }) => {
    if (!channels?.length) return
    const nextMentioned = new Set(mentionedChannels())
    const nextUrgent = new Set(urgentChannels())
    for (const c of channels) {
      if (c.urgent) nextUrgent.add(c.channel_id)
      else if (c.mentions > 0) nextMentioned.add(c.channel_id)
    }
    mentionedChannels.set(nextMentioned)
    urgentChannels.set(nextUrgent)
    updateMentionDots()
  })

  ws.on('hub.member_added', ({ hub_id, user_id }) => {
    if (user_id !== currentUserId) return
    // Current user was added to a hub — fetch the hub list and merge new hubs in
    ws.once('hub.list_result', ({ hubs: serverHubs }) => {
      const existing = new Set(hubs().map(h => h.hub_id))
      const newHubs = serverHubs.filter(h => !existing.has(h.hub_id))
      if (newHubs.length > 0) {
        hubs.set([...hubs(), ...newHubs.map(h => ({ ...h, channels: [] }))])
      }
    })
    ws.send({ t: 'hub.list', body: {} })
  })

  ws.on('hub.member_removed', ({ hub_id, user_id }) => {
    if (user_id !== currentUserId) return
    // Current user was removed from a hub — drop it from the signal
    const removedHub = hubs().find(h => h.hub_id === hub_id)
    const affectsCurrentChannel = (removedHub?.channels ?? []).some(c => c.channel_id === currentChannelId)
    hubs.set(hubs().filter(h => h.hub_id !== hub_id))
    if (affectsCurrentChannel) navigateAfterDeletion(hubs())
  })

  ws.on('dm.list_result', ({ dms: list }) => {
    dms.set(list)
    renderDms()
  })

  ws.on('dm.opened', ({ channel_id, with_user, notify_only }) => {
    // Add to DM list if not already present
    if (!dms().some(d => d.channel_id === channel_id)) {
      dms.set([{ channel_id, with_user }, ...dms()])
      renderDms()
    }
    if (notify_only) {
      // Target user — show unread dot, don't navigate
      dmUnread.add(channel_id)
      updateDmDots()
    } else {
      // Initiating user — navigate to the DM channel
      window.location.href = `/channels/${channel_id}`
    }
  })

  // Highlight DM list item when a message arrives in a DM channel not currently open
  const dmUnread = new Set()
  ws.on('msg.event', ({ channel_id }) => {
    if (channel_id === currentChannelId) return
    if (!dms().some(d => d.channel_id === channel_id)) return
    dmUnread.add(channel_id)
    updateDmDots()
  })

  function updateDmDots() {
    if (!dmListEl) return
    dmListEl.querySelectorAll('.dm-item').forEach(li => {
      const id = li.dataset.channelId
      if (dmUnread.has(id)) li.dataset.mention = ''
      else delete li.dataset.mention
    })
  }

  // Clear dot when user clicks a DM link
  root.addEventListener('click', e => {
    const link = e.target.closest('.dm-link')
    if (!link) return
    const id = link.dataset.channelId
    if (id) { dmUnread.delete(id); updateDmDots() }
  })

  // Track current channel across SPA navigations and clear DM dot when landing on a DM
  document.addEventListener('chatpanel:navigated', e => {
    const { channelId: newId } = e.detail
    currentChannelId = newId
    // Update active class in the signal so re-renders preserve it
    hubs.set(hubs().map(h => ({
      ...h,
      channels: (h.channels ?? []).map(c => {
        const base = (c.className ?? 'channel-item').replace(/\bactive\b/g, '').trim()
        return { ...c, className: c.channel_id === newId ? `${base} active` : base }
      })
    })))
    if (dmUnread.has(newId)) {
      dmUnread.delete(newId)
      updateDmDots()
    }
  })

  ws.on('hub.reordered', ({ hubs: updated }) => {
    // Merge server-authoritative order into local state, preserving loaded channel arrays
    const channelMap = new Map(hubs().map(h => [h.hub_id, h.channels]))
    hubs.set(updated.map(h => ({ ...h, channels: channelMap.get(h.hub_id) ?? [] })))
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

  // Channel link clicks: dispatch channelnavigated + mobile sidebar hide + clear mention dot
  root.addEventListener('click', e => {
    const link = e.target.closest('.channel-link')
    if (!link) return
    const clickedChannelId = link.dataset.channelId
    document.dispatchEvent(new CustomEvent('channelnavigated', {
      detail: { channelId: clickedChannelId }
    }))
    // Clear mention/urgent dot for this channel
    if (clickedChannelId && (mentionedChannels().has(clickedChannelId) || urgentChannels().has(clickedChannelId))) {
      const nextMentioned = new Set(mentionedChannels())
      const nextUrgent = new Set(urgentChannels())
      nextMentioned.delete(clickedChannelId)
      nextUrgent.delete(clickedChannelId)
      mentionedChannels.set(nextMentioned)
      urgentChannels.set(nextUrgent)
      updateMentionDots()
    }
    if (window.matchMedia('(max-width: 700px)').matches) {
      document.body.classList.remove('sidebar-open')
    }
  })

  // Mention dot management.
  // Uses data-mention / data-urgent attributes instead of CSS classes so that
  // rdbljs className re-renders (el.className = ...) never wipe the dot state.
  function updateMentionDots() {
    const mentioned = mentionedChannels()
    const urgent = urgentChannels()
    root.querySelectorAll('.channel-item').forEach(li => {
      const link = li.querySelector('.channel-link')
      const channelId = link?.dataset.channelId
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

  // DMs list rendering
  const dmListEl = root.querySelector('#dm-list')
  function renderDms() {
    if (!dmListEl) return
    const list = dms()
    if (list.length === 0) {
      dmListEl.innerHTML = '<li class="dm-empty" style="padding:4px 8px;color:var(--text-muted);font-size:13px">No messages yet.</li>'
      return
    }
    dmListEl.innerHTML = list.map(d => {
      const name = escHtml(d.with_user?.display_name ?? d.channel_id)
      const selected = d.channel_id === currentChannelId ? ' dm-selected' : ''
      return `<li class="dm-item${selected}" data-channel-id="${escHtml(d.channel_id)}">
        <a class="dm-link channel-link" href="/channels/${escHtml(d.channel_id)}" data-channel-id="${escHtml(d.channel_id)}">
          <span class="dm-name">${name}</span>
        </a>
      </li>`
    }).join('')
  }

  // Fetch DM list as soon as the socket opens — the connection is already
  // authenticated via the session cookie at upgrade time, so no hello needed.
  ws.on('open', () => ws.send({ t: 'dm.list', body: {} }))

  // New hub button
  root.querySelector('#btn-new-hub')?.addEventListener('click', () => {
    isTouch() ? openCreateHubSheet(ws) : openCreateHubModal(ws)
  })

  // Wire management handlers (event delegation — attached once, survives re-renders)
  attachManagementHandlers(root, { ws, hubs })

  // Wire drag-and-drop reordering (desktop only — touch uses action sheet)
  attachDragHandlers(root, { ws, hubs })
  attachHubDragHandlers(root, { ws, hubs })

  // Wire file-drop onto channel links
  attachFileDropHandlers(root, { ws })

  // ── Web Push subscription ─────────────────────────────────────────────────
  // Browsers require a user gesture to call Notification.requestPermission().
  // Strategy: show a small "Enable notifications" button in the sidebar footer.
  // It appears when VAPID is configured + browser supports push + permission is
  // 'default'. Clicking it (user gesture) requests permission then subscribes.
  const vapidKey = root.dataset.vapidKey ?? ''
  if (vapidKey && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
    function vapidKeyToUint8Array(b64url) {
      const padded = b64url + '==='.slice((b64url.length + 3) % 4)
      const b64 = padded.replace(/-/g, '+').replace(/_/g, '/')
      return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    }

    async function subscribeToPush(swReg) {
      try {
        const sub = await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyToUint8Array(vapidKey),
        })
        ws.send({ t: 'push.subscribe', body: { subscription: sub.toJSON() } })
      } catch { /* subscribe failed or user blocked — ignore */ }
    }

    // Register SW once and hold a reference for later use.
    // After registration, probe pushManager to confirm push actually works in
    // this browser context — Safari Private windows register a SW fine but
    // silently refuse push subscriptions, so we skip the button there.
    let swReg = null
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(async reg => {
        swReg = reg
        // Confirm push is functional by checking the subscription API
        try { await reg.pushManager.getSubscription() } catch {
          return // push not available in this context (e.g. Safari Private)
        }
        if (Notification.permission === 'granted') subscribeToPush(reg)
        if (Notification.permission !== 'granted') showEnableButton()
      })
      .catch(() => { /* http in dev, or SW blocked entirely */ })

    // Inject a small "Enable notifications" button into the sidebar footer.
    // This is the only place we can legally call requestPermission() — inside
    // a synchronous click handler (user gesture).
    //
    // Three states:
    //   'default' → clickable, opens browser permission dialog
    //   'denied'  → non-clickable, tells user to update browser settings
    //   'granted' → button is removed entirely
    let enableBtn = null

    function updateEnableButton() {
      if (!enableBtn) return
      const perm = Notification.permission
      if (perm === 'granted') {
        enableBtn.remove()
        enableBtn = null
        return
      }
      if (perm === 'denied') {
        enableBtn.textContent = '🔕 Notifications blocked in browser settings'
        enableBtn.dataset.blocked = 'true'
      } else {
        enableBtn.textContent = '🔔 Enable notifications'
        delete enableBtn.dataset.blocked
      }
    }

    function showEnableButton() {
      if (enableBtn) return
      enableBtn = document.createElement('button')
      enableBtn.className = 'btn-enable-push'
      enableBtn.type = 'button'
      enableBtn.addEventListener('click', async () => {
        if (enableBtn.dataset.blocked) return   // denied — browser won't show dialog
        const permission = await Notification.requestPermission()
        updateEnableButton()
        if (permission === 'granted' && swReg) subscribeToPush(swReg)
      })
      root.querySelector('.sidebar-footer')?.prepend(enableBtn)
      updateEnableButton()
    }
  }

  return { hubs }
}
