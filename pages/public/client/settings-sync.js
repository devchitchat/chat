/**
 * settings-sync.js — client-side settings: localStorage + background server sync.
 *
 * This module owns all localStorage reads/writes and server sync. Islands import
 * from here — they never touch localStorage or the API directly.
 *
 * Storage shape: { settings: { last_channel_id, mobile_chat_open }, updated_at: number }
 */

const STORAGE_KEY = 'devchitchat_settings'

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeLocal(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
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
    await fetch('/api/user/settings', {
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
    const res = await fetch('/api/user/settings')
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
