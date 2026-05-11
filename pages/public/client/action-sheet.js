/**
 * action-sheet.js — singleton bottom sheet for mobile + iPad.
 *
 * Only one sheet can be open at a time. Dismisses on backdrop tap or swipe-down.
 */

let backdropEl = null
let sheetEl    = null

function ensureDOM() {
  if (backdropEl) return

  backdropEl = document.createElement('div')
  backdropEl.className = 'action-sheet-backdrop'
  backdropEl.innerHTML = `
    <div class="action-sheet" role="dialog" aria-modal="true">
      <div class="action-sheet-handle"></div>
      <div class="action-sheet-label"></div>
      <div class="action-sheet-items"></div>
    </div>
  `
  document.body.appendChild(backdropEl)
  sheetEl = backdropEl.querySelector('.action-sheet')

  // Tap backdrop (outside sheet) to dismiss
  backdropEl.addEventListener('click', e => {
    if (e.target === backdropEl) dismiss()
  })

  // Swipe down to dismiss
  let startY = 0
  sheetEl.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY
  }, { passive: true })
  sheetEl.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - startY > 60) dismiss()
  }, { passive: true })
}

/**
 * @param {{ label?: string, items: Array<{ label: string, action?: () => void, danger?: boolean, disabled?: boolean }> }} opts
 */
export function showActionSheet({ label, items }) {
  ensureDOM()

  backdropEl.querySelector('.action-sheet-label').textContent = label ?? ''
  const container = backdropEl.querySelector('.action-sheet-items')
  container.innerHTML = ''

  for (const item of items) {
    const btn = document.createElement('button')
    btn.className = 'action-sheet-item' + (item.danger ? ' danger' : '')
    btn.textContent = item.label
    btn.disabled = !!item.disabled
    btn.addEventListener('click', () => {
      dismiss()
      item.action?.()
    })
    container.appendChild(btn)
  }

  requestAnimationFrame(() => {
    backdropEl.classList.add('open')
    sheetEl.classList.add('open')
  })
}

export function dismiss() {
  backdropEl?.classList.remove('open')
  sheetEl?.classList.remove('open')
}

/** Returns the .action-sheet-items container, for callers that build forms inline. */
export function getItemsContainer() {
  ensureDOM()
  return backdropEl.querySelector('.action-sheet-items')
}
