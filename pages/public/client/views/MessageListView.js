/**
 * MessageListView.js — renders the main channel message list.
 *
 * Listens to AppModel events and updates the DOM. All user-action events are
 * delegated through MessageInteractions → dispatched to ChatController.
 *
 * Owned DOM:  #messages (the scrollable message list)
 *             #load-more-sentinel (IntersectionObserver trigger)
 *
 * Model events handled:
 *   message-added      → append message
 *   message-updated    → update text + edited marker
 *   message-deleted    → remove article
 *   reactions-updated  → re-render reaction bar
 *   messages-prepended → prepend older messages, adjust scroll
 *   channel-selected   → clear and re-render cached messages for new channel
 *   loading-more-changed → show/hide sentinel
 */

import * as Ev from '../model/events.js'
import {
  makeMessageEl, renderAttachment, escHtml,
  utcDateKey, makeDateSeparator, applyInlineRenderingToTextNodes,
} from '../shared/messages.js'
import { attachMessageInteractions, cancelActiveEdit } from './shared/MessageInteractions.js'
import { renderQuickPicksSlot } from './shared/EmojiPickerSingleton.js'
import { dispatch } from '../controllers/ChatController.js'

export class MessageListView {
  #model
  #el           // #messages container
  #sentinelEl   // #load-more-sentinel
  #observer     // IntersectionObserver
  #channelId    // currently rendered channel

  /**
   * @param {AppModel}   model
   * @param {HTMLElement} messagesEl    — #messages
   * @param {HTMLElement} sentinelEl    — #load-more-sentinel
   */
  constructor(model, messagesEl, sentinelEl) {
    this.#model      = model
    this.#el         = messagesEl
    this.#sentinelEl = sentinelEl
    this.#channelId  = model.currentChannelId

    this.#bindModelEvents()
    this.#setupPagination()
    attachMessageInteractions(messagesEl, { model })
    this.#hydrateExisting()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model event bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    const m = this.#model

    m.addEventListener(Ev.CHANNEL_SELECTED,    e => this.#onChannelSelected(e.detail))
    m.addEventListener(Ev.MESSAGE_ADDED,       e => this.#onMessageAdded(e.detail))
    m.addEventListener(Ev.MESSAGE_UPDATED,     e => this.#onMessageUpdated(e.detail))
    m.addEventListener(Ev.MESSAGE_DELETED,     e => this.#onMessageDeleted(e.detail))
    m.addEventListener(Ev.REACTIONS_UPDATED,   e => this.#onReactionsUpdated(e.detail))
    m.addEventListener(Ev.MESSAGES_PREPENDED,  e => this.#onMessagesPrepended(e.detail))
    m.addEventListener(Ev.LOADING_MORE_CHANGED, e => this.#onLoadingMoreChanged(e.detail))
    m.addEventListener(Ev.MEMBERS_UPDATED,     () => this.#reapplyMentions())
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hydrate seed messages already in the DOM (SSR)
  // ─────────────────────────────────────────────────────────────────────────

  #hydrateExisting() {
    const model  = this.#model
    const userId = model.userId
    let prevDateKey  = null

    for (const article of this.#el.querySelectorAll('article.message')) {
      if (article.dataset.hydrated) continue
      article.dataset.hydrated = '1'

      // DM trigger on non-self handles
      const handle = article.querySelector('.message-handle[data-user-id]')
      if (handle && handle.dataset.userId !== userId) {
        handle.classList.add('dm-trigger')
        handle.title = 'Send a direct message'
      }

      // Hover toolbar if missing
      if (!article.querySelector('.message-hover-actions')) {
        _addHoverToolbar(article, userId)
      }

      // "View N replies" link
      if (!article.querySelector('.thread-replies-link')) {
        const replyCount = parseInt(article.dataset.replyCount ?? '0', 10)
        if (replyCount > 0) _addThreadRepliesLink(article)
      }

      // Inline rendering (@mentions, URLs) on server-rendered text
      const textEl = article.querySelector('.message-text')
      if (textEl) applyInlineRenderingToTextNodes(textEl, { userHandle: model.userHandle, knownHandles: model.knownHandles })

      // Attachments from data-attachments JSON
      const raw = article.dataset.attachments
      if (raw) {
        let attachments
        try { attachments = JSON.parse(raw) } catch { attachments = null }
        if (Array.isArray(attachments) && attachments.length > 0) {
          attachments.forEach(a => article.insertAdjacentHTML('beforeend', renderAttachment(a)))
        }
      }

      // Reaction bar
      const rawReactions = article.dataset.reactions
      if (article.dataset.msgId) {
        let reactions = []
        if (rawReactions) {
          try { reactions = JSON.parse(rawReactions) } catch { reactions = [] }
        }
        renderReactionBar(article, reactions, article.dataset.msgId)
      }

      _enableTaskCheckboxes(article)
      _renderQuickPicks(article)

      // Local-timezone time
      const ts = parseInt(article.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
      if (ts) {
        const timeEl = article.querySelector('.message-time')
        if (timeEl) {
          const localTime = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          const editedSpan = timeEl.querySelector('.message-edited')
          timeEl.textContent = localTime
          if (editedSpan) timeEl.appendChild(editedSpan)
        }
        const dateKey = utcDateKey(ts)
        if (prevDateKey && dateKey !== prevDateKey) {
          article.before(makeDateSeparator(dateKey))
        }
        prevDateKey = dateKey
      }
    }

    // Scroll to bottom on initial load.
    // Double-rAF: first rAF lets the browser compute flex heights; second rAF
    // fires after those dimensions are stable so scrollHeight is accurate.
    // Direct scrollTop assignment bypasses CSS scroll-behavior:smooth.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.#el.scrollTop = this.#el.scrollHeight
      })
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pagination (IntersectionObserver on sentinel)
  // ─────────────────────────────────────────────────────────────────────────

  #setupPagination() {
    if (!this.#sentinelEl) return

    this.#observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return
      if (this.#model.loadingMore) return
      const channelId  = this.#model.currentChannelId
      const beforeSeq  = this.#model.oldestSeqFor(channelId)
      if (beforeSeq <= 1) return
      dispatch('load-more', { channelId, beforeSeq })
    }, { root: this.#el, threshold: 0.1 })

    // Only observe if the server said there are more messages
    if (!this.#sentinelEl.hidden) {
      this.#observer.observe(this.#sentinelEl)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────────────────────────────────

  #onChannelSelected({ channelId }) {
    this.#channelId = channelId
    cancelActiveEdit()

    const msgs = this.#model.messagesFor(channelId)

    if (msgs.length > 0) {
      // Model has cached messages (previously visited channel) — re-render from cache
      this.#el.innerHTML = ''
      const fragment = _buildMessageFragment(msgs, this.#model)
      if (this.#sentinelEl) {
        this.#sentinelEl.after(fragment)
      } else {
        this.#el.appendChild(fragment)
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          this.#el.scrollTop = this.#el.scrollHeight
        })
      })
    } else {
      // No cache — router.js already morphed SSR content into the DOM; hydrate it.
      this.#hydrateExisting()
    }

    // Reset pagination sentinel for the new channel
    const hasMore = this.#model.hasMoreFor(channelId)
    if (this.#sentinelEl) {
      this.#sentinelEl.hidden = !hasMore
      if (hasMore) this.#observer?.observe(this.#sentinelEl)
      else         this.#observer?.unobserve(this.#sentinelEl)
    }
  }

  #onMessageAdded({ channelId, message }) {
    if (channelId !== this.#channelId) return
    if (this.#el.querySelector(`[data-msg-id="${message.msg_id}"]`)) return

    // Date separator if day changed
    const dateKey = utcDateKey(message.ts)
    const lastMsg = this.#el.querySelector('article.message:last-of-type')
    if (lastMsg) {
      const lastTs = parseInt(lastMsg.querySelector('time')?.getAttribute('datetime') ?? '0', 10)
      if (lastTs && utcDateKey(lastTs) !== dateKey) {
        this.#el.appendChild(makeDateSeparator(dateKey))
      }
    }

    const article = makeMessageEl(message, {
      userId:       this.#model.userId,
      userHandle:   this.#model.userHandle,
      knownHandles: this.#model.knownHandles,
    })
    _postProcess(article, message.reactions ?? [], message.msg_id)
    this.#el.appendChild(article)
    this.#el.scrollTop = this.#el.scrollHeight
  }

  #onMessageUpdated({ channelId, message }) {
    if (channelId !== this.#channelId) return
    const article = this.#el.querySelector(`[data-msg-id="${message.msg_id}"]`)
    if (!article) return
    _applyMessageUpdate(article, message)
  }

  #onMessageDeleted({ channelId, msgId }) {
    if (channelId !== this.#channelId) return
    this.#el.querySelector(`[data-msg-id="${msgId}"]`)?.remove()
  }

  #onReactionsUpdated({ msgId, channelId, reactions }) {
    if (channelId !== this.#channelId) return
    const article = this.#el.querySelector(`[data-msg-id="${msgId}"]`)
    if (article) renderReactionBar(article, reactions, msgId)

    // Also update reply-count link if reactions belong to a parent msg
    // (No action needed here — reply-count updates come via model.updateMessage)
  }

  #onMessagesPrepended({ channelId, messages, hasMore }) {
    if (channelId !== this.#channelId) return

    const prevHeight = this.#el.scrollHeight
    const fragment   = _buildMessageFragment(messages, this.#model)

    if (this.#sentinelEl) {
      this.#sentinelEl.after(fragment)
    } else {
      this.#el.prepend(fragment)
    }

    // Maintain scroll position
    this.#el.scrollTop += this.#el.scrollHeight - prevHeight

    // Show/hide sentinel
    if (this.#sentinelEl) {
      this.#sentinelEl.hidden = !hasMore
      if (!hasMore) this.#observer?.unobserve(this.#sentinelEl)
    }
  }

  #onLoadingMoreChanged(_e) {
    // The sentinel visibility is managed in #onMessagesPrepended.
    // Nothing to do here unless we want a loading spinner.
  }

  #reapplyMentions() {
    const { userHandle, knownHandles } = this.#model
    for (const textEl of this.#el.querySelectorAll('.message-text')) {
      applyInlineRenderingToTextNodes(textEl, { userHandle, knownHandles })
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (module-private)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fragment from an array of message objects (already in the model).
 */
function _buildMessageFragment(msgs, model) {
  const fragment   = document.createDocumentFragment()
  let   prevDate   = null

  for (const msg of msgs) {
    const dateKey = utcDateKey(msg.ts)
    if (prevDate && dateKey !== prevDate) {
      fragment.appendChild(makeDateSeparator(dateKey))
    }
    const article = makeMessageEl(msg, {
      userId:       model.userId,
      userHandle:   model.userHandle,
      knownHandles: model.knownHandles,
    })
    _postProcess(article, msg.reactions ?? [], msg.msg_id)
    fragment.appendChild(article)
    prevDate = dateKey
  }

  return fragment
}

function _postProcess(article, reactions, msgId) {
  if (!article.querySelector('.reaction-bar')) {
    const bar = document.createElement('div')
    bar.className = 'reaction-bar'
    article.appendChild(bar)
  }
  _enableTaskCheckboxes(article)
  _renderQuickPicks(article)
  renderReactionBar(article, reactions, msgId)
}

function _enableTaskCheckboxes(article) {
  for (const cb of article.querySelectorAll('.task-list-item-checkbox[disabled]')) {
    cb.removeAttribute('disabled')
  }
}

function _renderQuickPicks(article) {
  renderQuickPicksSlot(article.querySelector('.quick-picks'))
}

function _addHoverToolbar(article, userId) {
  const toolbar = document.createElement('div')
  toolbar.className = 'message-hover-actions'
  const quickPicks = document.createElement('span')
  quickPicks.className = 'quick-picks'
  toolbar.appendChild(quickPicks)

  const replyBtn = document.createElement('button')
  replyBtn.className = 'btn-reply btn-icon'
  replyBtn.type = 'button'
  replyBtn.title = 'Reply in thread'
  replyBtn.setAttribute('aria-label', 'Reply in thread')
  replyBtn.innerHTML = '&#x21A9;'
  toolbar.appendChild(replyBtn)

  const reactBtn = document.createElement('button')
  reactBtn.className = 'btn-react btn-icon'
  reactBtn.type = 'button'
  reactBtn.title = 'Add reaction'
  reactBtn.setAttribute('aria-label', 'Add reaction')
  reactBtn.textContent = '🙂'
  toolbar.appendChild(reactBtn)

  if (article.dataset.userId === userId) {
    const actionsBtn = document.createElement('button')
    actionsBtn.className = 'btn-msg-actions btn-icon'
    actionsBtn.type = 'button'
    actionsBtn.title = 'Message actions'
    actionsBtn.textContent = '…'
    toolbar.appendChild(actionsBtn)
  }

  article.appendChild(toolbar)
  renderQuickPicksSlot(quickPicks)
}

function _addThreadRepliesLink(article) {
  const replyCount = parseInt(article.dataset.replyCount ?? '0', 10)
  if (replyCount <= 0) return
  const msgId = article.dataset.msgId
  const link  = document.createElement('a')
  link.className   = 'thread-replies-link'
  link.href        = '#'
  link.dataset.msgId = msgId
  link.textContent = `View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`
  const reactionBar = article.querySelector('.reaction-bar')
  if (reactionBar) article.insertBefore(link, reactionBar)
  else article.appendChild(link)
}

/**
 * Apply a message update (edit) to an article element.
 */
function _applyMessageUpdate(article, message) {
  if (message.text !== undefined) {
    article.dataset.rawText = message.text
  }
  if (message.rendered_text !== undefined || message.text !== undefined) {
    const textEl = article.querySelector('.message-text')
    if (textEl) {
      const html = message.rendered_text ?? escHtml(message.text ?? '')
      textEl.innerHTML = _sanitize(html)
      _enableTaskCheckboxes(article)
    }
  }
  if (message.edited_at) {
    article.dataset.editedAt = message.edited_at
    const timeEl = article.querySelector('.message-time')
    if (timeEl && !timeEl.querySelector('.message-edited')) {
      const span = document.createElement('span')
      span.className = 'message-edited'
      span.textContent = '(edited)'
      timeEl.appendChild(span)
    }
  }
  if (message.reply_count !== undefined) {
    article.dataset.replyCount = String(message.reply_count)
    _updateReplyCountLink(article, message.reply_count)
  }
}

function _updateReplyCountLink(article, count) {
  let link = article.querySelector('.thread-replies-link')
  if (count > 0) {
    const label = `View ${count} ${count === 1 ? 'reply' : 'replies'}`
    if (!link) {
      link = document.createElement('a')
      link.className   = 'thread-replies-link'
      link.href        = '#'
      link.dataset.msgId = article.dataset.msgId
      const reactionBar = article.querySelector('.reaction-bar')
      if (reactionBar) article.insertBefore(link, reactionBar)
      else article.appendChild(link)
    }
    link.textContent = label
  } else if (link) {
    link.remove()
  }
}

/** Re-render the reaction bar inside an article. */
export function renderReactionBar(article, reactions, msgId) {
  const bar = article.querySelector('.reaction-bar')
  if (!bar) return
  bar.innerHTML = (reactions ?? []).map(r => `
    <button class="reaction-pill${r.reacted ? ' reacted' : ''}"
            data-emoji="${escHtml(r.emoji)}" data-msg-id="${escHtml(msgId)}"
            type="button" title="${r.count} reaction${r.count !== 1 ? 's' : ''}">
      ${r.emoji} <span class="reaction-count">${r.count}</span>
    </button>`).join('')
}

function _sanitize(html) {
  return String(html ?? '').replaceAll('<script>', '').replaceAll('</script>', '')
}
