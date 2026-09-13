/**
 * settings-sync.js — all client-side persistence in one place.
 *
 * Two namespaces:
 *   settings  — synced to server (last_channel_id, mobile_chat_open, …)
 *   prefs     — local-only UI preferences (theme, panel widths, devices, …)
 *
 * Callers never touch localStorage directly — they use the exports below.
 *
 * Storage keys:
 *   devchitchat_settings  { settings: {…}, updated_at: number }
 *   devchitchat_prefs     { theme, sidebar_width, thread_panel_width,
 *                           tile_panel_width, tile_layout, devices, … }
 */

const SETTINGS_KEY = 'devchitchat_settings'
const PREFS_KEY    = 'devchitchat_prefs'
const BASE_PATH = window.__BASE_PATH__ ?? ''

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeLocal(data) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
}

// ── Local-only UI preferences ─────────────────────────────────────────────────

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

/**
 * Read a UI preference. Returns `defaultValue` when the key has never been set.
 * @param {string} key
 * @param {*} [defaultValue]
 */
export function getPref(key, defaultValue = null) {
  const prefs = readPrefs()
  return key in prefs ? prefs[key] : defaultValue
}

/**
 * Write one or more UI preferences.
 * @param {string|Record<string,*>} keyOrPatch  — key string or { key: value } map
 * @param {*} [value]                           — value when keyOrPatch is a string
 */
export function setPref(keyOrPatch, value) {
  const prefs = readPrefs()
  const patch  = typeof keyOrPatch === 'string' ? { [keyOrPatch]: value } : keyOrPatch
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, ...patch }))
}

// Returns current settings object (instant, synchronous)
export function getSettings() {
  return readLocal().settings ?? {}
}

// Writes one or more keys, updates local timestamp, queues server sync
export function patchSettings(patch) {
  const local = readLocal()
  const updated_at = Math.floor(Date.now() / 1000)
  const settings = { ...(local.settings ?? {}), ...patch }
  writeLocal({ settings, updated_at })
  syncToServer(settings, updated_at) // fire-and-forget
}

// Push local state to server (fire-and-forget)
async function syncToServer(settings, updated_at) {
  try {
    await fetch(`${BASE_PATH}/api/user/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, updated_at }),
    })
  } catch {
    // Network failure — local state is still correct, server syncs on next load
  }
}

// Pull from server and reconcile. Call once on page load.
// Returns remote settings if the server had newer data, null otherwise.
export async function syncFromServer() {
  try {
    const res = await fetch(`${BASE_PATH}/api/user/settings`)
    if (!res.ok) return null

    const remote = await res.json() // { settings, updated_at }
    const local = readLocal()
    const localUpdatedAt = local.updated_at ?? 0

    if (remote.updated_at > localUpdatedAt) {
      // Server is newer — overwrite local
      writeLocal({ settings: remote.settings, updated_at: remote.updated_at })
      return remote.settings
    } else if (localUpdatedAt > remote.updated_at) {
      // Local is newer — push to server
      syncToServer(local.settings, localUpdatedAt)
    }
    // Equal timestamps — no action needed
  } catch {
    // Network failure — proceed with local state
  }
  return null
}
