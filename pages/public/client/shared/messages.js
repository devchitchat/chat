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
// Combined regex (operates on raw text before HTML-escaping):
//   group 1 (+ inner 2, 3) — markdown link: [text](url)
//   group 4                — bare https?:// URL (excludes []() so it can't swallow a markdown link)
//   group 5                — @mention
const INLINE_RE = /(\[([^\]]*)\]\((https?:\/\/[^)]+)\))|(https?:\/\/[^\s<>"'[\]()]+)|(@[a-zA-Z0-9_.-]+)/g

export function renderText(text, { userHandle } = {}) {
  let result = ''
  let lastIndex = 0
  INLINE_RE.lastIndex = 0
  let m
  while ((m = INLINE_RE.exec(text)) !== null) {
    result += escHtml(text.slice(lastIndex, m.index))
    const [full, , mdText, mdUrl, bareUrl, mention] = m
    if (mdUrl) {
      // [link text](https://url)
      result += `<a href="${escHtml(mdUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(mdText)}</a>`
    } else if (bareUrl) {
      const trimmed = bareUrl.replace(/[.,!?;:)]+$/, '')
      const trailing = bareUrl.slice(trimmed.length)
      result += `<a href="${escHtml(trimmed)}" target="_blank" rel="noopener noreferrer">${escHtml(trimmed)}</a>${escHtml(trailing)}`
    } else if (mention) {
      const handle = mention.slice(1)
      const isSelf = userHandle && handle.toLowerCase() === userHandle.toLowerCase()
      result += `<span class="mention${isSelf ? ' mention-self' : ''}">${escHtml(mention)}</span>`
    }
    lastIndex = m.index + full.length
  }
  result += escHtml(text.slice(lastIndex))
  return result
}

/**
 * Apply inline rendering (URLs, @mentions) to text nodes inside an element,
 * leaving existing HTML structure (e.g. server-rendered <a> tags) intact.
 * Used by hydrateSeedMessages so markdown-rendered links are preserved.
 * @param {Element} el
 * @param {{ userHandle?: string }} [opts]
 */
export function applyInlineRenderingToTextNodes(el, { userHandle } = {}) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes = []
  let n
  while ((n = walker.nextNode())) {
    // Skip text nodes already inside an <a> — they are already linked.
    if (!n.parentElement?.closest('a')) nodes.push(n)
  }
  for (const textNode of nodes) {
    const raw = textNode.textContent
    if (!raw.trim()) continue
    const rendered = renderText(raw, { userHandle })
    if (rendered === escHtml(raw)) continue  // nothing changed
    const span = document.createElement('span')
    span.innerHTML = rendered
    textNode.replaceWith(...span.childNodes)
  }
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
export function makeMessageEl({ msg_id, seq, user_id, user_display_name, ts, text, rendered_text, edited_at, attachments }, { userId, userHandle } = {}) {
  const article = document.createElement('article')
  article.className = 'message'
  article.dataset.seq = seq
  article.dataset.msgId = msg_id
  article.dataset.userId = user_id
  article.dataset.rawText = text ?? ''
  article.dataset.editedAt = edited_at ?? ''
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const isSelf = userId != null && user_id === userId
  const attachmentHtml = (attachments ?? []).map(a => renderAttachment(a)).join('')
  const editedHtml = edited_at ? '<span class="message-edited">(edited)</span>' : ''
  const actionsHtml = isSelf ? '<button class="btn-msg-actions btn-icon" type="button" title="Message actions">…</button>' : ''
  const textHtml = rendered_text ?? (text ? renderText(text, { userHandle }) : '')
  article.innerHTML = `
      <span class="message-handle${isSelf ? '' : ' dm-trigger'}" data-user-id="${escHtml(user_id)}" title="${isSelf ? '' : 'Send a direct message'}">${escHtml(user_display_name ?? user_id)}</span>
      <time class="message-time" datetime="${ts}">${time}${editedHtml}</time>
      ${textHtml ? `<p class="message-text">${textHtml}</p>` : ''}
      ${attachmentHtml}
      ${actionsHtml}
    `
  return article
}
