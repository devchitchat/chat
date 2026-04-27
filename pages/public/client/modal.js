/**
 * modal.js — singleton centered modal for desktop.
 *
 * Dismisses on backdrop click or Escape key.
 */

let backdropEl = null
let modalEl    = null

function ensureDOM() {
  if (backdropEl) return

  backdropEl = document.createElement('div')
  backdropEl.className = 'modal-backdrop'
  backdropEl.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title"></span>
        <button class="modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `
  document.body.appendChild(backdropEl)
  modalEl = backdropEl.querySelector('.modal')

  backdropEl.addEventListener('click', e => {
    if (e.target === backdropEl) dismiss()
  })
  backdropEl.querySelector('.modal-close').addEventListener('click', dismiss)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') dismiss()
  })
}

/**
 * @param {{ title: string, build: (body: HTMLElement) => void }} opts
 */
export function showModal({ title, build }) {
  ensureDOM()
  modalEl.querySelector('.modal-title').textContent = title
  const body = modalEl.querySelector('.modal-body')
  body.innerHTML = ''
  build(body)
  requestAnimationFrame(() => backdropEl.classList.add('open'))
}

export function dismiss() {
  backdropEl?.classList.remove('open')
}
