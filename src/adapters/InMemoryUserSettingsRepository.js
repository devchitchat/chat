export class InMemoryUserSettingsRepository {
  constructor() {
    this._store = new Map() // userId → { settings_json, updated_at }
  }

  findByUserId({ userId }) {
    return this._store.get(userId) ?? null
  }

  upsert({ userId, settingsJson, updatedAt }) {
    const existing = this._store.get(userId)
    if (existing && existing.updated_at > updatedAt) return
    this._store.set(userId, { settings_json: settingsJson, updated_at: updatedAt })
  }
}
