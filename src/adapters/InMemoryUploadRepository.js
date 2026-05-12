export class InMemoryUploadRepository {
  constructor() {
    this._uploads = new Map()
  }

  insert({ uploadId, uploaderUserId, channelId, originalName, storedName, mimeType, sizeBytes, now }) {
    this._uploads.set(uploadId, {
      upload_id: uploadId,
      uploader_user_id: uploaderUserId,
      channel_id: channelId,
      original_name: originalName,
      stored_name: storedName,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      created_at: now,
      msg_id: null,
    })
  }

  findById({ uploadId }) {
    return this._uploads.get(uploadId) ?? null
  }

  linkToMessage({ uploadId, msgId }) {
    const row = this._uploads.get(uploadId)
    if (row) row.msg_id = msgId
  }

  findOrphansOlderThan({ thresholdTs }) {
    return [...this._uploads.values()].filter(r => r.msg_id === null && r.created_at < thresholdTs)
  }

  delete({ uploadId }) {
    this._uploads.delete(uploadId)
  }
}
