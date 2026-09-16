/**
 * swipe-dismiss.js — swipe-down-to-dismiss for bottom sheets.
 *
 * Attach to any bottom sheet element. Dragging down >= DISMISS_PX calls onDismiss.
 * The sheet follows the finger for tactile feedback and springs back if the
 * gesture is too short.
 */

export function attachSheetSwipeDismiss(sheetEl, onDismiss) {
  const DISMISS_PX = 80
  let startY = 0, dy = 0, dragging = false

  sheetEl.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY
    dy = 0
    dragging = true
    sheetEl.style.transition = 'none'
  }, { passive: true })

  sheetEl.addEventListener('touchmove', e => {
    if (!dragging) return
    dy = e.touches[0].clientY - startY
    if (dy <= 0) { sheetEl.style.transform = ''; return }
    sheetEl.style.transform = `translateY(${dy}px)`
  }, { passive: true })

  const finish = () => {
    if (!dragging) return
    dragging = false
    sheetEl.style.transition = ''
    sheetEl.style.transform  = ''
    if (dy >= DISMISS_PX) onDismiss()
    dy = 0
  }
  sheetEl.addEventListener('touchend',    finish, { passive: true })
  sheetEl.addEventListener('touchcancel', finish, { passive: true })
}
