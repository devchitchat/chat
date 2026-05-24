/**
 * app.js — boots rdbljs islands and page-level setup.
 *
 * Loaded as <script type="module" src="/client/app.js"> from _layout.html.
 * init(window) from rdbljs discovers all [island] elements, imports each
 * module, calls the default export factory with (root, window), and wires
 * up bind(root, scope) so all directives (model=, onclick=, each=, etc.) work.
 */
import { init } from '@devchitchat/rdbljs'
import { getSettings, syncFromServer, patchSettings } from '/client/settings-sync.js'
import { initSwipeNav } from '/client/swipe-nav.js'
import { initRouter } from '/client/router.js'

// On a channel page the intent is always to view the channel — persist the
// current channel and ensure mobile shows the chat panel, not the hub panel.
if (location.pathname.startsWith('/channels/')) {
  const channelId = location.pathname.split('/').pop()
  if (channelId) patchSettings({ last_channel_id: channelId, mobile_chat_open: true })
}

// Apply settings before islands mount (prevent layout flash)
const settings = getSettings()
if (window.matchMedia('(max-width: 1024px)').matches && settings.mobile_chat_open === false) {
  document.body.classList.add('sidebar-open')
}

await init(window)

initRouter()
initSwipeNav()

// Reconcile with server in background after islands mount
syncFromServer().then(remoteSettings => {
  if (!remoteSettings || !window.matchMedia('(max-width: 1024px)').matches) return
  document.body.classList.toggle('sidebar-open', remoteSettings.mobile_chat_open === false)
})
