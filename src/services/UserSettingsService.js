const ALLOWED_KEYS = new Set(['last_channel_id', 'mobile_chat_open'])

export class UserSettingsService {
  constructor({ userSettingsRepo }) {
    this.userSettingsRepo = userSettingsRepo
  }

  // Returns { settings, updated_at }
  getSettings(userId) {
    const row = this.userSettingsRepo.findByUserId({ userId })
    if (!row) return { settings: {}, updated_at: 0 }
    try {
      return { settings: JSON.parse(row.settings_json), updated_at: row.updated_at }
    } catch {
      return { settings: {}, updated_at: 0 }
    }
  }

  // Merges patch into stored settings. Only allow-listed keys are persisted.
  // updatedAt is a Unix timestamp (seconds); last-write-wins enforced by the repo.
  putSettings(userId, patch, updatedAt) {
    const existing = this.getSettings(userId)
    const merged = { ...existing.settings }
    for (const [k, v] of Object.entries(patch)) {
      if (ALLOWED_KEYS.has(k)) merged[k] = v
    }
    this.userSettingsRepo.upsert({ userId, settingsJson: JSON.stringify(merged), updatedAt })
    return this.getSettings(userId)
  }
}
