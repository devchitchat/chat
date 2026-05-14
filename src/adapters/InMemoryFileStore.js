/**
 * InMemoryFileStore — test double for IFileStore.
 * Stores file contents as Uint8Array values in a Map keyed by "uploadId/storedName".
 */

import { ServiceError } from '../util/errors'
export class InMemoryFileStore {
  constructor() {
    this._store = new Map()
  }

  #key(uploadId, storedName) {
    return `${uploadId}/${storedName}`
  }

  async write({ uploadId, storedName, stream }) {
    // Accept ReadableStream, Uint8Array, Buffer, or string
    if (stream && typeof stream.getReader === 'function') {
      const chunks = []
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const buf = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) { buf.set(c, offset); offset += c.length }
      this._store.set(this.#key(uploadId, storedName), buf)
    } else {
      const buf = stream instanceof Uint8Array ? stream : new Uint8Array(Buffer.from(stream))
      this._store.set(this.#key(uploadId, storedName), buf)
    }
  }

  async read({ uploadId, storedName }) {
    const buf = this._store.get(this.#key(uploadId, storedName))
    if (!buf) {
      throw new ServiceError('NOT_FOUND', `File not found: ${uploadId}/${storedName}`)
    }
    return new ReadableStream({
      start(controller) {
        controller.enqueue(buf)
        controller.close()
      }
    })
  }

  async delete({ uploadId, storedName }) {
    this._store.delete(this.#key(uploadId, storedName))
  }
}
