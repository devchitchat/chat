/**
 * app.js — discovers and mounts rdbljs islands.
 *
 * Loaded as <script type="module" src="/client/app.js"> on the channel page.
 * Finds every element with an [island] attribute, dynamically imports the
 * module at that path, and calls its default export with the element.
 */
import { getSettings, syncFromServer } from '/client/settings-sync.js'

// Apply settings synchronously before islands mount (no layout flash)
const settings = getSettings()
if (window.matchMedia('(max-width: 1024px)').matches && settings.mobile_chat_open === false) {
  document.body.classList.add('sidebar-open')
}

async function mountIslands() {
  const islands = document.querySelectorAll('[island]')
  for (const el of islands) {
    const path = el.getAttribute('island')
    try {
      const mod = await import(path)
      if (typeof mod.default === 'function') {
        mod.default(el)
      }
    } catch (err) {
      console.error(`[island] failed to mount ${path}:`, err)
    }
  }
}

mountIslands()

import('/client/swipe-nav.js').then(m => m.initSwipeNav())

// Reconcile with server in background after islands mount
syncFromServer().then(remoteSettings => {
  if (!remoteSettings || !window.matchMedia('(max-width: 1024px)').matches) return
  document.body.classList.toggle('sidebar-open', remoteSettings.mobile_chat_open === false)
})