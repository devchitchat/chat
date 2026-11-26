/**
 * ChatHeaderView.js — owns the <header class="chat-header"> element.
 *
 * Responsibilities:
 *   - Update channel title and topic on CHANNEL_SELECTED
 *   - Dispatch 'call:start-requested' when the Start Call button is clicked
 *   - Show/hide the Start Call button in response to 'call:state-changed'
 *   - Handle the mobile back button (show sidebar)
 */

import * as Ev from '../model/events.js'
import { dispatch } from '../controllers/ChatController.js'

export class ChatHeaderView {
  #model
  #headerEl
  #titleEl
  #topicEl
  #startCallBtn
  #secretBanner
  #secretToggleBtn

  /**
   * @param {AppModel}    model
   * @param {HTMLElement} headerEl — <header class="chat-header">
   */
  constructor(model, headerEl) {
    this.#model       = model
    this.#headerEl    = headerEl
    this.#titleEl     = headerEl.querySelector('.chat-title')
    this.#topicEl     = headerEl.querySelector('.chat-topic')
    this.#startCallBtn    = headerEl.querySelector('#btn-start-call')
    this.#secretBanner    = document.getElementById('secret-mode-banner')
    this.#secretToggleBtn = headerEl.querySelector('#btn-secret-mode-toggle')

    this.#bindModelEvents()
    this.#bindInteractions()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model events
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    this.#model.addEventListener(Ev.CHANNEL_SELECTED, e => {
      const { name = '', topic = '', kind = 'text', visibility = 'public', session_ends_at } = e.detail.meta ?? {}
      if (this.#titleEl) {
        if (visibility === 'private') {
          this.#titleEl.innerHTML = `<span class="chat-title-lock">&#x1F512;</span> ${name}`
        } else {
          this.#titleEl.textContent = name
        }
      }
      if (this.#topicEl) {
        if (visibility === 'private') {
          this.#topicEl.textContent = topic ? `Private channel · ${topic}` : 'Private channel'
        } else {
          this.#topicEl.textContent = topic
        }
      }

      // Show/hide session banner
      const banner = document.getElementById('session-banner')
      if (banner) {
        banner.hidden = kind !== 'session'
        if (kind === 'session' && session_ends_at) {
          const isEnded = session_ends_at <= Date.now()
          banner.classList.toggle('session-banner--ended', isEnded)
        }
      }

      // Show/hide join banner
      const joinBanner = document.getElementById('join-banner')
      if (joinBanner) {
        const panel = document.querySelector('.chat-panel')
        const isMember = panel?.dataset.isMember !== 'false'
        joinBanner.hidden = isMember || kind === 'dm'
      }

      // Hide Start Call for DMs and sessions
      if (this.#startCallBtn) {
        this.#startCallBtn.hidden = kind === 'dm'
      }

      // Secret mode banner — only relevant for DMs; read from channel meta (seeded from SSR)
      if (kind === 'dm') {
        const { secretMode } = e.detail.meta ?? {}
        this.#updateSecretBanner(!!secretMode)
        if (this.#secretToggleBtn) this.#secretToggleBtn.hidden = false
      } else {
        if (this.#secretBanner)    this.#secretBanner.hidden    = true
        if (this.#secretToggleBtn) this.#secretToggleBtn.hidden = true
      }
    })

    this.#model.addEventListener(Ev.SECRET_MODE_CHANGED, e => {
      if (e.detail.channelId !== this.#model.currentChannelId) return
      this.#updateSecretBanner(e.detail.secretMode)
    })

    // Auto-join: hide the join banner when the server confirms membership
    document.addEventListener('channel:auto-joined', e => {
      if (e.detail?.channelId !== this.#model.currentChannelId) return
      const joinBanner = document.getElementById('join-banner')
      if (joinBanner) joinBanner.hidden = true
      // Update the panel data attribute so subsequent CHANNEL_SELECTED reads correctly
      const panel = document.querySelector('.chat-panel')
      if (panel) panel.dataset.isMember = 'true'
    })

    // When a call starts and user isn't in it, signal the incoming call toast
    document.addEventListener('rtc.call', e => {
      const { channel_id, caller } = e.detail ?? {}
      if (channel_id === this.#model.currentChannelId) return // already on this channel
      document.dispatchEvent(new CustomEvent('rtc:incoming-call', {
        detail: {
          callerName: caller?.display_name ?? caller?.handle ?? 'Someone',
          channelName: channel_id,
          channelId:   channel_id,
        }
      }))
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // User interactions
  // ─────────────────────────────────────────────────────────────────────────

  #bindInteractions() {
    // Mobile: back to sidebar
    this.#headerEl.querySelector('.btn-back-mobile')?.addEventListener('click', () => {
      document.body.classList.add('sidebar-open')
    })

    // Secret mode toggle
    this.#secretToggleBtn?.addEventListener('click', () => {
      const channelId = this.#model.currentChannelId
      if (!channelId) return
      const dm = this.#model.channels.dms?.find(d => d.channel_id === channelId)
      dispatch('set-dm-secret-mode', { channelId, enabled: !dm?.secret_mode })
    })

    // Start Call button → let CallView handle the WebRTC side
    this.#startCallBtn?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('call:start-requested'))
    })

    // CallView signals when a call is entered or left
    document.addEventListener('call:state-changed', e => {
      if (this.#startCallBtn) this.#startCallBtn.hidden = e.detail?.inCall ?? false
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  #updateSecretBanner(isSecret) {
    if (this.#secretBanner) {
      this.#secretBanner.hidden = !isSecret
    }
    if (this.#secretToggleBtn) {
      this.#secretToggleBtn.textContent = isSecret ? 'Turn off secret' : 'Make secret'
      this.#secretToggleBtn.classList.toggle('secret-mode-toggle--active', isSecret)
    }
  }
}
