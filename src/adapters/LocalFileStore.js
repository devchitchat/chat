import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_UPLOAD_DIR = 'data/uploads'

export class LocalFileStore {
  constructor({ uploadDir = process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR } = {}) {
    this.uploadDir = uploadDir
  }

  #dir(uploadId) {
    return path.join(this.uploadDir, uploadId)
  }

  async write({ uploadId, storedName, stream: data }) {
    const dir = this.#dir(uploadId)
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, storedName)
    await Bun.write(filePath, data)
  }

  async read({ uploadId, storedName }) {
    const filePath = path.join(this.#dir(uploadId), storedName)
    const file = Bun.file(filePath)
    const exists = await file.exists()
    if (!exists) {
      const err = new Error(`File not found: ${filePath}`)
      err.code = 'NOT_FOUND'
      throw err
    }
    return file.stream()
  }

  async delete({ uploadId, storedName }) {
    const filePath = path.join(this.#dir(uploadId), storedName)
    try {
      await Bun.file(filePath).unlink()
    } catch {
      // already gone — ignore
    }
  }
}
