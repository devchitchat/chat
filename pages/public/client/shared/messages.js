/**
 * shared/messages.js — shared message rendering utilities.
 *
 * Used by: islands/chat.js, islands/call.js
 */

export function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function utcDateKey(tsMs) {
  const d = new Date(tsMs)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function formatDateLabel(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d))
  const todayKey = utcDateKey(Date.now())
  const yestKey  = utcDateKey(Date.now() - 86_400_000)
  if (dateKey === todayKey) return 'Today'
  if (dateKey === yestKey)  return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

export function makeDateSeparator(dateKey) {
  const el = document.createElement('div')
  el.className = 'date-separator'
  el.dataset.date = dateKey
  el.innerHTML = `<span class="date-separator-label">${formatDateLabel(dateKey)}</span>`
  return el
}

/**
 * Escape HTML then wrap @handles in <span class="mention"> (or mention-self for current user).
 * @param {string} text
 * @param {{ userHandle?: string }} [opts]
 */
export function renderText(text, { userHandle } = {}) {
  const escaped = escHtml(text)
  return escaped.replace(/@([a-zA-Z0-9_.-]+)/g, (match, handle) => {
    const isSelf = userHandle && handle.toLowerCase() === userHandle.toLowerCase()
    return `<span class="mention${isSelf ? ' mention-self' : ''}">${match}</span>`
  })
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

export function renderAttachment(a) {
  const name = escHtml(a.filename ?? a.original_name ?? 'file')
  const url  = escHtml(a.url)
  const mime = a.mime_type ?? ''
  if (mime.startsWith('image/')) {
    return `<a class="attachment-image-link" href="${url}" target="_blank" rel="noopener noreferrer">
        <img class="attachment-image" src="${url}" alt="${name}" loading="lazy">
      </a>`
  }
  const size = a.size_bytes ? ` (${formatBytes(a.size_bytes)})` : ''
  return `<a class="attachment-file" href="${url}" target="_blank" rel="noopener noreferrer" download>
      <span class="attachment-file-icon">📎</span>
      <span class="attachment-file-name">${name}</span>
      <span class="attachment-file-size">${size}</span>
    </a>`
}

/**
 * Build a <article class="message"> element.
 * @param {{ msg_id, seq, user_id, user_display_name, ts, text, attachments }} msg
 * @param {{ userId?: string, userHandle?: string }} [ctx]  — caller's identity, used for self-styling and @mention highlighting
 */
export function makeMessageEl({ msg_id, seq, user_id, user_display_name, ts, text, attachments }, { userId, userHandle } = {}) {
  const article = document.createElement('article')
  article.className = 'message'
  article.dataset.seq = seq
  article.dataset.msgId = msg_id
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isSelf = userId != null && user_id === userId
  const attachmentHtml = (attachments ?? []).map(a => renderAttachment(a)).join('')
  article.innerHTML = `
      <span class="message-handle${isSelf ? '' : ' dm-trigger'}" data-user-id="${escHtml(user_id)}" title="${isSelf ? '' : 'Send a direct message'}">${escHtml(user_display_name ?? user_id)}</span>
      <time class="message-time" datetime="${ts}">${time}</time>
      ${text ? `<p class="message-text">${renderText(text, { userHandle })}</p>` : ''}
      ${attachmentHtml}
    `
  return article
}
