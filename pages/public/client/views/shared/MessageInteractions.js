/**
 * MessageInteractions.js — shared click delegation for message containers.
 *
 * Attach to any container that holds <article class="message"> elements:
 *   attachMessageInteractions(containerEl, { model, isThread })
 *
 * Both MessageListView and ThreadPanelView call this — zero duplication.
 * Actions are dispatched as document CustomEvents so ChatController handles them.
 *
 * Dispatched events:
 *   'react'           { msgId, channelId, emoji }
 *   'unreact'         { msgId, channelId, emoji }
 *   'open-thread'     { msgId }            — only when !isThread
 *   'open-dm'         { targetUserId }
 *   'delete-message'  { msgId, channelId }
 *   'task-toggle'     { msgId, channelId, text }
 */

import {
  openEmojiPicker,
  saveRecentEmoji,
} from './EmojiPickerSingleton.js'
import { escHtml } from '../../shared/messages.js'
import { showActionSheet, dismiss as dismissActionSheet, getItemsContainer } from '../../action-sheet.js'
import { addLongPress } from '../../long-press.js'
import { dispatch } from '../../controllers/ChatController.js'

/**
 * @param {HTMLElement} containerEl
 * @param {{ model: AppModel, isThread?: boolean }} opts
 */
export function attachMessageInteractions(containerEl, { model, isThread = false }) {
  // ── Quick-react buttons (recent emoji, no picker) ──────────────────────────
  containerEl.addEventListener('click', e => {
    const btn = e.target.closest('.btn-quick-react')
    if (!btn) return
    e.stopPropagation()
    const emoji   = btn.dataset.emoji
    const article = btn.closest('article.message')
    const msgId   = article?.dataset.msgId
    const channelId = _channelId(model)
    if (!emoji || !msgId) return
    saveRecentEmoji(emoji)
    dispatch('react', { msgId, channelId, emoji })
  })

  // ── Reaction pills — toggle react/unreact ──────────────────────────────────
  containerEl.addEventListener('click', e => {
    const pill = e.target.closest('.reaction-pill')
    if (!pill) return
    e.stopPropagation()
    const emoji     = pill.dataset.emoji
    const msgId     = pill.dataset.msgId
    const channelId = _channelId(model)
    if (!emoji || !msgId) return
    if (pill.classList.contains('reacted')) {
      dispatch('unreact', { msgId, channelId, emoji })
    } else {
      dispatch('react', { msgId, channelId, emoji })
    }
  })

  // ── Emoji picker trigger (.btn-react / .reaction-add) ─────────────────────
  containerEl.addEventListener('click', e => {
    const addBtn  = e.target.closest('.reaction-add')
    const reactBtn = e.target.closest('.btn-react')
    const btn = addBtn ?? reactBtn
    if (!btn) return
    e.stopPropagation()
    const msgId     = addBtn?.dataset.msgId ?? btn.closest('article.message')?.dataset.msgId
    const channelId = _channelId(model)
    if (!msgId) return
    openEmojiPicker(btn, msgId, emoji => {
      dispatch('react', { msgId, channelId, emoji })
    })
  })

  // ── Reply button → open thread panel ──────────────────────────────────────
  if (!isThread) {
    containerEl.addEventListener('click', e => {
      const btn = e.target.closest('.btn-reply')
      if (!btn) return
      e.stopPropagation()
      const msgId = btn.closest('article.message')?.dataset.msgId
      if (!msgId) return
      dispatch('open-thread', { msgId })
    })

    // "View N replies" link → open thread panel
    containerEl.addEventListener('click', e => {
      const link = e.target.closest('.thread-replies-link')
      if (!link) return
      e.preventDefault()
      e.stopPropagation()
      const msgId = link.dataset.msgId ?? link.closest('article.message')?.dataset.msgId
      if (!msgId) return
      dispatch('open-thread', { msgId })
    })
  }

  // ── DM trigger (sender handle → open DM) ──────────────────────────────────
  containerEl.addEventListener('click', e => {
    const handle = e.target.closest('.dm-trigger')
    if (!handle) return
    const targetUserId = handle.dataset.userId
    if (!targetUserId || targetUserId === model.userId) return
    dispatch('open-dm', { targetUserId })
  })

  // ── Task-list checkboxes ───────────────────────────────────────────────────
  containerEl.addEventListener('click', e => {
    const cb = e.target.closest('.task-list-item-checkbox')
    if (!cb) return
    e.preventDefault()
    const article = cb.closest('article.message')
    if (!article) return
    const rawText = article.dataset.rawText
    if (!rawText) return
    const allCbs = Array.from(article.querySelectorAll('.task-list-item-checkbox'))
    const idx    = allCbs.indexOf(cb)
    if (idx === -1) return
    let count = 0
    const newText = rawText.replace(/\[([ xX])\]/g, (match, state) => {
      if (count++ !== idx) return match
      return state.trim() === '' ? '[x]' : '[ ]'
    })
    if (newText === rawText) return
    cb.checked = !cb.checked
    article.dataset.rawText = newText
    dispatch('task-toggle', {
      msgId:     article.dataset.msgId,
      channelId: _channelId(model),
      text:      newText,
    })
  })

  // ── … (message actions) button → context menu ─────────────────────────────
  containerEl.addEventListener('click', e => {
    const btn = e.target.closest('.btn-msg-actions')
    if (!btn) return
    e.stopPropagation()
    const article = btn.closest('article.message')
    if (article) _showContextMenu(article, btn, model)
  })

  // ── Mobile long-press → action sheet ─────────────────────────────────────
  addLongPress(containerEl, e => {
    const article   = e.target.closest?.('article.message')
    const msgId     = article?.dataset.msgId
    const channelId = _channelId(model)
    if (!msgId) return

    // Open sheet first (which clears the container), then populate it.
    showActionSheet({ label: 'React to this message', items: [] })

    const wrapper = document.createElement('div')
    wrapper.className = 'action-sheet-emoji-picker-wrap'
    getItemsContainer().appendChild(wrapper)

    openEmojiPicker(wrapper, msgId, emoji => {
      saveRecentEmoji(emoji)
      dismissActionSheet()
      dispatch('react', { msgId, channelId, emoji })
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline edit (called from context menu or keyboard shortcut)
// ─────────────────────────────────────────────────────────────────────────────

let activeEditCancel = null

export function startInlineEdit(article, model) {
  if (article.querySelector('.message-edit-wrap')) return
  const textEl = article.querySelector('.message-text')
  if (!textEl) return
  const rawText = article.dataset.rawText ?? ''

  const wrap = document.createElement('div')
  wrap.className = 'message-edit-wrap'

  const tabStrip = document.createElement('div')
  tabStrip.className = 'message-edit-tabs'
  tabStrip.setAttribute('role', 'tablist')
  tabStrip.innerHTML = `
    <button class="message-edit-tab message-edit-tab--active" data-tab="write"
            role="tab" aria-selected="true" type="button">Write</button>
    <button class="message-edit-tab" data-tab="preview"
            role="tab" aria-selected="false" type="button">Preview</button>`

  const textarea = document.createElement('textarea')
  textarea.className = 'message-edit-input'
  textarea.value = rawText

  const preview = document.createElement('div')
  preview.className = 'message-edit-preview message-text'
  preview.hidden = true
  preview.setAttribute('aria-live', 'polite')

  const toolbar = document.createElement('div')
  toolbar.className = 'message-edit-toolbar'
  toolbar.innerHTML = `
    <span class="message-edit-hint">Ctrl+Enter to save · Esc to cancel</span>
    <button class="btn-ghost btn-edit-cancel" type="button">Cancel</button>
    <button class="btn-primary btn-edit-save"  type="button">Save</button>`

  wrap.append(tabStrip, textarea, preview, toolbar)
  textEl.replaceWith(wrap)
  textarea.focus()
  textarea.setSelectionRange(rawText.length, rawText.length)

  const cancel = () => {
    wrap.replaceWith(textEl)
    activeEditCancel = null
  }

  const save = () => {
    const text = textarea.value.trim()
    if (!text) return
    dispatch('edit-message', {
      msgId:     article.dataset.msgId,
      channelId: _channelId(model),
      text,
    })
    cancel()
  }

  activeEditCancel = cancel

  // Tab switching
  tabStrip.addEventListener('click', async e => {
    const btn = e.target.closest('.message-edit-tab')
    if (!btn) return
    const tab = btn.dataset.tab
    tabStrip.querySelectorAll('.message-edit-tab').forEach(b => {
      b.classList.toggle('message-edit-tab--active', b === btn)
      b.setAttribute('aria-selected', String(b === btn))
    })
    textarea.hidden = tab !== 'write'
    preview.hidden  = tab !== 'preview'
    if (tab === 'preview') {
      const text = textarea.value.trim()
      if (!text) { preview.innerHTML = '<p style="color:var(--text-muted)">Nothing to preview yet.</p>'; return }
      let html = null
      await new Promise(resolve => {
        dispatch('preview-text', { text, resolve: h => { html = h; resolve() } })
      })
      preview.innerHTML = html ? _sanitize(html) : escHtml(text)
    }
  })

  toolbar.querySelector('.btn-edit-cancel').addEventListener('click', cancel)
  toolbar.querySelector('.btn-edit-save').addEventListener('click', save)

  textarea.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save() }
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
}

export function cancelActiveEdit() {
  activeEditCancel?.()
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _channelId(model) {
  return model.currentChannelId
}

function _sanitize(html) {
  return String(html ?? '').replaceAll('<script>', '').replaceAll('</script>', '')
}

function _showContextMenu(article, anchorEl, model) {
  const msgId     = article.dataset.msgId
  const channelId = _channelId(model)
  const items = [
    { label: 'Edit',   action: () => startInlineEdit(article, model) },
    { label: 'Delete', danger: true, action: () => dispatch('delete-message', { msgId, channelId }) },
  ]

  // Touch devices → bottom sheet; pointer devices → floating popover
  if (window.matchMedia('(pointer: coarse)').matches) {
    showActionSheet({ label: 'Message actions', items })
  } else {
    _showPopover(anchorEl, items)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating popover for desktop (replaces action sheet on pointer devices)
// ─────────────────────────────────────────────────────────────────────────────

let _popoverEl = null
let _popoverCleanup = null

function _showPopover(anchorEl, items) {
  _dismissPopover()

  const el = document.createElement('div')
  el.className = 'msg-context-menu'
  el.setAttribute('role', 'menu')
  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'msg-context-menu-item' + (item.danger ? ' msg-context-menu-item--danger' : '')
    btn.setAttribute('role', 'menuitem')
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      _dismissPopover()
      item.action()
    })
    el.appendChild(btn)
  }
  document.body.appendChild(el)
  _popoverEl = el

  // Position: fixed, so coordinates are viewport-relative (no scroll offset needed)
  const rect = anchorEl.getBoundingClientRect()
  const gap  = 4
  let top  = rect.bottom + gap
  let left = rect.right - el.offsetWidth
  if (left < 4) left = 4

  el.style.left = `${left}px`
  el.style.top  = `${top}px`

  // Flip up if the menu overflows the bottom of the viewport
  const elRect = el.getBoundingClientRect()
  if (elRect.bottom > window.innerHeight - 8) {
    el.style.top = `${rect.top - el.offsetHeight - gap}px`
  }

  const onKey  = e => { if (e.key === 'Escape') _dismissPopover() }
  const onClick = e => { if (!el.contains(e.target)) _dismissPopover() }
  document.addEventListener('keydown', onKey,  { capture: true })
  document.addEventListener('click',   onClick, { capture: true })
  _popoverCleanup = () => {
    document.removeEventListener('keydown', onKey,  { capture: true })
    document.removeEventListener('click',   onClick, { capture: true })
  }
}

function _dismissPopover() {
  _popoverEl?.remove()
  _popoverEl = null
  _popoverCleanup?.()
  _popoverCleanup = null
}
