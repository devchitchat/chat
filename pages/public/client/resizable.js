/**
 * resizable.js — attach a drag-to-resize handle to a panel edge.
 *
 * Usage:
 *   attachResizeHandle(el, {
 *     edge:    'right' | 'left',   // which edge gets the handle
 *     cssVar:  '--sidebar-width',  // CSS custom property to update on :root
 *     min:     180,                // minimum width in px
 *     max:     600,                // maximum width in px
 *     prefKey: 'sidebar_width',    // settings-sync pref key (omit to skip persistence)
 *   })
 */

import { getPref, setPref } from './settings-sync.js'

export function attachResizeHandle(el, { edge, cssVar, min = 160, max = 700, prefKey } = {}) {
  // Restore persisted width
  if (prefKey) {
    const saved = getPref(prefKey)
    if (saved != null) {
      const px = parseInt(saved, 10)
      if (px >= min && px <= max) {
        document.documentElement.style.setProperty(cssVar, `${px}px`)
      }
    }
  }

  const handle = document.createElement('div')
  handle.className = `resize-handle resize-handle--${edge}`
  handle.setAttribute('aria-hidden', 'true')
  el.appendChild(handle)

  let startX = 0
  let startWidth = 0

  const onMove = e => {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const dx = clientX - startX
    const newWidth = edge === 'right'
      ? Math.max(min, Math.min(max, startWidth + dx))
      : Math.max(min, Math.min(max, startWidth - dx))
    document.documentElement.style.setProperty(cssVar, `${newWidth}px`)
  }

  const onEnd = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup',   onEnd)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend',  onEnd)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''

    if (prefKey) {
      const current = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim()
      setPref(prefKey, parseInt(current, 10))
    }
  }

  const onStart = e => {
    if (e.button != null && e.button !== 0) return
    e.preventDefault()
    startX = e.touches ? e.touches[0].clientX : e.clientX
    startWidth = el.getBoundingClientRect().width
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onEnd)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend',  onEnd)
  }

  handle.addEventListener('mousedown',  onStart)
  handle.addEventListener('touchstart', onStart, { passive: false })
}
