/**
 * EmojiPickerSingleton.js — one emoji picker shared across the whole app.
 *
 * Both MessageListView and ThreadPanelView use this. The picker is a singleton
 * that floats in document.body and positions itself near the anchor element.
 *
 * Usage:
 *   import { openEmojiPicker, closeEmojiPicker, saveRecentEmoji,
 *            loadRecentEmoji, refreshAllQuickPicks } from './EmojiPickerSingleton.js'
 *
 *   openEmojiPicker(anchorEl, msgId, channelId, onPick)
 *   closeEmojiPicker()
 */

import { CATEGORIES, EMOJI_NAMES } from '../../emoji-data.js'
import { escHtml } from '../../shared/messages.js'

const RECENT_KEY = 'devchitchat_recent_emoji'
const RECENT_MAX = 24
const QUICK_PICKS_COUNT = 4

// ── Persistent state ──────────────────────────────────────────────────────────

let pickerEl  = null
let currentCat = 'smileys'
let currentMsgId   = null
let currentOnPick  = null

// ── Public API ────────────────────────────────────────────────────────────────

export function loadRecentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') } catch { return [] }
}

export function saveRecentEmoji(emoji) {
  let recents = loadRecentEmoji().filter(e => e !== emoji)
  recents.unshift(emoji)
  if (recents.length > RECENT_MAX) recents = recents.slice(0, RECENT_MAX)
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents))
  refreshAllQuickPicks()
}

/** Refresh the quick-pick slots (recent emoji) in every visible message toolbar. */
export function refreshAllQuickPicks() {
  for (const slot of document.querySelectorAll('.message-hover-actions .quick-picks')) {
    renderQuickPicksSlot(slot)
  }
}

/** Render quick-pick buttons into a `.quick-picks` slot. */
export function renderQuickPicksSlot(slot) {
  if (!slot) return
  const recents = loadRecentEmoji().slice(0, QUICK_PICKS_COUNT)
  slot.innerHTML = recents.map(emoji =>
    `<button class="btn-quick-react btn-icon" data-emoji="${escHtml(emoji)}" type="button" title="${escHtml(emoji)}">${emoji}</button>`
  ).join('')
}

/** Open the floating emoji picker anchored to `anchorEl`. */
export function openEmojiPicker(anchorEl, msgId, onPick) {
  // Toggle off if already open for the same message
  if (pickerEl?.parentNode && currentMsgId === msgId) {
    closeEmojiPicker()
    return
  }

  currentMsgId  = msgId
  currentOnPick = onPick

  pickerEl = pickerEl ?? _build()

  if (currentCat === 'recent') _renderGrid(null)

  document.body.appendChild(pickerEl)
  _position(anchorEl)
}

/** Close and detach the picker. */
export function closeEmojiPicker() {
  pickerEl?.parentNode?.removeChild(pickerEl)
  currentMsgId  = null
  currentOnPick = null
}

/** True if the picker is open for the given msgId. */
export function isPickerOpenFor(msgId) {
  return pickerEl?.parentNode != null && currentMsgId === msgId
}

// ── Private ───────────────────────────────────────────────────────────────────

function _build() {
  const el = document.createElement('div')
  el.className = 'emoji-picker'

  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'emoji-picker-search'
  searchInput.placeholder = 'Search emoji…'
  searchInput.setAttribute('aria-label', 'Search emoji')
  el.appendChild(searchInput)

  const tabs = document.createElement('div')
  tabs.className = 'emoji-picker-tabs'
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'emoji-picker-tab' + (cat.id === currentCat ? ' active' : '')
    btn.dataset.catId = cat.id
    btn.textContent = cat.label
    btn.title = cat.id
    tabs.appendChild(btn)
  }
  el.appendChild(tabs)

  const grid = document.createElement('div')
  grid.className = 'emoji-picker-grid'
  el.appendChild(grid)

  tabs.addEventListener('click', e => {
    const btn = e.target.closest('.emoji-picker-tab')
    if (!btn) return
    currentCat = btn.dataset.catId
    tabs.querySelectorAll('.emoji-picker-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.catId === currentCat)
    })
    searchInput.value = ''
    _renderGrid(null)
  })

  searchInput.addEventListener('input', () => {
    _renderGrid(searchInput.value.trim().toLowerCase() || null)
  })

  grid.addEventListener('click', e => {
    const btn = e.target.closest('button[data-emoji]')
    if (!btn) return
    const emoji = btn.dataset.emoji
    saveRecentEmoji(emoji)
    closeEmojiPicker()
    currentOnPick?.(emoji)
  })

  _renderGrid(null)
  return el
}

function _renderGrid(query) {
  if (!pickerEl) return
  const grid = pickerEl.querySelector('.emoji-picker-grid')
  if (!grid) return

  let list
  if (query) {
    const all    = CATEGORIES.flatMap(c => c.emoji)
    const unique = [...new Set(all)]
    list = unique.filter(e => {
      const name = EMOJI_NAMES[e] ?? ''
      return name.includes(query) || e.includes(query)
    })
  } else if (currentCat === 'recent') {
    list = loadRecentEmoji()
  } else {
    const cat = CATEGORIES.find(c => c.id === currentCat)
    list = cat?.emoji ?? []
  }

  grid.innerHTML = list.map(e =>
    `<button type="button" data-emoji="${escHtml(e)}" title="${escHtml(EMOJI_NAMES[e] ?? e)}">${e}</button>`
  ).join('')
}

function _position(anchorEl) {
  pickerEl.style.position = 'fixed'
  pickerEl.style.zIndex   = '400'

  const rect = anchorEl.getBoundingClientRect()
  pickerEl.style.top  = `${rect.bottom + 4}px`
  pickerEl.style.left = `${rect.left}px`

  requestAnimationFrame(() => {
    if (!pickerEl) return
    const pr   = pickerEl.getBoundingClientRect()
    let left   = rect.left
    if (left + pr.width > window.innerWidth - 8)  left = window.innerWidth - 8 - pr.width
    if (left < 8) left = 8
    pickerEl.style.left = `${left}px`
    if (rect.bottom + 4 + pr.height > window.innerHeight - 8) {
      pickerEl.style.top = `${rect.top - 4 - pr.height}px`
    }
  })
}

// ── Global click-outside handler ──────────────────────────────────────────────

document.addEventListener('click', e => {
  if (!pickerEl?.parentNode) return
  if (pickerEl.contains(e.target)) return
  if (e.target.closest('.btn-react') || e.target.closest('.reaction-add')) return
  closeEmojiPicker()
}, { capture: true })
