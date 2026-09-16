/**
 * ThreadToggleView.js — manages the thread panel toggle button.
 *
 * Tracks the last opened thread per channel so the toggle can restore it.
 * Extracted from app.js to keep bootstrap file thin.
 *
 * Owned DOM:
 *   #btn-thread-toggle   — the toggle button
 *   #thread-panel        — observed for .active class changes (not owned)
 */

import * as Ev from '../model/events.js'

export class ThreadToggleView {
  #model
  #btnEl
  #panelEl
  #lastThread = null  // { msgId, channelId } | null

  constructor(model, btnEl, panelEl) {
    this.#model   = model
    this.#btnEl   = btnEl
    this.#panelEl = panelEl
    this.#bindEvents()
  }

  #bindEvents() {
    // Track last opened thread
    document.addEventListener('open-thread', e => {
      this.#lastThread = {
        msgId:     e.detail.msgId,
        channelId: e.detail.channelId ?? this.#model.currentChannelId,
      }
    })

    // Clear on channel navigation
    this.#model.addEventListener(Ev.CHANNEL_SELECTED, () => {
      this.#lastThread = null
    })

    // Toggle button
    this.#btnEl?.addEventListener('click', () => {
      if (this.#panelEl.classList.contains('active')) {
        document.dispatchEvent(new CustomEvent('close-thread'))
      } else if (this.#lastThread && this.#lastThread.channelId === this.#model.currentChannelId) {
        document.dispatchEvent(new CustomEvent('open-thread', { detail: this.#lastThread }))
      } else {
        const channelId = this.#model.currentChannelId
        if (channelId) document.dispatchEvent(new CustomEvent('open-threads-sheet', { detail: { channelId } }))
      }
    })

    // Keep button highlight in sync with panel
    if (this.#panelEl) {
      new MutationObserver(() => {
        this.#btnEl?.classList.toggle('active', this.#panelEl.classList.contains('active'))
      }).observe(this.#panelEl, { attributes: true, attributeFilter: ['class'] })
    }
  }
}
