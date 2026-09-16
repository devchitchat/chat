/**
 * SessionBannerView.js — manages the session banner "ended" state.
 *
 * Listens for 'session:ended' document events and updates the banner DOM.
 * Extracted from app.js to keep bootstrap file thin.
 *
 * Owned DOM:
 *   #session-banner      — the banner element
 *   #btn-end-session     — the end-session button
 */

import * as Ev from '../model/events.js'

export class SessionBannerView {
  #model
  #bannerEl
  #statusEl
  #endBtnEl

  constructor(model) {
    this.#model    = model
    this.#bannerEl = document.getElementById('session-banner')
    this.#statusEl = this.#bannerEl?.querySelector('.session-status')
    this.#endBtnEl = document.getElementById('btn-end-session')
    this.#bindEvents()
  }

  #bindEvents() {
    // When navigating to a different channel, re-acquire DOM refs (SPA swap)
    this.#model.addEventListener(Ev.CHANNEL_SELECTED, () => {
      this.#bannerEl = document.getElementById('session-banner')
      this.#statusEl = this.#bannerEl?.querySelector('.session-status')
      this.#endBtnEl = document.getElementById('btn-end-session')
    })

    document.addEventListener('session:ended', e => {
      if (e.detail.channelId !== this.#model.currentChannelId) return
      if (this.#endBtnEl) this.#endBtnEl.hidden = true
      if (this.#bannerEl) this.#bannerEl.classList.add('session-banner--ended')
      if (this.#statusEl) {
        this.#statusEl.className = 'session-status session-status--ended'
        this.#statusEl.textContent = ' \u00b7 Ended'
      }
    })
  }
}
