/**
 * SessionBannerView.js — manages the session banner "ended" state and avatar hydration.
 *
 * Owned DOM:
 *   #session-banner          — the banner element (replaced by router on navigation)
 *   #session-banner-members  — avatar strip inside the banner
 *   .session-member-count    — "· N members" span
 *   #btn-end-session         — the end-session button (click delegated on document)
 */

import * as Ev from '../model/events.js'
import { applyAvatarToEl } from '../shared/messages.js'
import { showModal, dismiss } from '../modal.js'
import { dispatch } from '../controllers/ChatController.js'

export class SessionBannerView {
  #model
  #bannerEl
  #statusEl

  constructor(model) {
    this.#model    = model
    this.#bannerEl = document.getElementById('session-banner')
    this.#statusEl = this.#bannerEl?.querySelector('.session-status')
    this.#bindEvents()
    this.#hydrateAvatars()
  }

  #bindEvents() {
    // Router replaces #session-banner on navigation — re-acquire refs afterwards
    this.#model.addEventListener(Ev.CHANNEL_SELECTED, () => {
      this.#bannerEl = document.getElementById('session-banner')
      this.#statusEl = this.#bannerEl?.querySelector('.session-status')
      this.#hydrateAvatars()
    })

    this.#model.addEventListener(Ev.PROFILE_UPDATED, e => this.#onProfileUpdated(e.detail))

    // Delegated on document so it survives the router swapping #session-banner
    document.addEventListener('click', e => {
      const btn = e.target.closest('#btn-end-session')
      if (!btn) return
      const channelId = btn.dataset.channelId ?? this.#model.currentChannelId
      if (!channelId) return
      showModal({
        title: 'End session?',
        build(body) {
          body.innerHTML = '<p>Members will no longer be able to send messages.</p>'
          const footer = document.createElement('div')
          footer.className = 'modal-footer'
          const cancelBtn = document.createElement('button')
          cancelBtn.className = 'btn-ghost'
          cancelBtn.textContent = 'Cancel'
          cancelBtn.addEventListener('click', dismiss)
          const confirmBtn = document.createElement('button')
          confirmBtn.className = 'btn-danger'
          confirmBtn.textContent = 'End Session'
          confirmBtn.addEventListener('click', () => {
            dismiss()
            dispatch('session-end', { channelId })
          })
          footer.append(cancelBtn, confirmBtn)
          body.appendChild(footer)
        },
      })
    })

    document.addEventListener('session:ended', e => {
      if (e.detail.channelId !== this.#model.currentChannelId) return
      const endBtn = document.getElementById('btn-end-session')
      if (endBtn) endBtn.hidden = true
      if (this.#bannerEl) this.#bannerEl.classList.add('session-banner--ended')
      if (this.#statusEl) {
        this.#statusEl.className = 'session-status session-status--ended'
        this.#statusEl.textContent = ' \u00b7 Ended'
      }
    })

    document.addEventListener('channel:member_added', e => {
      const { channel_id, user_id, display_name, avatar_initials, avatar_color, avatar_url } = e.detail
      if (channel_id !== this.#model.currentChannelId) return
      if (!this.#bannerEl) return
      const membersEl = this.#bannerEl.querySelector('#session-banner-members')
      if (membersEl) {
        const div = document.createElement('div')
        div.className = 'session-avatar'
        div.dataset.userId = user_id
        div.title = display_name ?? user_id
        if (avatar_url) {
          div.innerHTML = `<img src="${avatar_url}" class="avatar-img" alt="${_escHtml(display_name ?? user_id)}">`
        } else {
          div.style.background = avatar_color ?? 'var(--accent)'
          div.textContent = avatar_initials ?? _initials(display_name ?? user_id)
        }
        membersEl.appendChild(div)
      }
      this.#updateMemberCount(1)
    })

    document.addEventListener('channel:member_removed', e => {
      const { channelId, userId } = e.detail
      if (channelId !== this.#model.currentChannelId) return
      if (!this.#bannerEl) return
      this.#bannerEl.querySelector(`.session-avatar[data-user-id="${CSS.escape(userId)}"]`)?.remove()
      this.#updateMemberCount(-1)
    })
  }

  // Apply saved avatar data to each .session-avatar element in the banner
  #hydrateAvatars() {
    if (!this.#bannerEl) return
    for (const el of this.#bannerEl.querySelectorAll('.session-avatar[data-user-id]')) {
      const userId      = el.dataset.userId
      const displayName = el.title || userId
      const avatarData  = this.#model.getMemberAvatar(userId)
      if (avatarData) applyAvatarToEl(el, avatarData, displayName)
    }
  }

  // Live-update banner avatars when a member changes their profile
  #onProfileUpdated({ userId, avatar_initials, avatar_color, avatar_url, display_name }) {
    if (!this.#bannerEl) return
    const avatarData = { avatar_initials, avatar_color, avatar_url }
    for (const el of this.#bannerEl.querySelectorAll(`.session-avatar[data-user-id="${CSS.escape(userId)}"]`)) {
      applyAvatarToEl(el, avatarData, display_name ?? el.title ?? '')
    }
  }

  #updateMemberCount(delta) {
    if (!this.#bannerEl) return
    const countEl = this.#bannerEl.querySelector('.session-member-count')
    if (!countEl) return
    const current = parseInt(countEl.textContent.replace(/\D/g, ''), 10) || 0
    const next = current + delta
    countEl.textContent = ` \u00b7 ${next} member${next === 1 ? '' : 's'}`
  }
}

function _escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _initials(name) {
  return String(name).split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
}
