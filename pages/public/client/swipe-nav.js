/**
 * swipe-nav.js — horizontal swipe between sidebar, message panel, and thread panel.
 *
 * Three panels, left to right:
 *   Sidebar  ←→  Messages  ←→  Thread (when open)
 *
 * Swipe right on messages   → sidebar (unless thread is open — swipe right closes thread first)
 * Swipe left  on sidebar    → messages
 * Swipe left  on messages   → thread (only when thread panel has .active)
 * Swipe right on thread     → messages
 *
 * Direction is locked after LOCK_PX of movement so vertical scrolling inside
 * any panel is never interrupted.
 */

const SWIPE_PX = 50   // minimum horizontal distance to commit a swipe
const LOCK_PX  = 20   // travel before we decide horizontal vs vertical

function attachSwipe(el, { onLeft, onRight }) {
  let startX, startY, dir
  let suppressSwipe = false

  function onSelectionChange() {
    suppressSwipe = true
  }

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
    dir = null
    suppressSwipe = window.getSelection()?.type === 'Range'
    if (!suppressSwipe) {
      document.addEventListener('selectionchange', onSelectionChange)
    }
    el.style.transition = 'none'
  }, { passive: true })

  el.addEventListener('touchmove', e => {
    if (suppressSwipe) return

    const dx = e.touches[0].clientX - startX
    const dy = e.touches[0].clientY - startY

    if (!dir) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return
      dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    }

    if (dir !== 'h') return

    const valid = (dx > 0 && onRight) || (dx < 0 && onLeft)
    if (!valid) return

    e.preventDefault()
    el.style.transform = `translateX(${dx}px)`
  }, { passive: false })

  el.addEventListener('touchend', e => {
    document.removeEventListener('selectionchange', onSelectionChange)

    el.style.transition = ''
    el.style.transform = ''

    if (suppressSwipe || dir !== 'h') { dir = null; return }
    const dx = e.changedTouches[0].clientX - startX
    dir = null

    if (dx >= SWIPE_PX && onRight) onRight()
    else if (dx <= -SWIPE_PX && onLeft) onLeft()
  }, { passive: true })

  // If the OS interrupts the gesture (notification, call, etc.), reset state cleanly
  el.addEventListener('touchcancel', () => {
    document.removeEventListener('selectionchange', onSelectionChange)
    el.style.transition = ''
    el.style.transform = ''
    dir = null
    suppressSwipe = false
  }, { passive: true })
}

const threadIsOpen = () => document.getElementById('thread-panel')?.classList.contains('active') ?? false

export function initSwipeNav() {
  const mainContent  = document.querySelector('.main-content')
  const sidebar      = document.querySelector('.sidebar')
  const threadPanel  = document.getElementById('thread-panel')
  if (!mainContent || !sidebar) return

  import('./settings-sync.js').then(({ patchSettings }) => {
    const showSidebar = () => {
      document.body.classList.add('sidebar-open')
      patchSettings({ mobile_chat_open: false })
    }
    const showMessages = () => {
      document.body.classList.remove('sidebar-open')
      patchSettings({ mobile_chat_open: true })
    }
    const showThread = () => {
      threadPanel?.classList.add('swipe-open')
    }
    const hideThread = () => {
      threadPanel?.classList.remove('swipe-open')
    }

    // Message panel:
    //   swipe right → sidebar (if thread not open) or close thread
    //   swipe left  → thread panel (if thread .active)
    attachSwipe(mainContent, {
      onRight: () => {
        if (threadIsOpen() && threadPanel?.classList.contains('swipe-open')) {
          hideThread()
        } else {
          showSidebar()
        }
      },
      onLeft: () => {
        if (threadIsOpen()) showThread()
      },
    })

    // Sidebar: swipe left → message panel
    attachSwipe(sidebar, { onLeft: showMessages })

    // Thread panel: swipe right → message panel
    if (threadPanel) {
      attachSwipe(threadPanel, { onRight: hideThread })
    }
  })
}
