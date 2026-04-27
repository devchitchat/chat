export class SqliteUserSettingsRepository {
  constructor({ db }) {
    this.db = db
  }

  findByUserId({ userId }) {
    return this.db.prepare(
      `SELECT settings_json, updated_at FROM user_settings WHERE user_id = ?`
    ).get(userId) ?? null
  }

  // Upsert only when the incoming updated_at is >= the stored value (last-write-wins)
  upsert({ userId, settingsJson, updatedAt }) {
    this.db.prepare(`
      INSERT INTO user_settings (user_id, settings_json, updated_at)
        VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE
        SET settings_json = excluded.settings_json,
            updated_at    = excluded.updated_at
        WHERE excluded.updated_at >= user_settings.updated_at
    `).run(userId, settingsJson, updatedAt)
  }
}
