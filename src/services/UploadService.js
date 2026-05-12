import { newId } from '../util/ids.js'
import { randomToken } from '../util/crypto.js'
import { validateMimeType, isForcedDownload } from '../core/uploads.js'
import { ServiceError } from '../util/errors.js'

const DEFAULT_MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 26_214_400) // 25 MB

export class UploadService {
  constructor({ uploadRepo, fileStore, channelService, nowFn = () => Date.now(), maxBytes = DEFAULT_MAX_BYTES }) {
    this.uploadRepo = uploadRepo
    this.fileStore = fileStore
    this.channelService = channelService
    this.nowFn = nowFn
    this.maxBytes = maxBytes
  }

  /**
   * Validate, store, and record an uploaded file.
   *
   * @param {{ userId, channelId, userRoles, filename, stream, sizeBytes, magicBuf }} params
   *   magicBuf  — first ≥16 bytes of the file (already read for MIME detection)
   *   stream    — ReadableStream of the full file (including the bytes in magicBuf)
   * @returns {{ upload_id, url, original_name, mime_type, size_bytes }}
   */
  async upload({ userId, channelId, userRoles, filename, stream, sizeBytes, magicBuf }) {
    if (!this.channelService.isMember(channelId, userId)) {
      throw new ServiceError('FORBIDDEN', 'Not a member of channel')
    }

    if (sizeBytes > this.maxBytes) {
      throw new ServiceError('BAD_REQUEST', `File exceeds maximum size of ${this.maxBytes} bytes`)
    }

    const mimeType = validateMimeType(magicBuf, filename) // throws UNSUPPORTED_TYPE with code

    const uploadId = newId('up')
    const storedName = randomToken(24) // opaque — never derived from filename
    const now = this.nowFn()

    await this.fileStore.write({ uploadId, storedName, stream })

    this.uploadRepo.insert({
      uploadId,
      uploaderUserId: userId,
      channelId,
      originalName: filename,
      storedName,
      mimeType,
      sizeBytes,
      now,
    })

    const url = `/uploads/${uploadId}/${encodeURIComponent(filename)}`
    return { upload_id: uploadId, url, original_name: filename, mime_type: mimeType, size_bytes: sizeBytes }
  }

  /**
   * Link a list of upload_ids to a sent message.
   * Validates that each upload belongs to the channel and was uploaded by this user.
   */
  linkToMessage({ uploadIds, msgId, userId, channelId }) {
    for (const uploadId of uploadIds) {
      const row = this.uploadRepo.findById({ uploadId })
      if (!row) throw new ServiceError('NOT_FOUND', `Upload not found: ${uploadId}`)
      if (row.uploader_user_id !== userId) throw new ServiceError('FORBIDDEN', 'Upload belongs to another user')
      if (row.channel_id !== channelId) throw new ServiceError('FORBIDDEN', 'Upload is not in this channel')
      this.uploadRepo.linkToMessage({ uploadId, msgId })
    }
  }

  getUpload({ uploadId }) {
    return this.uploadRepo.findById({ uploadId })
  }

  /**
   * Validate access and return a stream plus metadata for serving a file.
   */
  async streamFile({ uploadId, requestingUserId, userRoles }) {
    const row = this.uploadRepo.findById({ uploadId })
    if (!row) throw new ServiceError('NOT_FOUND', 'File not found')

    if (!this.channelService.canAccessChannel(row.channel_id, requestingUserId, userRoles)) {
      throw new ServiceError('FORBIDDEN', 'Access denied')
    }

    const stream = await this.fileStore.read({ uploadId, storedName: row.stored_name })
    const contentDisposition = isForcedDownload(row.mime_type)
      ? `attachment; filename="${encodeURIComponent(row.original_name)}"`
      : `inline; filename="${encodeURIComponent(row.original_name)}"`

    return {
      stream,
      mimeType: row.mime_type,
      originalName: row.original_name,
      contentDisposition,
    }
  }

  /**
   * Delete orphan uploads (msg_id IS NULL) older than olderThanMs milliseconds.
   */
  async deleteOrphans({ olderThanMs }) {
    const threshold = this.nowFn() - olderThanMs
    const orphans = this.uploadRepo.findOrphansOlderThan({ thresholdTs: threshold })
    for (const row of orphans) {
      await this.fileStore.delete({ uploadId: row.upload_id, storedName: row.stored_name })
      this.uploadRepo.delete({ uploadId: row.upload_id })
    }
    return orphans.length
  }
}
