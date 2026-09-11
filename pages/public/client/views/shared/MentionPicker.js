/**
 * MentionPicker.js — reusable @mention autocomplete for any textarea.
 *
 * Usage:
 *   const picker = new MentionPicker(textarea, container, () => model.members)
 *   picker.destroy()   // remove all listeners
 *
 * The picker element is injected as the first child of `container` so CSS can
 * position it relative to the composer/panel element.
 */

import { escHtml } from '../../shared/messages.js'

export class MentionPicker {
  #textarea
  #pickerEl
  #getMembers

  #filtered  = []
  #start     = -1
  #selIdx    = 0

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {HTMLElement}         container  parent element — picker is prepended here
   * @param {() => Array}         getMembers returns current member list
   */
  constructor(textarea, container, getMembers) {
    this.#textarea   = textarea
    this.#getMembers = getMembers

    const el = document.createElement('div')
    el.id = 'mention-picker-' + Math.random().toString(36).slice(2)
    el.className = 'mention-picker'
    el.hidden = true
    container.prepend(el)
    this.#pickerEl = el

    // Mouse click selects without firing the textarea blur
    el.addEventListener('mousedown', e => {
      e.preventDefault()
      const btn = e.target.closest('.mention-option')
      if (!btn) return
      this.#select(this.#filtered[parseInt(btn.dataset.idx, 10)])
    })

    textarea.addEventListener('input',   this.#onInput)
    textarea.addEventListener('keydown', this.#onKeydown)
  }

  /** Returns true if the picker intercepted the keydown event */
  get isOpen() { return !this.#pickerEl.hidden }

  destroy() {
    this.#textarea.removeEventListener('input',   this.#onInput)
    this.#textarea.removeEventListener('keydown', this.#onKeydown)
    this.#pickerEl.remove()
  }

  // ─────────────────────────────────────────────────────────────────────────

  #onInput = () => {
    const ta     = this.#textarea
    const cursor = ta.selectionStart
    const before = ta.value.substring(0, cursor)
    const match  = before.match(/@([a-zA-Z0-9_.-]*)$/)
    if (!match) { this.#close(); return }

    const query    = match[1].toLowerCase()
    const start    = cursor - match[0].length
    const filtered = this.#getMembers()
      .filter(m =>
        m.handle.toLowerCase().startsWith(query) ||
        (m.display_name ?? '').toLowerCase().startsWith(query)
      )
      .slice(0, 8)

    if (filtered.length === 0) { this.#close(); return }

    this.#filtered = filtered
    this.#start    = start
    this.#selIdx   = 0
    this.#render()
  }

  #onKeydown = e => {
    if (this.#pickerEl.hidden) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.#selIdx = Math.min(this.#selIdx + 1, this.#filtered.length - 1)
      this.#render()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      this.#selIdx = Math.max(this.#selIdx - 1, 0)
      this.#render()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      this.#select(this.#filtered[this.#selIdx])
      return
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      this.#close()
    }
  }

  #render() {
    this.#pickerEl.innerHTML = this.#filtered.map((m, i) => `
      <button class="mention-option${i === this.#selIdx ? ' selected' : ''}"
              data-idx="${i}" type="button">
        <span class="mention-option-name">${escHtml(m.display_name || m.handle)}</span>
        <span class="mention-option-handle">@${escHtml(m.handle)}</span>
      </button>`).join('')
    this.#pickerEl.hidden = false
  }

  #select(member) {
    if (!member) return
    const ta     = this.#textarea
    const cursor = ta.selectionStart
    const insert = `@${member.handle} `
    ta.value = ta.value.substring(0, this.#start) + insert + ta.value.substring(cursor)
    const pos = this.#start + insert.length
    ta.setSelectionRange(pos, pos)
    this.#close()
    ta.focus()
  }

  #close() {
    this.#filtered = []
    this.#start    = -1
    this.#pickerEl.hidden = true
  }
}
