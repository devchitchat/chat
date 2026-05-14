/**
 * swipe-nav.js — horizontal swipe to switch between sidebar and message panel.
 *
 * Swipe right on the message panel  → sidebar slides in, message panel slides out.
 * Swipe left  on the sidebar        → message panel slides in, sidebar slides out.
 *
 * Direction is locked after LOCK_PX of movement so vertical scrolling inside
 * either panel is never interrupted.
 */

const SWIPE_PX = 50   // minimum horizontal distance to commit a swipe
const LOCK_PX  = 10   // travel before we decide horizontal vs vertical

function attachSwipe(el, { onLeft, onRight }) {
  let startX, startY, dir

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX
    startY = e.touches[0].clientY
    dir = null
    el.style.transition = 'none'
  }, { passive: true })

  el.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - startX
    const dy = e.touches[0].clientY - startY

    // Lock direction once we know which way the user is moving
    if (!dir) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return
      dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
    }

    if (dir !== 'h') return

    // Only follow the finger in the valid direction for this panel
    const valid = (dx > 0 && onRight) || (dx < 0 && onLeft)
    if (!valid) return

    e.preventDefault()
    el.style.transform = `translateX(${dx}px)`
  }, { passive: false })

  el.addEventListener('touchend', e => {
    // Reset inline styles — CSS transition takes over from here
    el.style.transition = ''
    el.style.transform = ''

    if (dir !== 'h') return
    const dx = e.changedTouches[0].clientX - startX
    dir = null

    if (dx >= SWIPE_PX && onRight) onRight()
    else if (dx <= -SWIPE_PX && onLeft) onLeft()
  }, { passive: true })
}

export function initSwipeNav() {
  const mainContent = document.querySelector('.main-content')
  const sidebar     = document.querySelector('.sidebar')
  if (!mainContent || !sidebar) return

  import('/client/settings-sync.js').then(({ patchSettings }) => {
    const showSidebar = () => {
      document.body.classList.add('sidebar-open')
      patchSettings({ mobile_chat_open: false })
    }
    const showMessages = () => {
      document.body.classList.remove('sidebar-open')
      patchSettings({ mobile_chat_open: true })
    }

    // Message panel: swipe right → show sidebar
    attachSwipe(mainContent, { onRight: showSidebar })

    // Sidebar: swipe left → show message panel
    attachSwipe(sidebar, { onLeft: showMessages })
  })
}
