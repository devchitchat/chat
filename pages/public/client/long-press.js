/**
 * long-press.js — fires a callback after a pointer is held still for THRESHOLD_MS.
 *
 * Cancels on movement beyond MOVE_TOLERANCE_PX or on pointer-up before threshold.
 * Returns a cleanup function that removes all listeners.
 */

const THRESHOLD_MS     = 500
const MOVE_TOLERANCE_PX = 6

/**
 * @param {Element} el
 * @param {(e: TouchEvent|MouseEvent, el: Element) => void} onLongPress
 * @returns {() => void} cleanup
 */
export function addLongPress(el, onLongPress) {
  let timer  = null
  let startX = 0
  let startY = 0

  function start(e) {
    const pt = e.touches?.[0] ?? e
    startX = pt.clientX
    startY = pt.clientY
    timer = setTimeout(() => {
      timer = null
      onLongPress(e, el)
    }, THRESHOLD_MS)
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null }
  }

  function move(e) {
    const pt = e.touches?.[0] ?? e
    const dx = Math.abs(pt.clientX - startX)
    const dy = Math.abs(pt.clientY - startY)
    if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) cancel()
  }

  el.addEventListener('touchstart',  start,  { passive: true })
  el.addEventListener('touchmove',   move,   { passive: true })
  el.addEventListener('touchend',    cancel)
  el.addEventListener('touchcancel', cancel)
  el.addEventListener('mousedown',   start)
  el.addEventListener('mousemove',   move)
  el.addEventListener('mouseup',     cancel)

  return () => {
    el.removeEventListener('touchstart',  start)
    el.removeEventListener('touchmove',   move)
    el.removeEventListener('touchend',    cancel)
    el.removeEventListener('touchcancel', cancel)
    el.removeEventListener('mousedown',   start)
    el.removeEventListener('mousemove',   move)
    el.removeEventListener('mouseup',     cancel)
  }
}
