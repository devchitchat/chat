/**
 * ComposerView.js — the message composer (textarea, attachments, @mention picker).
 *
 * Owned DOM (all within the .composer element or #compose-overlay):
 *   #message-input        — main textarea
 *   .attachment-chips     — injected chip strip
 *   .btn-attach           — injected paperclip button
 *   #compose-overlay      — full-screen compose mode
 *
 * When the user submits, dispatches 'send-message' on document so ChatController
 * picks it up — the view never calls ws.send() directly.
 *
 * Urgent mode and compose-overlay are view-local (no model state needed).
 */

import { escHtml } from '../shared/messages.js'
import { dispatch } from '../controllers/ChatController.js'
import { MentionPicker } from './shared/MentionPicker.js'
import * as Ev from '../model/events.js'

export class ComposerView {
  #model
  #composerEl        // .composer wrapper
  #textareaEl        // #message-input
  #mentionPicker     // MentionPicker for main textarea
  #chipsEl
  #fileInputEl
  #btnAttachEl

  // Compose overlay
  #overlayEl
  #overlayTaEl
  #overlayPreviewEl
  #overlayMentionPicker  // MentionPicker for overlay textarea
  #composeOpen = false
  #composeChipsEl

  // member list — shared closure passed to both MentionPicker instances
  #members = []

  // Attachments
  #pendingAttachments = []

  /**
   * @param {AppModel}   model
   * @param {HTMLElement} composerEl  — the .composer wrapper element
   */
  constructor(model, composerEl) {
    this.#model      = model
    this.#composerEl = composerEl
    this.#textareaEl = composerEl.querySelector('#message-input')

    this.#buildAttachmentChips()
    this.#buildFileInput()
    this.#buildAttachButton()
    this.#buildDropOverlay()
    this.#bindComposerEvents()
    this.#bindOverlay()
    this.#bindGlobalKeys()
    this.#bindModelEvents()

    // Mention picker for the main textarea — injected into the composer element
    if (this.#textareaEl) {
      this.#mentionPicker = new MentionPicker(
        this.#textareaEl,
        this.#composerEl,
        () => this.#members,
      )
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model events
  // ─────────────────────────────────────────────────────────────────────────

  #bindModelEvents() {
    this.#model.addEventListener(Ev.MEMBERS_UPDATED, e => {
      this.#members = [...(e.detail.members ?? []), ...(e.detail.bots ?? [])]
        .filter(m => m.handle)
    })

    this.#model.addEventListener(Ev.CHANNEL_SELECTED, e => {
      // Clear pending state on navigation
      this.#pendingAttachments = []
      this.#renderChips()
      document.dispatchEvent(new CustomEvent('clear-reply'))
      const meta = e.detail?.meta ?? {}
      if (this.#textareaEl) {
        this.#textareaEl.value = ''
        this.#textareaEl.placeholder = `Message in ${meta.name ?? ''}`
      }
      // Enable/disable composer based on session state
      this.#setDisabled(meta.isSessionEnded === true)
    })

    this.#model.addEventListener('reply-changed', e => {
      this.#renderReplyQuote(e.detail.replyTo)
    })

    // Session ended: disable the composer
    document.addEventListener('session:ended', e => {
      if (e.detail.channelId === this.#model.currentChannelId) {
        this.#setDisabled(true)
      }
    })
  }

  #renderReplyQuote(replyTo) {
    const bar = document.getElementById('reply-quote')
    if (!bar) return
    if (!replyTo) {
      bar.hidden = true
      return
    }
    const nameEl = bar.querySelector('#reply-quote-name')
    const textEl = bar.querySelector('#reply-quote-text')
    if (nameEl) nameEl.textContent = replyTo.handle
    if (textEl) textEl.textContent = replyTo.text?.slice(0, 80) ?? ''
    bar.hidden = false
  }

  #setDisabled(disabled) {
    const ta = this.#textareaEl
    if (!ta) return
    ta.disabled = disabled
    ta.placeholder = disabled ? 'This session has ended.' : `Message in ${this.#model.currentChannelMeta?.name ?? ''}`
    this.#composerEl.querySelector('.btn-send')?.toggleAttribute('disabled', disabled)
    this.#composerEl.querySelector('.btn-compose-expand')?.toggleAttribute('disabled', disabled)
    this.#composerEl.classList.toggle('composer--disabled', disabled)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Build injected elements
  // ─────────────────────────────────────────────────────────────────────────

  #buildAttachmentChips() {
    const el = document.createElement('div')
    el.className = 'attachment-chips'
    el.hidden = true
    this.#composerEl.insertBefore(el, this.#textareaEl)
    this.#chipsEl = el

    el.addEventListener('click', e => {
      const btn = e.target.closest('.attachment-chip-remove')
      if (!btn) return
      this.#removeChipAt(parseInt(btn.dataset.index, 10))
    })
  }

  #buildFileInput() {
    const el = document.createElement('input')
    el.type = 'file'
    el.multiple = true
    el.style.display = 'none'
    el.setAttribute('aria-hidden', 'true')
    this.#composerEl.appendChild(el)
    this.#fileInputEl = el
    el.addEventListener('change', () => {
      this.#uploadFiles([...el.files])
      el.value = ''
    })
  }

  #buildAttachButton() {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn-attach btn-icon'
    btn.title = 'Attach file'
    btn.setAttribute('aria-label', 'Attach file')
    btn.innerHTML = '📎'
    const sendBtn = this.#composerEl.querySelector('.btn-send')
    if (sendBtn) this.#composerEl.insertBefore(btn, sendBtn)
    else this.#composerEl.appendChild(btn)
    this.#btnAttachEl = btn
    btn.addEventListener('click', () => this.#fileInputEl.click())
  }

  #buildDropOverlay() {
    let dropOverlayEl = null

    const ensure = () => {
      if (dropOverlayEl) return dropOverlayEl
      dropOverlayEl = document.createElement('div')
      dropOverlayEl.className = 'drop-overlay'
      dropOverlayEl.textContent = 'Drop to attach'
      this.#composerEl.appendChild(dropOverlayEl)
      return dropOverlayEl
    }

    this.#composerEl.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      ensure().hidden = false
    })
    this.#composerEl.addEventListener('dragleave', e => {
      if (this.#composerEl.contains(e.relatedTarget)) return
      if (dropOverlayEl) dropOverlayEl.hidden = true
    })
    this.#composerEl.addEventListener('drop', e => {
      e.preventDefault()
      if (dropOverlayEl) dropOverlayEl.hidden = true
      const files = [...(e.dataTransfer.files ?? [])]
      if (files.length) this.#uploadFiles(files)
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bind composer textarea events
  // ─────────────────────────────────────────────────────────────────────────

  #bindComposerEvents() {
    const ta = this.#textareaEl
    if (!ta) return

    ta.addEventListener('keydown', e => {
      // Let MentionPicker handle its keys first; only handle Enter for send
      if (this.#mentionPicker?.isOpen) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.#submitMain()
      }
    })
    ta.addEventListener('paste', e => this.#handlePaste(e))

    // Send button
    this.#composerEl.querySelector('.btn-send')?.addEventListener('click', () => {
      this.#submitMain()
    })

    // Compose-expand button
    this.#composerEl.querySelector('.btn-compose-expand')?.addEventListener('click', () => {
      this.#composeOpen ? this.#closeOverlay() : this.#openOverlay()
    })

    // Reply quote dismiss
    document.getElementById('reply-quote-dismiss')?.addEventListener('click', () => {
      dispatch('clear-reply')
    })

    // Escape in textarea also clears reply
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.#model.replyTo) {
        e.preventDefault()
        dispatch('clear-reply')
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Compose overlay (Ctrl+E full-screen editor)
  // ─────────────────────────────────────────────────────────────────────────

  #bindOverlay() {
    this.#overlayEl        = document.getElementById('compose-overlay')
    this.#overlayTaEl      = document.getElementById('compose-textarea')
    this.#overlayPreviewEl = document.getElementById('compose-preview')
    this.#composeChipsEl   = document.getElementById('compose-chips')
    const collapseBtn      = document.getElementById('btn-compose-collapse')
    const sendBtn          = document.getElementById('compose-send')
    const attachBtn        = document.getElementById('compose-attach')

    if (!this.#overlayEl) return

    collapseBtn?.addEventListener('click', () => this.#closeOverlay())
    sendBtn?.addEventListener('click', () => { this.#submitMain(); this.#closeOverlay() })
    attachBtn?.addEventListener('click', () => this.#fileInputEl.click())

    this.#overlayTaEl?.addEventListener('keydown', e => {
      if (this.#overlayMentionPicker?.isOpen) return
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        this.#submitMain()
        this.#closeOverlay()
      }
    })

    this.#overlayTaEl?.addEventListener('paste', e => this.#handlePaste(e))

    // Mention picker for the overlay textarea
    if (this.#overlayTaEl) {
      this.#overlayMentionPicker = new MentionPicker(
        this.#overlayTaEl,
        this.#overlayEl,
        () => this.#members,
      )
    }

    // Tab strip in overlay
    this.#overlayEl.querySelectorAll('.compose-tab').forEach(btn => {
      btn.addEventListener('click', () => this.#switchComposeTab(btn.dataset.tab))
    })

    // Chips remove in overlay
    this.#composeChipsEl?.addEventListener('click', e => {
      const btn = e.target.closest('.attachment-chip-remove')
      if (!btn) return
      this.#removeChipAt(parseInt(btn.dataset.index, 10))
    })

    // Drag-drop on overlay
    let composeDropEl = null
    const ensureDropOverlay = () => {
      if (composeDropEl) return composeDropEl
      composeDropEl = document.createElement('div')
      composeDropEl.className = 'drop-overlay'
      composeDropEl.textContent = 'Drop to attach'
      this.#overlayEl.appendChild(composeDropEl)
      return composeDropEl
    }
    this.#overlayEl.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      ensureDropOverlay().hidden = false
    })
    this.#overlayEl.addEventListener('dragleave', e => {
      if (this.#overlayEl.contains(e.relatedTarget)) return
      if (composeDropEl) composeDropEl.hidden = true
    })
    this.#overlayEl.addEventListener('drop', e => {
      e.preventDefault()
      if (composeDropEl) composeDropEl.hidden = true
      const files = [...(e.dataTransfer.files ?? [])]
      if (files.length) this.#uploadFiles(files)
    })
  }

  #bindGlobalKeys() {
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
        e.preventDefault()
        this.#composeOpen ? this.#closeOverlay() : this.#openOverlay()
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Submit / send
  // ─────────────────────────────────────────────────────────────────────────

  #submitMain() {
    const text = (this.#composeOpen
      ? this.#overlayTaEl?.value
      : this.#textareaEl?.value
    )?.trim() ?? ''

    if (!text && this.#pendingAttachments.length === 0) return

    dispatch('send-message', {
      channelId:   this.#model.currentChannelId,
      text,
      attachments: [...this.#pendingAttachments],
      priority:    'normal',
    })

    if (this.#textareaEl) this.#textareaEl.value = ''
    if (this.#overlayTaEl) this.#overlayTaEl.value = ''
    this.#pendingAttachments = []
    this.#renderChips()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Paste images
  // ─────────────────────────────────────────────────────────────────────────

  #handlePaste(e) {
    const items = [...(e.clipboardData?.items ?? [])]
    const imageFiles = items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => {
        const file = item.getAsFile()
        if (!file) return null
        if (!file.name) {
          const ext = item.type.split('/')[1] ?? 'png'
          return new File([file], `paste-${Date.now()}.${ext}`, { type: item.type })
        }
        return file
      })
      .filter(Boolean)
    if (imageFiles.length === 0) return
    e.preventDefault()
    this.#uploadFiles(imageFiles)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File upload
  // ─────────────────────────────────────────────────────────────────────────

  async #uploadFiles(files) {
    for (const file of files) await this.#uploadOne(file)
  }

  async #uploadOne(file) {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('channel_id', this.#model.currentChannelId)

    let res
    try {
      res = await fetch(`${window.__BASE_PATH__ ?? ''}/api/uploads`, {
        method: 'POST',
        body:   formData,
      })
    } catch {
      this.#showError('Upload failed: network error')
      return
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      this.#showError(`Upload failed: ${body.error ?? res.statusText}`)
      return
    }

    const attachment = await res.json()
    this.#pendingAttachments.push(attachment)
    this.#renderChips()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Attachment chips
  // ─────────────────────────────────────────────────────────────────────────

  #renderChips() {
    const html = this.#pendingAttachments.map((a, i) => `
      <span class="attachment-chip" data-index="${i}">
        <span class="attachment-chip-name">${escHtml(a.original_name)}</span>
        <button type="button" class="attachment-chip-remove" data-index="${i}"
                aria-label="Remove ${escHtml(a.original_name)}">×</button>
      </span>`).join('')

    this.#chipsEl.innerHTML = html
    this.#chipsEl.hidden = this.#pendingAttachments.length === 0

    if (this.#composeChipsEl) {
      this.#composeChipsEl.innerHTML = html
      this.#composeChipsEl.hidden = this.#pendingAttachments.length === 0
    }
  }

  #removeChipAt(idx) {
    this.#pendingAttachments.splice(idx, 1)
    this.#renderChips()
  }

  #showError(msg) {
    const target = this.#composeOpen ? this.#composeChipsEl : this.#chipsEl
    if (!target) return
    const chip = document.createElement('span')
    chip.className = 'attachment-chip attachment-chip-error'
    chip.textContent = msg
    target.appendChild(chip)
    target.hidden = false
    setTimeout(() => chip.remove(), 5000)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Compose overlay
  // ─────────────────────────────────────────────────────────────────────────

  #openOverlay() {
    if (this.#composeOpen || !this.#overlayEl) return
    this.#composeOpen = true
    if (this.#overlayTaEl) this.#overlayTaEl.value = this.#textareaEl?.value ?? ''

    const messagesEl = document.getElementById('messages')
    if (messagesEl) messagesEl.hidden = true
    this.#composerEl.hidden = true
    this.#overlayEl.hidden  = false
    this.#switchComposeTab('write')

    requestAnimationFrame(() => {
      if (!this.#overlayTaEl) return
      this.#overlayTaEl.focus()
      const len = this.#overlayTaEl.value.length
      this.#overlayTaEl.setSelectionRange(len, len)
    })
  }

  #closeOverlay() {
    if (!this.#composeOpen || !this.#overlayEl) return
    this.#composeOpen = false

    const messagesEl = document.getElementById('messages')
    if (messagesEl) messagesEl.hidden = false
    this.#composerEl.hidden = false
    this.#overlayEl.hidden  = true
    this.#textareaEl?.focus()
  }

  async #switchComposeTab(tab) {
    if (!this.#overlayEl) return
    this.#overlayEl.querySelectorAll('.compose-tab').forEach(btn => {
      const active = btn.dataset.tab === tab
      btn.classList.toggle('compose-tab--active', active)
      btn.setAttribute('aria-selected', String(active))
    })
    if (this.#overlayTaEl)      this.#overlayTaEl.hidden      = tab !== 'write'
    if (this.#overlayPreviewEl) this.#overlayPreviewEl.hidden = tab !== 'preview'

    if (tab === 'preview') {
      const text = this.#overlayTaEl?.value ?? ''
      if (!text.trim()) {
        if (this.#overlayPreviewEl) {
          this.#overlayPreviewEl.innerHTML = '<p style="color:var(--text-muted)">Nothing to preview yet.</p>'
        }
        return
      }
      let html = null
      await new Promise(resolve => {
        dispatch('preview-text', { text, resolve: h => { html = h; resolve() } })
      })
      if (this.#overlayPreviewEl) {
        this.#overlayPreviewEl.innerHTML = html ? _sanitize(html) : escHtml(text)
      }
    }
  }
}

function _sanitize(html) {
  return String(html ?? '').replaceAll('<script>', '').replaceAll('</script>', '')
}
