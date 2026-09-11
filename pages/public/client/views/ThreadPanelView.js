/**
 * ThreadPanelView.js — renders the thread panel.
 *
 * Uses the SAME makeMessageEl and MessageInteractions as MessageListView.
 * There is no duplication of click handlers.
 *
 * Owned DOM:
 *   #thread-panel      — the panel wrapper (toggled .active)
 *   #thread-anchor     — parent message clone
 *   #thread-replies    — reply list
 *   #thread-input      — reply textarea
 *   #thread-send       — send button
 *
 * Model events handled:
 *   thread-opened       → show panel, clone parent, clear replies
 *   thread-closed       → hide panel
 *   thread-loaded       → render reply list
 *   thread-reply-added  → append reply
 *   thread-reply-updated → update reply text/reactions
 *   thread-reply-deleted → remove reply
 *   reactions-updated   → re-render reaction bar on reply if open
 *   message-updated     → update anchor clone if it's the parent
 */

import * as Ev from '../model/events.js'
import { makeMessageEl, escHtml, utcDateKey, makeDateSeparator } from '../shared/messages.js'
import { attachMessageInteractions } from './shared/MessageInteractions.js'
import { renderReactionBar } from './MessageListView.js'
import { renderQuickPicksSlot } from './shared/EmojiPickerSingleton.js'
import { dispatch } from '../controllers/ChatController.js'
import { MentionPicker } from './shared/MentionPicker.js'

export class ThreadPanelView {
  #model
  #panelEl
  #anchorEl
  #repliesEl
  #bodyEl
  #inputEl
  #sendBtn
  #mentionPicker

  /**
   * @param {AppModel}   model
   * @param {HTMLElement} panelEl    — #thread-panel
   */
  constructor(model, panelEl) {
    this.#model   = model
    this.#panelEl = panelEl

    this.#anchorEl  = panelEl.querySelector('#thread-anchor')  ?? panelEl.querySelector('.thread-anchor')
    this.#repliesEl = panelEl.querySelector('#thread-replies') ?? panelEl.querySelector('.thread-replies')
    this.#bodyEl    = panelEl.querySelector('.thread-body')
    this.#inputEl   = panelEl.querySelector('#thread-input')
    this.#sendBtn   = panelEl.querySelector('#thread-send')

    this.#bindModelEvents()
    this.#bindPanelEvents()

    // @mention picker for the thread reply input
    const composerEl = panelEl.querySelector('.thread-composer')
    if (this.#inputEl && composerEl) {
      this.#mentionPicker = new MentionPicker(
        this.#inputEl, composerEl, () => [...model.members, ...model.bots],
      )
    }

    // Attach message interactions to the replies container.
    // isThread: true → no nested thread-open buttons.
    if (this.#repliesEl) {
      attachMessageInteractions(this.#repliesEl, { model, isThread: true })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model event bindings
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    const m = this.#model

    m.addEventListener(Ev.THREAD_OPENED,        e => this.#onThreadOpened(e.detail))
    m.addEventListener(Ev.THREAD_CLOSED,        () => this.#onThreadClosed())
    m.addEventListener(Ev.THREAD_LOADED,        e => this.#onThreadLoaded(e.detail))
    m.addEventListener(Ev.THREAD_REPLY_ADDED,   e => this.#onReplyAdded(e.detail))
    m.addEventListener(Ev.THREAD_REPLY_UPDATED, e => this.#onReplyUpdated(e.detail))
    m.addEventListener(Ev.THREAD_REPLY_DELETED, e => this.#onReplyDeleted(e.detail))
    m.addEventListener(Ev.REACTIONS_UPDATED,    e => this.#onReactionsUpdated(e.detail))
    m.addEventListener(Ev.MESSAGE_UPDATED,      e => this.#onParentUpdated(e.detail))
    m.addEventListener(Ev.CHANNEL_SELECTED,     () => this.#onThreadClosed())
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Panel UI event bindings (close button, send button, textarea)
  // ─────────────────────────────────────────────────────────────────────────

  #bindPanelEvents() {
    // Close button(s) — delegation so both header X and mobile footer button work
    this.#panelEl.addEventListener('click', e => {
      if (e.target.closest('.thread-panel-close')) dispatch('close-thread')
    })

    this.#sendBtn?.addEventListener('click', () => this.#sendReply())

    this.#inputEl?.addEventListener('keydown', e => {
      if (this.#mentionPicker?.isOpen) return
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.#sendReply() }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────────────────────────────────

  #onThreadOpened({ parentMsg }) {
    // Clone the parent message into the anchor
    if (this.#anchorEl) {
      this.#anchorEl.innerHTML = ''
      if (parentMsg) {
        const clone = makeMessageEl(parentMsg, {
          userId:       this.#model.userId,
          userHandle:   this.#model.userHandle,
          knownHandles: this.#model.knownHandles,
        })
        // Strip interactive elements from the clone
        clone.querySelector('.message-hover-actions')?.remove()
        clone.querySelector('.thread-replies-link')?.remove()
        this.#anchorEl.appendChild(clone)
      }
    }

    if (this.#repliesEl) {
      this.#repliesEl.innerHTML = '<p class="thread-loading">Loading…</p>'
    }

    this.#panelEl.classList.add('active')
    setTimeout(() => this.#inputEl?.focus(), 50)
  }

  #onThreadClosed() {
    this.#panelEl.classList.remove('active')
    if (this.#anchorEl)  this.#anchorEl.innerHTML  = ''
    if (this.#repliesEl) this.#repliesEl.innerHTML = ''
  }

  #onThreadLoaded({ parentMsgId, replies }) {
    if (parentMsgId !== this.#model.threadParentId) return
    if (!this.#repliesEl) return

    this.#repliesEl.innerHTML = ''

    if (!replies.length) {
      this.#repliesEl.innerHTML = '<p class="thread-empty">No replies yet. Be the first!</p>'
      return
    }

    let prevDate = null
    for (const reply of replies) {
      const dateKey = utcDateKey(reply.ts)
      if (prevDate && dateKey !== prevDate) {
        this.#repliesEl.appendChild(makeDateSeparator(dateKey))
      }
      this.#repliesEl.appendChild(this.#makeReplyEl(reply))
      prevDate = dateKey
    }

    this.#scrollToBottom()
  }

  #onReplyAdded({ parentMsgId, reply }) {
    if (parentMsgId !== this.#model.threadParentId) return
    if (!this.#repliesEl) return

    const emptyEl = this.#repliesEl.querySelector('.thread-empty')
    if (emptyEl) emptyEl.remove()

    this.#repliesEl.appendChild(this.#makeReplyEl(reply))
    this.#scrollToBottom()
  }

  #onReplyUpdated({ reply }) {
    if (!this.#repliesEl) return
    const article = this.#repliesEl.querySelector(`[data-msg-id="${reply.msg_id}"]`)
    if (!article) return
    if (reply.text !== undefined) article.dataset.rawText = reply.text
    if (reply.rendered_text !== undefined || reply.text !== undefined) {
      const textEl = article.querySelector('.message-text')
      if (textEl) textEl.innerHTML = _sanitize(reply.rendered_text ?? escHtml(reply.text ?? ''))
    }
    if (reply.edited_at) {
      article.dataset.editedAt = reply.edited_at
      const timeEl = article.querySelector('.message-time')
      if (timeEl && !timeEl.querySelector('.message-edited')) {
        const span = document.createElement('span')
        span.className = 'message-edited'
        span.textContent = '(edited)'
        timeEl.appendChild(span)
      }
    }
  }

  #onReplyDeleted({ msgId }) {
    if (!this.#repliesEl) return
    this.#repliesEl.querySelector(`[data-msg-id="${msgId}"]`)?.remove()
  }

  #onReactionsUpdated({ msgId, reactions }) {
    if (!this.#repliesEl) return
    const article = this.#repliesEl.querySelector(`[data-msg-id="${msgId}"]`)
    if (article) renderReactionBar(article, reactions, msgId)
  }

  #onParentUpdated({ message }) {
    if (message.msg_id !== this.#model.threadParentId) return
    if (!this.#anchorEl) return
    const textEl = this.#anchorEl.querySelector('.message-text')
    if (textEl && (message.rendered_text !== undefined || message.text !== undefined)) {
      textEl.innerHTML = _sanitize(message.rendered_text ?? escHtml(message.text ?? ''))
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Send reply
  // ─────────────────────────────────────────────────────────────────────────

  #sendReply() {
    const text        = this.#inputEl?.value.trim()
    const parentMsgId = this.#model.threadParentId
    const channelId   = this.#model.currentChannelId
    if (!text || !parentMsgId) return
    dispatch('send-thread-reply', { channelId, parentMsgId, text })
    if (this.#inputEl) this.#inputEl.value = ''
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  #makeReplyEl(reply) {
    const article = makeMessageEl(reply, {
      userId:        this.#model.userId,
      userHandle:    this.#model.userHandle,
      knownHandles:  this.#model.knownHandles,
      isThreadReply: true,
    })
    renderQuickPicksSlot(article.querySelector('.quick-picks'))
    if (reply.reactions?.length) {
      renderReactionBar(article, reply.reactions, reply.msg_id)
    }
    return article
  }

  #scrollToBottom() {
    if (this.#bodyEl) this.#bodyEl.scrollTop = this.#bodyEl.scrollHeight
  }
}

function _sanitize(html) {
  return String(html ?? '').replaceAll('<script>', '').replaceAll('</script>', '')
}
