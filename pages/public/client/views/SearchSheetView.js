/**
 * SearchSheetView.js — the search bottom sheet / overlay.
 *
 * Handles opening/closing, input, result rendering, and result click navigation.
 * Extracted from app.js to keep bootstrap file thin.
 *
 * Owned DOM:
 *   #search-sheet, #search-backdrop, #search-sheet-input,
 *   #search-results, #search-results-empty, #search-sheet-cancel
 */

import { escHtml } from '../shared/messages.js'
import { attachSheetSwipeDismiss } from '../swipe-dismiss.js'

export class SearchSheetView {
  #model
  #ws
  #sheetEl
  #backdropEl
  #inputEl
  #resultsEl
  #emptyEl
  #cancelEl
  #btnNavSearch
  #searchTimer = null

  /**
   * @param {AppModel}  model
   * @param {WsClient}  ws
   */
  constructor(model, ws) {
    this.#model      = model
    this.#ws         = ws
    this.#sheetEl    = document.getElementById('search-sheet')
    this.#backdropEl = document.getElementById('search-backdrop')
    this.#inputEl    = document.getElementById('search-sheet-input')
    this.#resultsEl  = document.getElementById('search-results')
    this.#emptyEl    = document.getElementById('search-results-empty')
    this.#cancelEl   = document.getElementById('search-sheet-cancel')
    this.#btnNavSearch = document.getElementById('btn-nav-search')

    this.#bindEvents()
  }

  open() {
    if (!this.#sheetEl || !this.#backdropEl) return
    this.#backdropEl.hidden = false
    this.#sheetEl.style.display = 'flex'
    requestAnimationFrame(() => {
      this.#backdropEl.classList.add('visible')
      this.#sheetEl.classList.add('visible')
    })
    this.#btnNavSearch?.classList.add('active')
    setTimeout(() => this.#inputEl?.focus(), 320)
  }

  close() {
    if (!this.#sheetEl || !this.#backdropEl) return
    this.#backdropEl.classList.remove('visible')
    this.#sheetEl.classList.remove('visible')
    this.#btnNavSearch?.classList.remove('active')
    this.#sheetEl.addEventListener('transitionend', () => {
      this.#sheetEl.style.display = ''
      this.#backdropEl.hidden = true
      if (this.#inputEl) this.#inputEl.value = ''
      this.#renderEmpty()
    }, { once: true })
  }

  #bindEvents() {
    // Open triggers
    document.addEventListener('bottomnav:search', () => this.open())
    document.addEventListener('open-search', () => this.open())

    // Close triggers
    this.#cancelEl?.addEventListener('click', () => this.close())
    this.#backdropEl?.addEventListener('click', () => this.close())

    // Mobile swipe dismiss
    if (this.#sheetEl && window.matchMedia('(max-width: 700px)').matches) {
      attachSheetSwipeDismiss(this.#sheetEl, () => this.close())
    }

    // Input handler: client-side channel filter + debounced WS message search
    if (this.#inputEl) {
      this.#inputEl.addEventListener('input', () => {
        const q = this.#inputEl.value.trim()
        clearTimeout(this.#searchTimer)

        if (!q) { this.#renderEmpty(); return }

        // Immediate client-side channel filter
        const allChannels = [
          ...(this.#model.channels.public   ?? []),
          ...(this.#model.channels.private  ?? []),
          ...(this.#model.channels.sessions ?? []),
        ]
        const ql = q.toLowerCase()
        const channelHits = allChannels.filter(c => c.name?.toLowerCase().includes(ql)).slice(0, 5)
        this.#renderResults(channelHits, [])

        // Debounced WS message search (300ms)
        this.#searchTimer = setTimeout(() => {
          this.#ws.send({ t: 'search.global_query', body: { q, limit: 15 } })
        }, 300)
      })
    }

    // WS results arrive via document event (dispatched by WebSocketController)
    document.addEventListener('search:global_result', e => {
      const { q, hits } = e.detail
      if (!this.#inputEl || this.#inputEl.value.trim() !== q) return // stale result

      const allChannels = [
        ...(this.#model.channels.public   ?? []),
        ...(this.#model.channels.private  ?? []),
        ...(this.#model.channels.sessions ?? []),
      ]
      const ql = q.toLowerCase()
      const channelHits = allChannels.filter(c => c.name?.toLowerCase().includes(ql)).slice(0, 5)
      this.#renderResults(channelHits, hits ?? [])
    })
  }

  #renderEmpty() {
    if (!this.#resultsEl) return
    this.#resultsEl.innerHTML = ''
    if (this.#emptyEl) {
      this.#emptyEl.textContent = 'Search channels and messages'
      this.#resultsEl.appendChild(this.#emptyEl)
      this.#emptyEl.hidden = false
    }
  }

  #renderResults(channelHits, messageHits) {
    if (!this.#resultsEl) return
    this.#resultsEl.innerHTML = ''

    if (!channelHits.length && !messageHits.length) {
      if (this.#emptyEl) {
        this.#emptyEl.textContent = 'No results.'
        this.#resultsEl.appendChild(this.#emptyEl)
        this.#emptyEl.hidden = false
      }
      return
    }

    if (this.#emptyEl) this.#emptyEl.hidden = true

    if (channelHits.length) {
      const label = document.createElement('div')
      label.className = 'search-section-label'
      label.textContent = 'Channels'
      this.#resultsEl.appendChild(label)

      for (const ch of channelHits) {
        const a = document.createElement('a')
        a.className = 'search-channel-item'
        a.href = (window.__BASE_PATH__ ?? '') + `/channels/${ch.channel_id}`
        a.innerHTML = `
          <span class="search-item-icon">${_channelIcon(ch)}</span>
          <span class="search-item-body">
            <span class="search-item-title">${escHtml(ch.name)}</span>
          </span>`
        a.addEventListener('click', () => this.close())
        this.#resultsEl.appendChild(a)
      }
    }

    if (messageHits.length) {
      const label = document.createElement('div')
      label.className = 'search-section-label'
      label.textContent = 'Messages'
      this.#resultsEl.appendChild(label)

      for (const h of messageHits) {
        const a = document.createElement('a')
        a.className = 'search-message-item'
        a.href = (window.__BASE_PATH__ ?? '') + `/channels/${h.channel_id}`
        const ts = h.ts ? new Date(h.ts).toLocaleDateString() : ''
        a.innerHTML = `
          <span class="search-item-icon">#</span>
          <span class="search-item-body">
            <span class="search-item-title">${escHtml(h.channel_name ?? '')}</span>
            <span class="search-item-meta">${escHtml(ts)}</span>
            <span class="search-item-snippet">${h.snippet ?? ''}</span>
          </span>`
        a.addEventListener('click', e => {
          e.preventDefault()
          this.close()
          document.dispatchEvent(new CustomEvent('search:message-selected', { detail: h }))
        })
        this.#resultsEl.appendChild(a)
      }
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _channelIcon(ch) {
  if (ch.kind === 'session') return '\ud83d\udccb'
  if (ch.visibility === 'private') return '\ud83d\udd12'
  return '#'
}
