export class SqliteUploadRepository {
  constructor({ db }) {
    this.db = db
  }

  insert({ uploadId, uploaderUserId, channelId, originalName, storedName, mimeType, sizeBytes, now }) {
    this.db.prepare(
      `INSERT INTO uploads (upload_id, uploader_user_id, channel_id, original_name, stored_name, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uploadId, uploaderUserId, channelId, originalName, storedName, mimeType, sizeBytes, now)
  }

  findById({ uploadId }) {
    return this.db.prepare(
      `SELECT * FROM uploads WHERE upload_id = ?`
    ).get(uploadId) ?? null
  }

  linkToMessage({ uploadId, msgId }) {
    this.db.prepare(
      `UPDATE uploads SET msg_id = ? WHERE upload_id = ?`
    ).run(msgId, uploadId)
  }

  findOrphansOlderThan({ thresholdTs }) {
    return this.db.prepare(
      `SELECT * FROM uploads WHERE msg_id IS NULL AND created_at < ?`
    ).all(thresholdTs)
  }

  delete({ uploadId }) {
    this.db.prepare(`DELETE FROM uploads WHERE upload_id = ?`).run(uploadId)
  }
}
